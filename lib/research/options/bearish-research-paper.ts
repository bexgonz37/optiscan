import {
  buildRealOptionEntry,
  canOpenRealOptionPaper,
  persistRealOptionPaperOnDb,
  type OptionQuote,
} from "./paper.ts";
import type { BearishAuthorityDecision } from "./bearish-authority.ts";
import type { DeliveryInput } from "./delivery.ts";
import {
  buildOpportunityThesisIdentity,
  opportunityThesisFingerprint,
} from "../../opportunity-case/thesis-identity.ts";

type PaperDb = {
  prepare: (sql: string) => {
    get: (...args: any[]) => any;
    all: (...args: any[]) => any[];
    run: (...args: any[]) => { changes: number; lastInsertRowid?: number | bigint };
  };
};

export interface BearishResearchPaperConfig {
  enabled: boolean;
  startingBalanceUsd: number;
}

export function bearishResearchPaperConfig(
  env: NodeJS.ProcessEnv = process.env,
): BearishResearchPaperConfig {
  const configured = Number(env.PAPER_BEARISH_RESEARCH_STARTING_BALANCE_USD ?? "100000");
  return {
    enabled: env.BEARISH_RESEARCH_PAPER_ENABLED === "1",
    startingBalanceUsd: Number.isFinite(configured) && configured > 0 ? configured : 100_000,
  };
}

export function openBearishResearchPaperOnDb(
  db: PaperDb,
  input: {
    deliveryInput: DeliveryInput;
    authority: BearishAuthorityDecision;
    quality: number;
    opportunityFingerprint?: string | null;
    thesisFingerprint?: string | null;
    opportunityCaseId?: string | null;
    nowMs: number;
  },
  env: NodeJS.ProcessEnv = process.env,
): { opened: boolean; reason: string; optionSymbol: string | null } {
  const cfg = bearishResearchPaperConfig(env);
  if (!cfg.enabled) return { opened: false, reason: "BEARISH_RESEARCH_PAPER_ENABLED!=1", optionSymbol: null };
  if (env.REAL_OPTION_PAPER_ENABLED !== "1") {
    return { opened: false, reason: "REAL_OPTION_PAPER_ENABLED!=1", optionSymbol: null };
  }
  if (input.authority.state !== "BEARISH_READY") {
    return { opened: false, reason: `authority_not_ready:${input.authority.state}`, optionSymbol: null };
  }

  const d = input.deliveryInput;
  const c = d.contract;
  const thesisFingerprint = input.thesisFingerprint
    ?? opportunityThesisFingerprint(buildOpportunityThesisIdentity({
      symbol: d.candidateSymbol,
      side: c.side,
      nowMs: input.nowMs,
      direction: "bearish",
      sessionDate: d.tradingSessionDate ?? null,
    }));
  if (c.side !== "put" || !c.optionSymbol?.startsWith("O:") || !c.optionSymbol.includes("P")) {
    return { opened: false, reason: "exact_put_occ_required", optionSymbol: c.optionSymbol ?? null };
  }
  if (c.quoteAgeMs == null || !Number.isFinite(c.quoteAgeMs) || c.quoteAgeMs < 0) {
    return { opened: false, reason: "quote_freshness_unavailable", optionSymbol: c.optionSymbol };
  }

  const quote: OptionQuote = {
    optionSymbol: c.optionSymbol,
    side: "put",
    strike: c.strike,
    expiration: c.expiration,
    dte: c.dte ?? 0,
    bid: c.bid,
    ask: c.ask,
    volume: c.volume ?? null,
    openInterest: c.openInterest ?? null,
    iv: c.iv ?? null,
    delta: c.delta ?? null,
    quoteAgeMs: c.quoteAgeMs,
    providerTimestamp: c.providerTimestamp ?? null,
  };
  const entry = buildRealOptionEntry({
    quote,
    underlyingPrice: d.underlyingPrice,
    strategy: d.strategy,
    target: d.entry?.t1 ?? null,
    invalidation: d.entry?.stop ?? null,
    provenance: "bearish_research:independent_authority",
  }, env);
  if (!entry.ok) {
    return {
      opened: false,
      reason: `entry_gate:${entry.rejections.join(",") || "rejected"}`,
      optionSymbol: c.optionSymbol,
    };
  }

  const gate = canOpenRealOptionPaper(db, {
    optionSymbol: c.optionSymbol,
    strategy: d.strategy,
    nowMs: input.nowMs,
    paperKind: "BEARISH_RESEARCH_PAPER",
    thesisFingerprint,
  });
  if (!gate.ok) return { opened: false, reason: gate.reason ?? "paper_gate_rejected", optionSymbol: c.optionSymbol };

  try {
    persistRealOptionPaperOnDb(db, entry, input.nowMs, {
      session: d.session ?? null,
      paperKind: "BEARISH_RESEARCH_PAPER",
      entrySource: "bearish_authority_ready",
      thesisFingerprint,
      featureSnapshotJson: JSON.stringify({
        authorityState: input.authority.state,
        authorityReason: input.authority.reasonCode,
        quality: input.quality,
        thesisFingerprint,
        opportunityCaseId: input.opportunityCaseId ?? null,
        source: d.featureSnapshot ?? null,
      }),
    });
  } catch {
    return {
      opened: false,
      reason: "active_paper_position_for_thesis",
      optionSymbol: c.optionSymbol,
    };
  }
  return { opened: true, reason: "opened", optionSymbol: c.optionSymbol };
}

export function buildBearishResearchPaperSnapshot(
  db: PaperDb,
  env: NodeJS.ProcessEnv = process.env,
): {
  account: { identifier: string; label: string; startingBalanceUsd: number; currentEquityUsd: number };
  open: any[];
  recent: any[];
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
} {
  const cfg = bearishResearchPaperConfig(env);
  const rows = db.prepare(
    `SELECT * FROM options_paper_trades
      WHERE paper_kind='BEARISH_RESEARCH_PAPER'
      ORDER BY COALESCE(exit_at_ms, entered_at_ms, created_at_ms) DESC`,
  ).all();
  const open = rows.filter((row) => String(row.status) === "ENTERED");
  const realizedPnlUsd = rows.reduce(
    (sum, row) => sum + (String(row.status) === "EXITED" ? Number(row.pnl ?? 0) : 0),
    0,
  );
  const unrealizedPnlUsd = open.reduce((sum, row) => {
    const entry = Number(row.entry_fill ?? 0);
    const markReturn = Number(row.last_mark_return_pct ?? 0);
    return sum + entry * markReturn;
  }, 0);
  return {
    account: {
      identifier: "bearish_research",
      label: "Bearish Research Paper",
      startingBalanceUsd: cfg.startingBalanceUsd,
      currentEquityUsd: +(cfg.startingBalanceUsd + realizedPnlUsd + unrealizedPnlUsd).toFixed(2),
    },
    open,
    recent: rows.slice(0, 50),
    realizedPnlUsd: +realizedPnlUsd.toFixed(2),
    unrealizedPnlUsd: +unrealizedPnlUsd.toFixed(2),
  };
}

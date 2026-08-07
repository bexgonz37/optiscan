/**
 * The canonical paper mirror for an OWNER PRIVATE validation opening.
 *
 * Every owner Discord opening must leave exactly one paper position on the SAME exact OCC
 * it was alerted on, or the alert produces no forward evidence and the owner lane cannot be
 * measured. On 2026-08-07 three owner CALL openings (QQQ 10/16 $750C, META 08/14 $600C,
 * SPY 08/21 $777C) were delivered with no mirror at all: they existed only as a Discord row
 * and an opportunity case, and appeared in zero paper populations.
 *
 * Side-agnostic by design. The bearish lane already has BEARISH_RESEARCH_PAPER for setups the
 * bearish authority qualified but did not deliver; this is the mirror for what WAS delivered
 * to the owner, on either side, and it carries its own paper_kind so owner performance is
 * never blended with subscriber, research, shadow or experiment populations.
 */
import {
  buildRealOptionEntry,
  canOpenRealOptionPaper,
  persistRealOptionPaperOnDb,
  type OptionQuote,
} from "./paper.ts";
import type { DeliveryInput } from "./delivery.ts";

type PaperDb = {
  prepare: (sql: string) => {
    get: (...args: any[]) => any;
    all: (...args: any[]) => any[];
    run: (...args: any[]) => { changes: number; lastInsertRowid?: number | bigint };
  };
};

export interface OwnerValidationPaperResult {
  opened: boolean;
  reason: string;
  optionSymbol: string | null;
  paperTradeId: number | null;
}

export function ownerValidationPaperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REAL_OPTION_PAPER_ENABLED === "1";
}

/**
 * Mirror a delivered owner opening. Never throws — a mirror failure must not retract an
 * alert that has already been sent, but it is always reported so the gap is visible.
 */
export function openOwnerValidationPaperOnDb(
  db: PaperDb,
  input: {
    deliveryInput: DeliveryInput;
    quality: number;
    nowMs: number;
    opportunityCaseId?: string | null;
    thesisFingerprint?: string | null;
    readinessState?: string | null;
    ownerReason?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): OwnerValidationPaperResult {
  const d = input.deliveryInput;
  const c = d.contract;
  const fail = (reason: string): OwnerValidationPaperResult =>
    ({ opened: false, reason, optionSymbol: c?.optionSymbol ?? null, paperTradeId: null });

  if (!ownerValidationPaperEnabled(env)) return fail("REAL_OPTION_PAPER_ENABLED!=1");
  if (!c?.optionSymbol || !String(c.optionSymbol).startsWith("O:")) return fail("exact_occ_required");
  if (c.quoteAgeMs == null || !Number.isFinite(c.quoteAgeMs) || c.quoteAgeMs < 0) {
    return fail("quote_freshness_unavailable");
  }

  const quote: OptionQuote = {
    optionSymbol: c.optionSymbol,
    side: c.side,
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
    provenance: "owner_validation:private_opening",
  }, env);
  if (!entry.ok) return fail(`entry_gate:${entry.rejections.join(",") || "rejected"}`);

  const gate = canOpenRealOptionPaper(db, {
    optionSymbol: c.optionSymbol,
    strategy: d.strategy,
    nowMs: input.nowMs,
    paperKind: "OWNER_VALIDATION_PAPER",
    thesisFingerprint: input.thesisFingerprint ?? null,
  });
  if (!gate.ok) return fail(gate.reason ?? "paper_gate_rejected");

  try {
    const tradeId = persistRealOptionPaperOnDb(db, entry, input.nowMs, {
      session: d.session ?? null,
      paperKind: "OWNER_VALIDATION_PAPER",
      entrySource: "owner_validation_opening",
      thesisFingerprint: input.thesisFingerprint ?? null,
      featureSnapshotJson: JSON.stringify({
        lane: "OWNER_ONLY",
        readinessState: input.readinessState ?? null,
        ownerReason: input.ownerReason ?? null,
        quality: input.quality,
        opportunityCaseId: input.opportunityCaseId ?? null,
        thesisFingerprint: input.thesisFingerprint ?? null,
        source: d.featureSnapshot ?? null,
      }),
    });
    return {
      opened: tradeId > 0,
      reason: tradeId > 0 ? "opened" : "insert_returned_no_id",
      optionSymbol: c.optionSymbol,
      paperTradeId: tradeId > 0 ? tradeId : null,
    };
  } catch (err: any) {
    return fail(String(err?.message ?? err).slice(0, 120));
  }
}

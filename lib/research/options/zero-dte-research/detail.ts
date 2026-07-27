/**
 * Single-trade dossier for Aggressive 0DTE Research (read-only).
 * Never fabricates quotes — only returns persisted marks / snapshot fields.
 */

import { computeOptionTargets } from "../targets.ts";

export interface DetailDb {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
}

function parseJson(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  try {
    const o = JSON.parse(String(raw));
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseAlts(raw: unknown): unknown[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const o = JSON.parse(String(raw));
    return Array.isArray(o) ? o : [];
  } catch {
    return [];
  }
}

function hasTable(db: DetailDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function occRoot(optionSymbol: unknown): string | null {
  return String(optionSymbol ?? "").match(/^O:([A-Z]+)/)?.[1] ?? null;
}

function whyEntered(row: Record<string, unknown>, feature: Record<string, unknown> | null): string {
  const parts: string[] = [];
  const family = String(row.strategy_family ?? row.strategy ?? "").trim();
  if (family) parts.push(`family=${family}`);
  const side = String(row.side ?? "").trim();
  if (side) parts.push(side);
  const money = String(row.contract_moneyness ?? "").trim();
  if (money) parts.push(money);
  const bucket = String(row.time_bucket ?? "").trim();
  if (bucket) parts.push(`bucket=${bucket}`);
  const q = feature?.qualityScore ?? feature?.quality_score;
  if (q != null && Number.isFinite(Number(q))) parts.push(`quality=${Number(q)}`);
  const regime = String(row.market_regime ?? "").trim();
  if (regime) parts.push(`regime=${regime}`);
  if (!parts.length) return "ZERO_DTE_RESEARCH_PAPER entry (no feature evidence)";
  return `Research entry: ${parts.join(" · ")}`;
}

function whyExited(row: Record<string, unknown>): string | null {
  if (String(row.status) !== "EXITED") return null;
  const reason = String(row.exit_reason ?? "").trim();
  if (reason) return reason;
  return "EXITED (no exit_reason recorded)";
}

function resolveLevels(row: Record<string, unknown>, feature: Record<string, unknown> | null): {
  entry: number | null;
  stop: number | null;
  t1: number | null;
  t2: number | null;
} {
  const entry = row.entry_fill != null && Number.isFinite(Number(row.entry_fill)) ? Number(row.entry_fill) : null;
  const stop =
    row.invalidation != null && Number.isFinite(Number(row.invalidation))
      ? Number(row.invalidation)
      : feature?.stop != null && Number.isFinite(Number(feature.stop))
        ? Number(feature.stop)
        : null;
  const t1 =
    row.target != null && Number.isFinite(Number(row.target))
      ? Number(row.target)
      : feature?.t1 != null && Number.isFinite(Number(feature.t1))
        ? Number(feature.t1)
        : null;
  let t2: number | null =
    feature?.t2 != null && Number.isFinite(Number(feature.t2))
      ? Number(feature.t2)
      : feature?.target_t2 != null && Number.isFinite(Number(feature.target_t2))
        ? Number(feature.target_t2)
        : null;
  // Derive T2 from stored mid + strategy when snapshot omitted it (no live quotes).
  if (t2 == null && entry != null) {
    try {
      const mid = row.mid != null && Number.isFinite(Number(row.mid)) ? Number(row.mid) : entry;
      const strategy = String(row.strategy_family ?? row.strategy ?? "trend_continuation");
      t2 = computeOptionTargets(mid, strategy).t2;
    } catch {
      t2 = null;
    }
  }
  return { entry, stop, t1, t2 };
}

export function buildZeroDteTradeDetail(db: DetailDb, id: number): {
  ok: boolean;
  error?: string;
  trade?: Record<string, unknown>;
} {
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: "invalid_id" };
  const row = db.prepare(
    `SELECT * FROM options_paper_trades WHERE id=? AND paper_kind='ZERO_DTE_RESEARCH_PAPER'`,
  ).get(id) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, error: "not_found" };

  const feature = parseJson(row.feature_snapshot_json);
  const levels = resolveLevels(row, feature);
  const alts = parseAlts(row.contract_alts_json);

  let marks: Record<string, unknown>[] = [];
  if (hasTable(db, "options_paper_marks")) {
    try {
      marks = (db.prepare(
        `SELECT mark_at_ms, bid, ask, exit_fill, return_pct, quote_age_ms, option_symbol
           FROM options_paper_marks WHERE trade_id=? ORDER BY mark_at_ms DESC LIMIT 40`,
      ).all(id) as Record<string, unknown>[]).map((m) => ({
        markAtMs: m.mark_at_ms,
        bid: m.bid,
        ask: m.ask,
        exitFill: m.exit_fill,
        returnPct: m.return_pct,
        quoteAgeMs: m.quote_age_ms,
        optionSymbol: m.option_symbol,
      }));
    } catch {
      marks = [];
    }
  }

  const entryTrigger =
    (feature?.entryTrigger != null ? String(feature.entryTrigger) : null) ??
    (feature?.entry_trigger != null ? String(feature.entry_trigger) : null) ??
    (feature?.trigger != null ? String(feature.trigger) : null) ??
    String(row.strategy_family ?? row.strategy ?? "zero_dte_research");

  return {
    ok: true,
    trade: {
      id: row.id,
      label: "Aggressive 0DTE Research — simulated only",
      status: row.status,
      symbol: occRoot(row.option_symbol),
      optionSymbol: row.option_symbol,
      side: row.side,
      strike: row.strike,
      expiration: row.expiration,
      dte: row.dte,
      family: row.strategy_family ?? row.strategy,
      exitPolicy: row.exit_policy_version,
      moneyness: row.contract_moneyness,
      deltaBand: row.delta_band,
      timeBucket: row.time_bucket,
      marketRegime: row.market_regime,
      fingerprint: row.fingerprint,
      accountRiskUsd: row.account_risk_usd,
      entry: levels.entry,
      stop: levels.stop,
      t1: levels.t1,
      t2: levels.t2,
      target: row.target,
      invalidation: row.invalidation,
      mid: row.mid,
      bid: row.bid,
      ask: row.ask,
      spreadPct: row.spread_pct,
      delta: row.delta,
      iv: row.iv,
      underlyingPrice: row.underlying_price,
      mfePct: row.mfe_pct,
      maePct: row.mae_pct,
      lastMarkReturnPct: row.last_mark_return_pct,
      exitFill: row.exit_fill,
      pnl: row.pnl,
      returnPct: row.return_pct,
      exitReason: row.exit_reason,
      enteredAtMs: row.entered_at_ms,
      exitAtMs: row.exit_at_ms,
      entryTrigger,
      setupEvidence: feature,
      contractAlts: alts,
      marks,
      whyEntered: whyEntered(row, feature),
      whyExited: whyExited(row),
      provenance: row.provenance,
      paperKind: row.paper_kind,
    },
  };
}

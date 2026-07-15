/**
 * options-diagnostics.ts — bounded persistent diagnostics for the OPTIONS callout
 * funnel. One row per authoritative supervisor cycle (never per tick), so a day with
 * "very few / no actionable options Discord alerts" is diagnosable AFTER the fact —
 * the supervisor's in-memory telemetry is cleared on every restart.
 *
 * It answers, from stored data:
 *   • How many underlying setups qualified?           → tickersWithCanonical
 *   • How many chains were fetched?                   → chainsOk + chainsFailed
 *   • How many contracts reached callout stage?       → canonical
 *   • At which gate were candidates rejected?         → the *Suppressed / *Incomplete counts
 *   • What was the most common rejection reason?      → topReason (summary)
 *   • Did any become ACTIONABLE but fail delivery?    → emittedButUndelivered + deliveryGateReason
 *
 * The single most important field is `deliveryGateReason`: when callouts were emitted
 * but nothing was delivered because the Discord config gate is off
 * (CALLOUT_CANONICAL_PATH / AGENT_CALLOUT_DISCORD / webhook), that is recorded here so
 * the "no alerts" cause is unambiguous. PURE `summarizeOptionsDiagnostics` feeds the
 * nightly AI (the AI never sees raw cycles and never affects a live decision).
 */
import { tradingDay } from "./trading-session.ts";

// Lazy DB (not a static `@/lib/db` import) so this module — and the DB-free AI layer
// that imports it — loads under the bare test runner where `@/` is unavailable.
type DbLike = { prepare: (sql: string) => any };
function lazyDb(): DbLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/db").getDb();
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const int = (v: unknown): number => (isNum(v) ? Math.round(v) : 0);

export interface OptionsDiagnosticInput {
  cycleAtMs: number;
  session: string | null;
  tickersConsidered: number;
  chainsOk: number;
  chainsFailed: number;
  tickersWithCanonical: number;
  canonical: number;
  portfolioSuppressed: number;
  dedupSuppressed: number;
  emitted: number;
  delivered: number;
  notActionableNow: number;
  contractIncomplete: number;
  contractMismatch: number;
  discordAutoSend: boolean;
  /** Non-null when emitted>0 but delivered==0 due to config (the key "no alerts" cause). */
  deliveryGateReason?: string | null;
  topReason?: string | null;
  durationMs?: number | null;
  strategyVersion?: string | null;
}

export interface OptionsDiagnosticRow extends Omit<OptionsDiagnosticInput, "discordAutoSend"> {
  id: number;
  tradingDay: string;
  discordAutoSend: boolean;
  createdAtMs: number;
}

const RETENTION_DAYS = () => Number(process.env.OPTIONS_DIAGNOSTIC_RETENTION_DAYS ?? 14);

export function recordOptionsDiagnostic(input: OptionsDiagnosticInput): void {
  try {
    const db = lazyDb();
    const createdAtMs = Date.now();
    db.prepare(
      `INSERT INTO options_diagnostics
       (cycle_at_ms, trading_day, session, tickers_considered, chains_ok, chains_failed,
        tickers_with_canonical, canonical, portfolio_suppressed, dedup_suppressed,
        emitted, delivered, not_actionable_now, contract_incomplete, contract_mismatch,
        discord_auto_send, delivery_gate_reason, top_reason, duration_ms, strategy_version, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.cycleAtMs,
      tradingDay(input.cycleAtMs),
      input.session ?? null,
      int(input.tickersConsidered),
      int(input.chainsOk),
      int(input.chainsFailed),
      int(input.tickersWithCanonical),
      int(input.canonical),
      int(input.portfolioSuppressed),
      int(input.dedupSuppressed),
      int(input.emitted),
      int(input.delivered),
      int(input.notActionableNow),
      int(input.contractIncomplete),
      int(input.contractMismatch),
      input.discordAutoSend ? 1 : 0,
      input.deliveryGateReason ?? null,
      input.topReason ?? null,
      isNum(input.durationMs) ? Math.round(input.durationMs) : null,
      input.strategyVersion ?? null,
      createdAtMs,
    );
    const retentionDays = RETENTION_DAYS();
    if (Number.isFinite(retentionDays) && retentionDays > 0) {
      db.prepare("DELETE FROM options_diagnostics WHERE created_at_ms < ?").run(createdAtMs - retentionDays * 24 * 60 * 60_000);
    }
  } catch {
    // Diagnostics must never break the supervisor cycle.
  }
}

function mapRow(r: any): OptionsDiagnosticRow {
  return {
    id: r.id,
    cycleAtMs: r.cycle_at_ms,
    tradingDay: r.trading_day,
    session: r.session,
    tickersConsidered: r.tickers_considered,
    chainsOk: r.chains_ok,
    chainsFailed: r.chains_failed,
    tickersWithCanonical: r.tickers_with_canonical,
    canonical: r.canonical,
    portfolioSuppressed: r.portfolio_suppressed,
    dedupSuppressed: r.dedup_suppressed,
    emitted: r.emitted,
    delivered: r.delivered,
    notActionableNow: r.not_actionable_now,
    contractIncomplete: r.contract_incomplete,
    contractMismatch: r.contract_mismatch,
    discordAutoSend: Boolean(r.discord_auto_send),
    deliveryGateReason: r.delivery_gate_reason,
    topReason: r.top_reason,
    durationMs: r.duration_ms,
    strategyVersion: r.strategy_version,
    createdAtMs: r.created_at_ms,
  };
}

export function listOptionsDiagnostics(limit = 500): OptionsDiagnosticRow[] {
  try {
    const db = lazyDb();
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_diagnostics'").get();
    if (!has) return [];
    return (db.prepare("SELECT * FROM options_diagnostics ORDER BY cycle_at_ms DESC, id DESC LIMIT ?").all(limit) as any[]).map(mapRow);
  } catch {
    return [];
  }
}

/** Day-filtered read for the nightly AI (bounded; empty when the table is absent). */
export function optionsDiagnosticsForDay(day: string, db: DbLike = lazyDb(), limit = 5000): OptionsDiagnosticRow[] {
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_diagnostics'").get();
    if (!has) return [];
    const rows = db.prepare(
      "SELECT * FROM options_diagnostics WHERE trading_day = ? ORDER BY cycle_at_ms ASC LIMIT ?",
    ).all(day, limit) as any[];
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

export interface OptionsDiagnosticSummary {
  cycles: number;
  tickersConsidered: number;
  chainsFetched: number;
  chainsFailed: number;
  setupsQualified: number;      // tickers that produced ≥1 canonical callout
  canonical: number;
  emitted: number;
  delivered: number;
  /** Emitted callouts that were never delivered (the actionable-but-silent count). */
  emittedButUndelivered: number;
  /** Cycles where emitted>0, delivered==0, and Discord auto-send was OFF (config-blocked). */
  configBlockedCycles: number;
  gateRejections: {
    agentStageNoCanonical: number;   // tickers with a chain but no canonical callout
    portfolioSuppressed: number;
    dedupSuppressed: number;
    notActionableNow: number;
    contractIncomplete: number;
    contractMismatch: number;
  };
  /** The most frequent delivery-gate reason across config-blocked cycles (or null). */
  topDeliveryGateReason: string | null;
  /** Highest-level deterministic diagnosis of why options alerts were scarce. */
  diagnosis: string | null;
}

/** PURE deterministic summary of the options funnel for the nightly AI job. */
export function summarizeOptionsDiagnostics(rows: OptionsDiagnosticRow[]): OptionsDiagnosticSummary {
  let tickersConsidered = 0, chainsFetched = 0, chainsFailed = 0, setupsQualified = 0;
  let canonical = 0, emitted = 0, delivered = 0, configBlockedCycles = 0;
  let agentStageNoCanonical = 0, portfolioSuppressed = 0, dedupSuppressed = 0;
  let notActionableNow = 0, contractIncomplete = 0, contractMismatch = 0;
  const gateReasons: Record<string, number> = {};

  for (const r of rows) {
    tickersConsidered += int(r.tickersConsidered);
    chainsFetched += int(r.chainsOk) + int(r.chainsFailed);
    chainsFailed += int(r.chainsFailed);
    setupsQualified += int(r.tickersWithCanonical);
    canonical += int(r.canonical);
    emitted += int(r.emitted);
    delivered += int(r.delivered);
    // Tickers that had a chain fetched but produced no canonical callout (deep
    // agent/selector/entry-window rejection) — chainsOk minus the ones with a callout.
    agentStageNoCanonical += Math.max(0, int(r.chainsOk) - int(r.tickersWithCanonical));
    portfolioSuppressed += int(r.portfolioSuppressed);
    dedupSuppressed += int(r.dedupSuppressed);
    notActionableNow += int(r.notActionableNow);
    contractIncomplete += int(r.contractIncomplete);
    contractMismatch += int(r.contractMismatch);
    if (int(r.emitted) > 0 && int(r.delivered) === 0 && !r.discordAutoSend) {
      configBlockedCycles += 1;
      const reason = r.deliveryGateReason || "supervisor Discord delivery disabled by config";
      gateReasons[reason] = (gateReasons[reason] ?? 0) + 1;
    }
  }

  const emittedButUndelivered = Math.max(0, emitted - delivered);
  const topDeliveryGateReason = Object.entries(gateReasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  let diagnosis: string | null = null;
  if (rows.length === 0) {
    diagnosis = null;
  } else if (emitted > 0 && delivered === 0 && configBlockedCycles > 0) {
    diagnosis = `${emitted} options callout(s) became emittable but NONE were delivered — Discord delivery is disabled by config (${topDeliveryGateReason}).`;
  } else if (canonical === 0 && setupsQualified === 0) {
    diagnosis = "No underlying produced a canonical options callout — candidates died at the agent/selector/entry-window stage (chain, spread, liquidity, delta, DTE, freshness, or not-actionable-now).";
  } else if (emitted === 0 && canonical > 0) {
    diagnosis = `${canonical} canonical callout(s) but 0 emitted — suppressed by portfolio ranking (${portfolioSuppressed}) / dedup (${dedupSuppressed}).`;
  } else if (delivered === 0 && emittedButUndelivered > 0) {
    diagnosis = `${emittedButUndelivered} emitted callout(s) not delivered at the delivery boundary (not-actionable-now ${notActionableNow}, contract-incomplete ${contractIncomplete}, contract-mismatch ${contractMismatch}).`;
  }

  return {
    cycles: rows.length,
    tickersConsidered,
    chainsFetched,
    chainsFailed,
    setupsQualified,
    canonical,
    emitted,
    delivered,
    emittedButUndelivered,
    configBlockedCycles,
    gateRejections: {
      agentStageNoCanonical,
      portfolioSuppressed,
      dedupSuppressed,
      notActionableNow,
      contractIncomplete,
      contractMismatch,
    },
    topDeliveryGateReason,
    diagnosis,
  };
}

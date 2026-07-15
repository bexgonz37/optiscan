/**
 * Bounded persistent diagnostics for the stock momentum callout path. These are
 * decision records, not tick storage: sent, rescued, rejected, and throttled
 * near-misses only.
 */

import { tradingDay } from "./trading-session.ts";

// Lazy DB resolution (not a static `@/lib/db` import) so this module — and anything
// that imports it, including the DB-free AI layer — loads under the bare test runner
// where the `@/` alias is unavailable. Impure fns default to the real DB; callers
// (e.g. the nightly job / tests) may inject a handle.
type DbLike = { prepare: (sql: string) => any };
function lazyDb(): DbLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/db").getDb();
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nullableNum = (v: unknown) => (isNum(v) ? v : null);

export type MomentumDiagnosticDecision = "SENT" | "RESCUED_SENT" | "REJECTED" | "NEAR_MISS";

export interface MomentumDiagnosticInput {
  ticker: string;
  evalAtMs: number;
  session: string | null;
  price?: number | null;
  movePct?: number | null;
  velocityPctMin?: number | null;
  instantPctMin?: number | null;
  acceleration?: number | null;
  relVol?: number | null;
  volumeSurge?: number | null;
  vwapDistPct?: number | null;
  quoteAgeMs?: number | null;
  candidateRank?: number | null;
  classification?: string | null;
  dominantReason?: string | null;
  firstSeenMs?: number | null;
  firstRankedMs?: number | null;
  firstPromotedMs?: number | null;
  firstSeenMovePct?: number | null;
  firstRankedMovePct?: number | null;
  firstPromotedMovePct?: number | null;
  firstActionableMovePct?: number | null;
  discordMovePct?: number | null;
  ret5sPct?: number | null;
  ret10sPct?: number | null;
  ret30sPct?: number | null;
  ret60sPct?: number | null;
  volumeRate?: number | null;
  volumeAcceleration?: number | null;
  rankDelta?: number | null;
  score?: number | null;
  confidence?: number | null;
  entryState?: string | null;
  actionable?: boolean;
  decision: MomentumDiagnosticDecision;
  reason?: string | null;
  latchState?: string | null;
  firstDetectedMs?: number | null;
  firstActionableMs?: number | null;
  discordDeliveredMs?: number | null;
  triggerToDiscordMs?: number | null;
  strategyVersion?: string | null;
}

export interface MomentumDiagnosticRow extends MomentumDiagnosticInput {
  id: number;
  tradingDay: string;
  createdAtMs: number;
}

export function recordMomentumDiagnostic(input: MomentumDiagnosticInput): void {
  try {
    const db = lazyDb();
    const createdAtMs = Date.now();
    db.prepare(
      `INSERT INTO momentum_diagnostics
       (ticker, eval_at_ms, trading_day, session, price, move_pct, velocity_pct_min,
        instant_pct_min, acceleration, rel_vol, volume_surge, vwap_dist_pct,
        quote_age_ms, candidate_rank, classification, dominant_reason, first_seen_ms,
        first_ranked_ms, first_promoted_ms, first_seen_move_pct, first_ranked_move_pct,
        first_promoted_move_pct, first_actionable_move_pct, discord_move_pct, ret_5s_pct,
        ret_10s_pct, ret_30s_pct, ret_60s_pct, volume_rate, volume_acceleration,
        rank_delta, score, confidence, entry_state, actionable,
        decision, reason, latch_state, first_detected_ms, first_actionable_ms,
        discord_delivered_ms, trigger_to_discord_ms, strategy_version, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.ticker,
      input.evalAtMs,
      tradingDay(input.evalAtMs),
      input.session ?? null,
      nullableNum(input.price),
      nullableNum(input.movePct),
      nullableNum(input.velocityPctMin),
      nullableNum(input.instantPctMin),
      nullableNum(input.acceleration),
      nullableNum(input.relVol),
      nullableNum(input.volumeSurge),
      nullableNum(input.vwapDistPct),
      nullableNum(input.quoteAgeMs),
      nullableNum(input.candidateRank),
      input.classification ?? null,
      input.dominantReason ?? null,
      nullableNum(input.firstSeenMs),
      nullableNum(input.firstRankedMs),
      nullableNum(input.firstPromotedMs),
      nullableNum(input.firstSeenMovePct),
      nullableNum(input.firstRankedMovePct),
      nullableNum(input.firstPromotedMovePct),
      nullableNum(input.firstActionableMovePct),
      nullableNum(input.discordMovePct),
      nullableNum(input.ret5sPct),
      nullableNum(input.ret10sPct),
      nullableNum(input.ret30sPct),
      nullableNum(input.ret60sPct),
      nullableNum(input.volumeRate),
      nullableNum(input.volumeAcceleration),
      nullableNum(input.rankDelta),
      nullableNum(input.score),
      nullableNum(input.confidence),
      input.entryState ?? null,
      input.actionable ? 1 : 0,
      input.decision,
      input.reason ?? null,
      input.latchState ?? null,
      nullableNum(input.firstDetectedMs),
      nullableNum(input.firstActionableMs),
      nullableNum(input.discordDeliveredMs),
      nullableNum(input.triggerToDiscordMs),
      input.strategyVersion ?? null,
      createdAtMs,
    );
    const retentionDays = Number(process.env.MOMENTUM_DIAGNOSTIC_RETENTION_DAYS ?? 14);
    if (Number.isFinite(retentionDays) && retentionDays > 0) {
      db.prepare("DELETE FROM momentum_diagnostics WHERE created_at_ms < ?").run(createdAtMs - retentionDays * 24 * 60 * 60_000);
    }
  } catch {
    // Diagnostics must never break the scanner.
  }
}

export function listMomentumDiagnostics(limit = 500): MomentumDiagnosticRow[] {
  const db = lazyDb();
  const rows = db.prepare("SELECT * FROM momentum_diagnostics ORDER BY eval_at_ms DESC, id DESC LIMIT ?").all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    ticker: r.ticker,
    evalAtMs: r.eval_at_ms,
    tradingDay: r.trading_day,
    session: r.session,
    price: r.price,
    movePct: r.move_pct,
    velocityPctMin: r.velocity_pct_min,
    instantPctMin: r.instant_pct_min,
    acceleration: r.acceleration,
    relVol: r.rel_vol,
    volumeSurge: r.volume_surge,
    vwapDistPct: r.vwap_dist_pct,
    quoteAgeMs: r.quote_age_ms,
    candidateRank: r.candidate_rank,
    classification: r.classification ?? null,
    dominantReason: r.dominant_reason ?? null,
    firstSeenMs: r.first_seen_ms,
    firstRankedMs: r.first_ranked_ms,
    firstPromotedMs: r.first_promoted_ms,
    firstSeenMovePct: r.first_seen_move_pct,
    firstRankedMovePct: r.first_ranked_move_pct,
    firstPromotedMovePct: r.first_promoted_move_pct,
    firstActionableMovePct: r.first_actionable_move_pct,
    discordMovePct: r.discord_move_pct,
    ret5sPct: r.ret_5s_pct,
    ret10sPct: r.ret_10s_pct,
    ret30sPct: r.ret_30s_pct,
    ret60sPct: r.ret_60s_pct,
    volumeRate: r.volume_rate,
    volumeAcceleration: r.volume_acceleration,
    rankDelta: r.rank_delta,
    score: r.score,
    confidence: r.confidence,
    entryState: r.entry_state,
    actionable: Boolean(r.actionable),
    decision: r.decision,
    reason: r.reason,
    latchState: r.latch_state,
    firstDetectedMs: r.first_detected_ms,
    firstActionableMs: r.first_actionable_ms,
    discordDeliveredMs: r.discord_delivered_ms,
    triggerToDiscordMs: r.trigger_to_discord_ms,
    strategyVersion: r.strategy_version,
    createdAtMs: r.created_at_ms,
  }));
}

/** Day-filtered read for the nightly AI (bounded; empty when the table is absent). */
export function momentumDiagnosticsForDay(day: string, db: DbLike = lazyDb(), limit = 20000): MomentumDiagnosticRow[] {
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='momentum_diagnostics'").get();
    if (!has) return [];
    const rows = db.prepare(
      "SELECT * FROM momentum_diagnostics WHERE trading_day = ? ORDER BY eval_at_ms ASC LIMIT ?",
    ).all(day, limit) as any[];
    return rows.map((r) => ({
      id: r.id, ticker: r.ticker, evalAtMs: r.eval_at_ms, tradingDay: r.trading_day, session: r.session,
      price: r.price, movePct: r.move_pct, velocityPctMin: r.velocity_pct_min, instantPctMin: r.instant_pct_min,
      acceleration: r.acceleration, relVol: r.rel_vol, volumeSurge: r.volume_surge, vwapDistPct: r.vwap_dist_pct,
      quoteAgeMs: r.quote_age_ms, candidateRank: r.candidate_rank,
      classification: r.classification ?? null, dominantReason: r.dominant_reason ?? null,
      firstSeenMs: r.first_seen_ms, firstRankedMs: r.first_ranked_ms, firstPromotedMs: r.first_promoted_ms,
      firstSeenMovePct: r.first_seen_move_pct, firstRankedMovePct: r.first_ranked_move_pct,
      firstPromotedMovePct: r.first_promoted_move_pct, firstActionableMovePct: r.first_actionable_move_pct,
      discordMovePct: r.discord_move_pct, ret5sPct: r.ret_5s_pct, ret10sPct: r.ret_10s_pct,
      ret30sPct: r.ret_30s_pct, ret60sPct: r.ret_60s_pct, volumeRate: r.volume_rate,
      volumeAcceleration: r.volume_acceleration, rankDelta: r.rank_delta,
      score: r.score, confidence: r.confidence,
      entryState: r.entry_state, actionable: Boolean(r.actionable), decision: r.decision, reason: r.reason,
      latchState: r.latch_state, firstDetectedMs: r.first_detected_ms, firstActionableMs: r.first_actionable_ms,
      discordDeliveredMs: r.discord_delivered_ms, triggerToDiscordMs: r.trigger_to_discord_ms,
      strategyVersion: r.strategy_version, createdAtMs: r.created_at_ms,
    }));
  } catch {
    return [];
  }
}

export function summarizeMomentumDiagnostics(rows: MomentumDiagnosticRow[]) {
  const sent = rows.filter((r) => r.decision === "SENT" || r.decision === "RESCUED_SENT").length;
  const rescued = rows.filter((r) => r.decision === "RESCUED_SENT").length;
  const nearMisses = rows.filter((r) => r.decision === "NEAR_MISS").length;
  const rejected = rows.filter((r) => r.decision === "REJECTED").length;
  const extendedRejections = rows.filter((r) => /extended|VWAP|day move|chase/i.test(String(r.reason ?? ""))).length;
  const staleRejected = rows.filter((r) => /stale|quote/i.test(String(r.reason ?? ""))).length;
  const avgLatencyMs = (() => {
    const vals = rows.map((r) => r.triggerToDiscordMs).filter(isNum);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  })();
  const median = (vals: Array<number | null | undefined>) => {
    const xs = vals.filter(isNum).sort((a, b) => a - b);
    if (!xs.length) return null;
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
  };
  const freshAccelerationAlerts = rows.filter((r) => (r.decision === "SENT" || r.decision === "RESCUED_SENT") && r.classification === "FRESH_ACCELERATION").length;
  const slowGrinderAlerts = rows.filter((r) => (r.decision === "SENT" || r.decision === "RESCUED_SENT") && r.classification === "SLOW_GRINDER").length;
  const lateRejections = rows.filter((r) => r.decision === "REJECTED" && (r.classification === "LATE_EXHAUSTION" || r.classification === "NOISY_ILLIQUID_SPIKE")).length;
  const fastMoversDiscoveredAfterExtension = rows.filter((r) =>
    (r.firstPromotedMovePct != null && Math.abs(r.firstPromotedMovePct) >= 6)
    || (r.firstRankedMovePct != null && Math.abs(r.firstRankedMovePct) >= 6)
  ).length;
  return {
    total: rows.length, sent, rescued, nearMisses, rejected, extendedRejections, staleRejected, avgLatencyMs,
    medianDiscoveryLatencyMs: median(rows.map((r) => r.firstRankedMs != null && r.firstSeenMs != null ? r.firstRankedMs - r.firstSeenMs : null)),
    medianPromotionLatencyMs: median(rows.map((r) => r.firstPromotedMs != null && r.firstRankedMs != null ? r.firstPromotedMs - r.firstRankedMs : null)),
    medianActionableLatencyMs: median(rows.map((r) => r.firstActionableMs != null && r.firstSeenMs != null ? r.firstActionableMs - r.firstSeenMs : null)),
    medianDiscordLatencyMs: median(rows.map((r) => r.discordDeliveredMs != null && r.firstSeenMs != null ? r.discordDeliveredMs - r.firstSeenMs : null)),
    freshAccelerationAlerts,
    slowGrinderAlerts,
    lateRejections,
    fastMoversDiscoveredAfterExtension,
  };
}

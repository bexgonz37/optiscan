/**
 * Bounded persistent diagnostics for the stock momentum callout path. These are
 * decision records, not tick storage: sent, rescued, rejected, and throttled
 * near-misses only.
 */

import { getDb, tradingDay } from "@/lib/db";

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
    const db = getDb();
    const createdAtMs = Date.now();
    db.prepare(
      `INSERT INTO momentum_diagnostics
       (ticker, eval_at_ms, trading_day, session, price, move_pct, velocity_pct_min,
        instant_pct_min, acceleration, rel_vol, volume_surge, vwap_dist_pct,
        quote_age_ms, candidate_rank, score, confidence, entry_state, actionable,
        decision, reason, latch_state, first_detected_ms, first_actionable_ms,
        discord_delivered_ms, trigger_to_discord_ms, strategy_version, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
  const db = getDb();
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
  return { total: rows.length, sent, rescued, nearMisses, rejected, extendedRejections, staleRejected, avgLatencyMs };
}

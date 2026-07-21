/**
 * lib/research/forward/read.ts — assemble the Phase-F report from the DB (read-only). Joins
 * forward_recommendations + forward_outcomes (primary horizon) and reads two_speed_alerts for the
 * latency/alert-health sample. Honest COLLECTING_DATA output when the sample is thin.
 */
import { buildForwardReport, type BacktestBaseline, type ForwardReport } from "./report.ts";
import { computeLatencyMetrics, type AlertLatencySample } from "./latency.ts";
import type { GradedItem } from "./aggregate.ts";
import type { AlertState, LatencyRecord } from "./schema.ts";

interface ReadDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] } }
const parse = (s: any) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const has = (db: ReadDb, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));

function gradedItems(db: ReadDb, horizon: string): GradedItem[] {
  if (!has(db, "forward_recommendations") || !has(db, "forward_outcomes")) return [];
  const rows = db.prepare(
    `SELECT r.strategy_key AS bucketKey, r.confidence AS confidence, r.captured_at_ms AS capturedAtMs, o.return_pct AS returnPct, o.win AS win
     FROM forward_recommendations r JOIN forward_outcomes o ON o.rec_id = r.rec_id
     WHERE o.horizon = ? AND o.return_pct IS NOT NULL`,
  ).all(horizon) as any[];
  return rows.map((r) => ({ bucketKey: r.bucketKey, confidence: Number(r.confidence) || 0, returnPct: Number(r.returnPct) || 0, win: r.win === 1, capturedAtMs: r.capturedAtMs }));
}

function latencySamples(db: ReadDb): AlertLatencySample[] {
  if (!has(db, "two_speed_alerts")) return [];
  const rows = db.prepare("SELECT state, latency_json, discord_failures, discord_retries, late_entry FROM two_speed_alerts").all() as any[];
  return rows.map((r) => ({ latency: (parse(r.latency_json) ?? {}) as LatencyRecord, state: r.state as AlertState, discordFailures: r.discord_failures ?? 0, discordRetries: r.discord_retries ?? 0, lateEntry: r.late_entry === 1 }));
}

function backtestBaseline(db: ReadDb): BacktestBaseline | null {
  if (!has(db, "analog_eval_reports")) return null;
  const row = db.prepare("SELECT report_id, report_json FROM analog_eval_reports ORDER BY created_at_ms DESC LIMIT 1").get() as any;
  const rep = parse(row?.report_json);
  if (!rep?.candidate) return null;
  return { winRate: Number(rep.candidate.hitRate) || 0, expectancy: Number(rep.candidate.expectancy) || 0, reportId: row.report_id };
}

function discordReliability(db: ReadDb) {
  if (!has(db, "two_speed_alerts")) return { delivered: 0, failed: 0, retried: 0, duplicateSuppressed: 0 };
  const g = (sql: string) => Number((db.prepare(sql).get() as any)?.n ?? 0);
  return {
    delivered: g("SELECT COUNT(*) n FROM two_speed_alerts WHERE discord_message_id IS NOT NULL"),
    failed: g("SELECT COUNT(*) n FROM two_speed_alerts WHERE discord_message_id IS NULL AND discord_failures > 0"),
    retried: g("SELECT COALESCE(SUM(discord_retries),0) n FROM two_speed_alerts"),
    duplicateSuppressed: 0,
  };
}

export function readForwardReportOnDb(db: ReadDb, opts: { primaryHorizon?: string; minForwardSample?: number; minLatencySample?: number } = {}): ForwardReport {
  const primaryHorizon = opts.primaryHorizon ?? "1d";
  const graded = gradedItems(db, primaryHorizon);
  const latency = computeLatencyMetrics(latencySamples(db));
  return buildForwardReport({
    graded, primaryHorizon, latency,
    backtest: backtestBaseline(db),
    discord: discordReliability(db),
    outages: { providerOutages: 0, discordOutages: 0, lastOutageMs: null },
    minForwardSample: opts.minForwardSample, minLatencySample: opts.minLatencySample,
  });
}

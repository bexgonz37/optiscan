/**
 * lib/research/forward/latency.ts — latency instrumentation for the two-speed pipeline (Phase F).
 * PURE. One consistent clock: every stamp is an epoch-ms Date.now() value supplied by the caller,
 * so all durations are differences on the same clock (no cross-clock skew).
 */
import { LATENCY_STAGES, type AlertState, type LatencyRecord, type LatencyStage } from "./schema.ts";

export function stamp(rec: LatencyRecord, stage: LatencyStage, nowMs: number): LatencyRecord {
  return { ...rec, [stage]: nowMs };
}
const d = (rec: LatencyRecord, a: LatencyStage, b: LatencyStage): number | null => {
  const x = rec[a], y = rec[b];
  return typeof x === "number" && typeof y === "number" ? y - x : null;
};

export interface StageDurations {
  eventToTrigger: number | null;
  triggerToEarlyWatch: number | null;
  eventToDiscordDelivery: number | null;
  eventToConfirmation: number | null;
  hardGateMs: number | null;
  optionsAnalysisMs: number | null;
  newsAnalysisMs: number | null;
  analogLookupMs: number | null;
}

export function stageDurations(rec: LatencyRecord): StageDurations {
  return {
    eventToTrigger: d(rec, "market_data_received", "trigger_detected"),
    triggerToEarlyWatch: d(rec, "trigger_detected", "early_watch_queued"),
    eventToDiscordDelivery: d(rec, "market_data_received", "discord_request_end"),
    eventToConfirmation: d(rec, "market_data_received", "final_discord_update"),
    hardGateMs: d(rec, "hard_gate_start", "hard_gate_end"),
    optionsAnalysisMs: d(rec, "options_analysis_start", "options_analysis_end"),
    newsAnalysisMs: d(rec, "news_analysis_start", "news_analysis_end"),
    analogLookupMs: d(rec, "analog_lookup_start", "analog_lookup_end"),
  };
}

/** True when heavy work (options/news/analog) overlapped the EARLY_WATCH emission — i.e. it was NOT
 *  on the critical path. Returns null when the relevant stamps are absent. */
export function heavyWorkOffCriticalPath(rec: LatencyRecord): boolean | null {
  const ew = rec["early_watch_queued"];
  if (typeof ew !== "number") return null;
  const heavyStarts = [rec["options_analysis_start"], rec["news_analysis_start"], rec["analog_lookup_start"]].filter((x): x is number => typeof x === "number");
  if (heavyStarts.length === 0) return true; // no heavy work recorded before EARLY_WATCH → off path
  // off the critical path iff every heavy stage STARTED at or after EARLY_WATCH was queued
  return heavyStarts.every((s) => s >= ew);
}

export function percentile(values: number[], q: number): number | null {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[idx];
}
export interface Dist { n: number; p50: number | null; p90: number | null; p95: number | null; max: number | null }
function dist(values: number[]): Dist {
  const v = values.filter((x) => Number.isFinite(x));
  return { n: v.length, p50: percentile(v, 0.5), p90: percentile(v, 0.9), p95: percentile(v, 0.95), max: v.length ? Math.max(...v) : null };
}

export interface AlertLatencySample {
  latency: LatencyRecord;
  state: AlertState;
  discordFailures?: number;
  discordRetries?: number;
  lateEntry?: boolean;   // delivered after the underlying already left the intended entry zone
}

export interface LatencyMetrics {
  total: number;
  eventToTrigger: Dist; triggerToEarlyWatch: Dist; eventToDiscordDelivery: Dist; eventToConfirmation: Dist;
  tooLatePct: number; canceledPct: number; expiredPct: number; confirmedPct: number; lateEntryPct: number;
  discordFailures: number; discordRetries: number;
  heavyWorkOnCriticalPath: number;   // count of alerts where heavy work was NOT off the path (should be 0)
}

export function computeLatencyMetrics(samples: AlertLatencySample[]): LatencyMetrics {
  const n = samples.length;
  const durs = samples.map((s) => stageDurations(s.latency));
  const pick = (f: (x: StageDurations) => number | null) => durs.map(f).filter((x): x is number => x != null);
  const cnt = (st: AlertState) => samples.filter((s) => s.state === st).length;
  const pct = (c: number) => (n ? +((c / n) * 100).toFixed(2) : 0);
  return {
    total: n,
    eventToTrigger: dist(pick((x) => x.eventToTrigger)),
    triggerToEarlyWatch: dist(pick((x) => x.triggerToEarlyWatch)),
    eventToDiscordDelivery: dist(pick((x) => x.eventToDiscordDelivery)),
    eventToConfirmation: dist(pick((x) => x.eventToConfirmation)),
    tooLatePct: pct(cnt("TOO_LATE")), canceledPct: pct(cnt("CANCELED")), expiredPct: pct(cnt("EXPIRED")), confirmedPct: pct(cnt("CONFIRMED")),
    lateEntryPct: pct(samples.filter((s) => s.lateEntry).length),
    discordFailures: samples.reduce((a, s) => a + (s.discordFailures ?? 0), 0),
    discordRetries: samples.reduce((a, s) => a + (s.discordRetries ?? 0), 0),
    heavyWorkOnCriticalPath: samples.filter((s) => heavyWorkOffCriticalPath(s.latency) === false).length,
  };
}

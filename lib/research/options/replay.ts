/**
 * lib/research/options/replay.ts — OPTIONS HISTORICAL REPLAY LAB, Phase 1 (deterministic, code-only).
 *
 *   Historical stock bars (existing fetchCandles — the ONLY historical data the provider integration
 *   truthfully offers) → the ACTUAL production detection path (deriveDecisionLevels →
 *   computeOptionsFeatures → scoreStrategies/selectOptionsStrategy → computeSubscriberQuality) replayed
 *   at historical decision timestamps with NO look-ahead → deterministic forward-outcome labels →
 *   stored per-candidate rows + aggregate summaries (threshold sensitivity for the subscriber bar) →
 *   ONE compact evidence summary enqueued to the AI Research Queue.
 *
 * HONESTY BOUNDARIES (hard):
 *   • Outcomes are UNDERLYING forward returns (the catalog's documented underlying_forward_return
 *     grading), direction-adjusted per side. NO option contracts, premiums, Greeks, spreads, or fills
 *     are simulated — historical option quotes are NOT entitled (see replay-provider.ts) and are never
 *     fabricated. gradingBasis is stamped "UNDERLYING_FORWARD" on every row.
 *   • Detection at time t sees ONLY bars with t' ≤ t (leak-proof by construction; test-proven by
 *     truncation invariance). Future bars are used exclusively to compute stored labels.
 *   • The AI reviewer never sees raw bars: the queue payload is a bounded aggregate summary (< 6 KB).
 *   • Pure compute runs with AI disabled / budget exhausted — the queue item simply waits.
 * HARD no-op unless OPTIONS_REPLAY_ENABLED=1. No real-money; no live-path changes.
 */
import { computeOptionsFeatures, featuresToUnderlying, type Bar } from "./features.ts";
import { deriveDecisionLevels } from "./levels.ts";
import { scoreStrategies, selectOptionsStrategy, type OptionsCandidateInput } from "./discovery.ts";
import { OPTIONS_STRATEGIES } from "./strategy-catalog.ts";
import { computeSubscriberQuality } from "./delivery-decision.ts";
import { enqueueResearchTaskOnDb } from "./research-queue.ts";

export interface ReplayCandidate {
  tMs: number; symbol: string; strategy: string; side: "call" | "put"; researchOnly: boolean;
  quality: number; strategyScore: number; matchedSignals: number; requiredSignals: number;
  fractionMove: number | null; hourEt: number;
  fwd30Pct: number | null; fwd60Pct: number | null; fwdEodPct: number | null;
  gradingBasis: "UNDERLYING_FORWARD";
}

export interface ReplayParams { stepMs?: number; windowBars?: number; maxBarAgeMs?: number }
const etHour = (t: number) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(t)) % 24;
const etDay = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(t);
const etMin = (t: number) => { const p: Record<string, string> = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(t)) p[x.type] = x.value; return (Number(p.hour) % 24) * 60 + Number(p.minute); };

/**
 * PURE replay of one symbol's bar series through the PRODUCTION detection path. Decisions are taken
 * every stepMs during regular hours; at each decision time t the feature window is STRICTLY bars ≤ t.
 * Forward labels (30m/60m/EOD underlying returns, direction-adjusted) come from later bars and are
 * stored as labels only — they never influence detection.
 */
export function replaySymbolBars(symbol: string, barsIn: Bar[], params: ReplayParams = {}): ReplayCandidate[] {
  const bars = [...barsIn].filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c)).sort((a, b) => a.t - b.t);
  if (bars.length < 30) return [];
  const stepMs = params.stepMs ?? 5 * 60_000;
  const windowBars = params.windowBars ?? 2 * 960; // ≈2 ET days of 1-min bars incl. extended hours
  const out: ReplayCandidate[] = [];
  const first = bars[0].t, last = bars[bars.length - 1].t;
  let cooldownUntil = new Map<string, number>();

  for (let t = first + 60 * 60_000; t <= last; t += stepMs) {
    const m = etMin(t);
    if (m < 9 * 60 + 30 || m >= 16 * 60) continue; // regular session decisions only (matches live paper gate)
    // decision-time window: STRICTLY bars ≤ t (the anti-look-ahead boundary)
    let hi = bars.length - 1; // binary search upper bound of t
    { let lo = 0; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bars[mid].t <= t) lo = mid; else hi = mid - 1; } hi = lo; }
    if (bars[hi].t > t) continue;
    const win = bars.slice(Math.max(0, hi - windowBars + 1), hi + 1);
    const levels = deriveDecisionLevels(win, t);
    const f = computeOptionsFeatures(win, { nowMs: t, session: "regular", maxBarAgeMs: params.maxBarAgeMs ?? 5 * 60_000, ...levels });
    if (f.stale || f.price == null) continue;
    const u = featuresToUnderlying(f);
    const input: OptionsCandidateInput = { symbol, nowMs: t, session: "regular", tier: 1, underlying: u, optionsActivity: null, earnings: null };
    if (!scoreStrategies(input).some((x) => x.applicable)) continue;
    const sel = selectOptionsStrategy(input, { bearishActionable: false });
    if (!sel.selected) continue;
    const key = `${sel.selected.key}`;
    if ((cooldownUntil.get(key) ?? 0) > t) continue; // one candidate per strategy per 30min, like live cooldowns
    cooldownUntil.set(key, t + 30 * 60_000);

    const def = OPTIONS_STRATEGIES.find((s) => s.key === sel.selected!.key)!;
    const considered = sel.considered.find((c) => c.key === sel.selected!.key);
    const fractionMove = f.hod != null && f.lod != null && f.hod > f.lod ? +(((f.price - f.lod) / (f.hod - f.lod))).toFixed(3) : null;
    // quality via the PRODUCTION model; spread/OI unknown historically → null (neutral components, documented)
    const { quality } = computeSubscriberQuality({
      deliveryInput: null as any, symbol, side: sel.selected.side, strategy: sel.selected.key, researchOnly: sel.selected.researchOnly,
      tier: 1, matchedSignals: considered?.matched.length ?? 0, requiredSignals: def.earlySignals.length, strategyScore: sel.selected.score,
      spreadPct: null, openInterest: null, volume: null, fractionMove, levelProximityPct: u.nearResistancePct, nowMs: t,
    }, null);

    // forward labels from FUTURE bars (labels only; direction-adjusted so puts count downside as win)
    const p0 = f.price;
    const at = (ms: number): number | null => { const b = bars.find((x) => x.t >= ms && x.t <= ms + 10 * 60_000); return b ? b.c : null; };
    const day = etDay(t);
    const eodBar = [...bars].reverse().find((x) => etDay(x.t) === day && etMin(x.t) < 16 * 60);
    const dir = sel.selected.side === "call" ? 1 : -1;
    const ret = (px: number | null): number | null => (px == null || p0 <= 0 ? null : +(((px - p0) / p0) * 100 * dir).toFixed(4));
    out.push({
      tMs: t, symbol, strategy: sel.selected.key, side: sel.selected.side, researchOnly: sel.selected.researchOnly,
      quality, strategyScore: sel.selected.score, matchedSignals: considered?.matched.length ?? 0, requiredSignals: def.earlySignals.length,
      fractionMove, hourEt: etHour(t),
      fwd30Pct: ret(at(t + 30 * 60_000)), fwd60Pct: ret(at(t + 60 * 60_000)), fwdEodPct: ret(eodBar && eodBar.t > t ? eodBar.c : null),
      gradingBasis: "UNDERLYING_FORWARD",
    });
  }
  return out;
}

export interface ReplayBucket { n: number; winRate: number | null; avgRetPct: number | null; profitFactor: number | null }
function bucket(rows: ReplayCandidate[], pick: (r: ReplayCandidate) => number | null): ReplayBucket {
  const rets = rows.map(pick).filter((x): x is number => x != null);
  if (!rets.length) return { n: rows.length, winRate: null, avgRetPct: null, profitFactor: null };
  const wins = rets.filter((x) => x > 0);
  const losses = rets.filter((x) => x <= 0);
  const gw = wins.reduce((a, x) => a + x, 0), gl = Math.abs(losses.reduce((a, x) => a + x, 0));
  return { n: rows.length, winRate: +(wins.length / rets.length).toFixed(4), avgRetPct: +(rets.reduce((a, x) => a + x, 0) / rets.length).toFixed(4), profitFactor: gl > 0 ? +(gw / gl).toFixed(4) : null };
}

/** Aggregate evidence incl. THRESHOLD SENSITIVITY: outcomes by quality band, so the subscriber
 *  delivery bar can be tuned on measured expectancy instead of guesses. Bounded output (< 6 KB). */
export function summarizeReplay(rows: ReplayCandidate[], deliverBar = 0.62): Record<string, unknown> {
  const group = (key: (r: ReplayCandidate) => string) => { const m: Record<string, ReplayCandidate[]> = {}; for (const r of rows) (m[key(r)] ??= []).push(r); return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, bucket(v, (x) => x.fwd60Pct)])); };
  const qBand = (q: number) => (q < 0.45 ? "q<0.45" : q < 0.55 ? "0.45-0.55" : q < 0.62 ? "0.55-0.62" : q < 0.7 ? "0.62-0.70" : q < 0.78 ? "0.70-0.78" : "q≥0.78");
  // max drawdown of the cumulative fwd60 curve in time order
  let peak = 0, cum = 0, maxDd = 0;
  for (const r of [...rows].sort((a, b) => a.tMs - b.tMs)) { if (r.fwd60Pct == null) continue; cum += r.fwd60Pct; if (cum > peak) peak = cum; if (peak - cum > maxDd) maxDd = peak - cum; }
  return {
    gradingBasis: "UNDERLYING_FORWARD (no option premiums simulated — historical option quotes not entitled)",
    candidates: rows.length,
    overall: { h30: bucket(rows, (r) => r.fwd30Pct), h60: bucket(rows, (r) => r.fwd60Pct), eod: bucket(rows, (r) => r.fwdEodPct) },
    maxDrawdownPct: +maxDd.toFixed(4),
    thresholdSensitivity: group((r) => qBand(r.quality)),
    aboveDeliverBar: bucket(rows.filter((r) => r.quality >= deliverBar), (r) => r.fwd60Pct),
    belowDeliverBar: bucket(rows.filter((r) => r.quality < deliverBar), (r) => r.fwd60Pct),
    byStrategy: group((r) => r.strategy),
    byHourEt: group((r) => `h${r.hourEt}`),
    bySide: group((r) => r.side),
  };
}

interface RDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number; lastInsertRowid?: number | bigint } } }
export interface ReplayDeps { getBars: (symbol: string, fromIso: string, toIso: string) => Promise<Bar[]>; getDb?: () => any; now?: () => number }

/** Run one bounded replay (Phase 1: capped range per run; chunked long-range scheduling is Phase 2).
 *  Streams per symbol (bars never stored); persists candidates + summary; enqueues ONE compact evidence
 *  item to the AI Research Queue (which waits harmlessly when AI is off/exhausted). */
export async function runOptionsReplay(params: { symbols: string[]; from: string; to: string }, deps: ReplayDeps, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; runId: number | null; reason: string; candidates: number; summary: Record<string, unknown> | null }> {
  if (env.OPTIONS_REPLAY_ENABLED !== "1") return { ok: false, runId: null, reason: "OPTIONS_REPLAY_ENABLED!=1", candidates: 0, summary: null };
  const maxDays = Number(env.OPTIONS_REPLAY_MAX_DAYS ?? 45);
  const spanDays = (Date.parse(params.to) - Date.parse(params.from)) / 86_400_000;
  if (!Number.isFinite(spanDays) || spanDays <= 0) return { ok: false, runId: null, reason: "invalid date range", candidates: 0, summary: null };
  if (spanDays > maxDays) return { ok: false, runId: null, reason: `range ${Math.ceil(spanDays)}d exceeds Phase-1 cap ${maxDays}d — run bounded windows (long-range scheduling is Phase 2)`, candidates: 0, summary: null };

  const now = deps.now ?? Date.now;
  let db: RDb | null = null;
  try { db = deps.getDb ? deps.getDb() : null; } catch { db = null; }
  let runId: number | null = null;
  if (db) {
    try { const r = db.prepare("INSERT INTO options_replay_runs (symbols, from_day, to_day, status, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?)").run(params.symbols.join(","), params.from, params.to, "RUNNING", now(), now()); runId = Number(r.lastInsertRowid); } catch { runId = null; }
  }

  const all: ReplayCandidate[] = [];
  const errors: string[] = [];
  for (const symbol of params.symbols) {
    try {
      const bars = await deps.getBars(symbol.toUpperCase(), params.from, params.to);
      const rows = replaySymbolBars(symbol.toUpperCase(), bars);
      all.push(...rows);
      if (db && runId != null) for (const r of rows) { try { db.prepare("INSERT INTO options_replay_candidates (run_id, t_ms, symbol, strategy, side, research_only, quality, strategy_score, matched_signals, required_signals, fraction_move, hour_et, fwd30_pct, fwd60_pct, fwd_eod_pct, grading_basis, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(runId, r.tMs, r.symbol, r.strategy, r.side, r.researchOnly ? 1 : 0, r.quality, r.strategyScore, r.matchedSignals, r.requiredSignals, r.fractionMove, r.hourEt, r.fwd30Pct, r.fwd60Pct, r.fwdEodPct, r.gradingBasis, now()); } catch { /* isolated */ } }
    } catch (e: any) { errors.push(`${symbol}: ${String(e?.message ?? e).slice(0, 80)}`); }
  }
  const summary = { ...summarizeReplay(all), from: params.from, to: params.to, symbols: params.symbols, errors: errors.slice(0, 5) };
  if (db && runId != null) {
    try { db.prepare("UPDATE options_replay_runs SET status='DONE', candidates=?, summary_json=?, updated_at_ms=? WHERE id=?").run(all.length, JSON.stringify(summary), now(), runId); } catch { /* isolated */ }
    // Compact evidence → AI queue (bounded; the AI reviewer never sees raw bars). Waits harmlessly if AI is off.
    try { enqueueResearchTaskOnDb(db as any, "strategy_recommendation", `replay:${runId}`, summary, now()); } catch { /* isolated */ }
  }
  return { ok: true, runId, reason: errors.length ? `completed with ${errors.length} symbol error(s)` : "completed", candidates: all.length, summary };
}

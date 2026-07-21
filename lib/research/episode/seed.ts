/**
 * lib/research/episode/seed.ts — Historical replay → Setup Episode seeding (Analog
 * Engine, Phase C). Turns historical bars into leakage-proof Episodes + Phase-A
 * UNDERLYING labels. PURE core + a flag-gated live driver that reuses the existing
 * replay_runs checkpoint and the Phase-A store.
 *
 * Honesty / blockers (see docs/ANALOG_ENGINE_BUILD.md):
 *   • Point-in-time universe: the caller MUST supply a survivorship-free symbol list —
 *     this module never fabricates a universe from today's tickers.
 *   • Corporate actions: use split/dividend-ADJUSTED aggregates for features (Polygon
 *     `adjusted=true`). Symbol-change/delist mapping needs the reference feed (deferred).
 *   • MODELED_OPTION labels are NOT produced by replay (no historical Greeks/chain is
 *     entitled) — replay emits UNDERLYING labels only. Nothing is fabricated.
 *
 * Leakage: every Zone-A block is computed from bars[0..i] with asOf = t0 (the decision
 * bar's close); labels use only bars with t > t0. Determinism: same bars + config ⇒ same
 * episodes/labels (deterministic episode_key). Restart-safe: idempotent store + checkpoint.
 */
import { tradingDay } from "../../trading-session.ts";
import { researchFlags } from "../flags.ts";
import { computeUnderlyingLabel, type Bar } from "./labels.ts";
import { persistEpisodeOnDb, persistLabelOnDb } from "./store.ts";
import { DAY_HORIZONS, FEATURE_SCHEMA_VERSION, HORIZONS, INTRADAY_HORIZON_MS, episodeKeyOf, type Episode, type EpisodeLabel, type ThesisSide } from "./schema.ts";

export interface SeedConfig {
  velWindow: number; baselineWindow: number; volWindow: number; rangeWindow: number; warmup: number;
  entryVelThresholdPct: number; rvolThreshold: number; refractoryMs: number;
  targetPct: number; stopPct: number;
  configVersion: number;
}

export function defaultSeedConfig(): SeedConfig {
  return {
    velWindow: 15, baselineWindow: 60, volWindow: 20, rangeWindow: 60, warmup: 60,
    entryVelThresholdPct: 0.5, rvolThreshold: 2, refractoryMs: 30 * 60_000,
    targetPct: 5, stopPct: 3, configVersion: 1,
  };
}

export interface CandidateMoment { i: number; t0Ms: number; direction: ThesisSide }
export interface SeededEpisode { episode: Episode; labels: EpisodeLabel[]; episodeKey: string }

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
function liquidityTier(dollarVol: number): string {
  if (dollarVol >= 5_000_000) return "high";
  if (dollarVol >= 500_000) return "medium";
  return "low";
}

/** Event-driven candidate moments — the SAME intake shape applied to history, using only
 *  bars[0..i] (no hindsight). Respects a per-symbol refractory window (dedup). Deterministic. */
export function identifyCandidateMoments(barsIn: Bar[], cfg: SeedConfig = defaultSeedConfig()): CandidateMoment[] {
  const bars = [...barsIn].sort((a, b) => a.t - b.t);
  const out: CandidateMoment[] = [];
  let lastT = -Infinity;
  for (let i = cfg.warmup; i < bars.length; i++) {
    const ref = bars[i - cfg.velWindow];
    if (!ref || ref.c <= 0) continue;
    const vel = ((bars[i].c - ref.c) / ref.c) * 100;
    const base = bars.slice(Math.max(0, i - cfg.baselineWindow), i);
    const meanVol = base.length ? base.reduce((a, b) => a + b.v, 0) / base.length : 0;
    const rvol = meanVol > 0 ? bars[i].v / meanVol : 0;
    if (Math.abs(vel) < cfg.entryVelThresholdPct || rvol < cfg.rvolThreshold) continue;
    if (bars[i].t - lastT < cfg.refractoryMs) continue;
    out.push({ i, t0Ms: bars[i].t, direction: vel > 0 ? "bullish" : "bearish" });
    lastT = bars[i].t;
  }
  return out;
}

/** Build the Zone-A Episode at a candidate bar from bars[0..i] only (asOf = t0). */
export function buildEpisode(symbol: string, bars: Bar[], cand: CandidateMoment, cfg: SeedConfig): Episode {
  const i = cand.i, t0 = bars[i].t;
  const ref = bars[i - cfg.velWindow];
  const vel = ref && ref.c > 0 ? ((bars[i].c - ref.c) / ref.c) * 100 : 0;
  const refPrev = bars[i - 1 - cfg.velWindow];
  const velPrev = refPrev && refPrev.c > 0 && bars[i - 1] ? ((bars[i - 1].c - refPrev.c) / refPrev.c) * 100 : vel;
  const base = bars.slice(Math.max(0, i - cfg.baselineWindow), i);
  const rvol = base.length ? bars[i].v / (base.reduce((a, b) => a + b.v, 0) / base.length) : 0;
  const volWin = bars.slice(Math.max(0, i - cfg.volWindow), i + 1);
  const rets: number[] = [];
  for (let k = 1; k < volWin.length; k++) if (volWin[k - 1].c > 0) rets.push(volWin[k].c / volWin[k - 1].c - 1);
  const rangeWin = bars.slice(Math.max(0, i - cfg.rangeWindow), i + 1);
  const hi = Math.max(...rangeWin.map((b) => b.h)), lo = Math.min(...rangeWin.map((b) => b.l));
  const posInRange = hi > lo ? (bars[i].c - lo) / (hi - lo) : 0.5;
  const gapPct = bars[i - 1] && bars[i - 1].c > 0 ? ((bars[i].o - bars[i - 1].c) / bars[i - 1].c) * 100 : 0;
  const dollarVol = bars[i].c * bars[i].v;

  const blk = (values: Record<string, number>) => ({ asOfMs: t0, values });
  const missing = ["regime", "sector", "breadth", "optionsContext", "catalyst"]; // not available in replay (no fabrication)

  return {
    source: "replay", symbol: symbol.toUpperCase(), t0Ms: t0, tradingDay: tradingDay(t0),
    session: "regular", todBucket: null, assetClass: "stock", direction: cand.direction,
    regimeLabel: null, regimeModelVersion: null, liquidityTier: liquidityTier(dollarVol), validityTier: null,
    blocks: {
      priceStructure: blk({ posInRange: +posInRange.toFixed(4), rangePct: hi > lo ? +(((hi - lo) / lo) * 100).toFixed(4) : 0, gapPct: +gapPct.toFixed(4) }),
      momentum: blk({ velPct: +vel.toFixed(4), accelPct: +(vel - velPrev).toFixed(4), velWindow: cfg.velWindow }),
      volume: blk({ rvol: +rvol.toFixed(4), volume: bars[i].v }),
      volatility: blk({ realizedVol: +std(rets).toFixed(6), atrPct: hi > lo ? +(((hi - lo) / bars[i].c) * 100).toFixed(4) : 0 }),
      regime: null, sector: null, breadth: null, optionsContext: null, catalyst: null,
    },
    missing, gateResults: null, featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    provenance: { seed: "replay", configVersion: cfg.configVersion },
  };
}

/** Resolve a horizon's end timestamp against the trading calendar in the bars (Zone B). */
export function resolveHorizonEnd(bars: Bar[], t0Ms: number, horizon: (typeof HORIZONS)[number]): number | null {
  const fwd = bars.filter((b) => b.t > t0Ms);
  const intraday = INTRADAY_HORIZON_MS[horizon];
  if (intraday != null) {
    const end = t0Ms + intraday;
    // Honest: only emit an intraday label if forward bars actually REACH the horizon end —
    // never label a "1h" outcome from a partial window.
    return fwd.some((b) => b.t >= end) ? end : null;
  }
  const day0 = tradingDay(t0Ms);
  if (horizon === "EOD") {
    const same = fwd.filter((b) => tradingDay(b.t) === day0);
    return same.length ? same[same.length - 1].t : null;
  }
  const nDays = DAY_HORIZONS[horizon];
  if (nDays == null) return null;
  const fwdDays = [...new Set(fwd.map((b) => tradingDay(b.t)))].filter((d) => d !== day0).sort();
  if (fwdDays.length < nDays) return null;
  const target = fwdDays[nDays - 1];
  const dayBars = bars.filter((b) => tradingDay(b.t) === target);
  return dayBars.length ? dayBars[dayBars.length - 1].t : null;
}

/** Underlying labels for a candidate (Zone B). Entry = the NEXT bar's open (no look-ahead
 *  using the signal bar's close for both signal and fill). MODELED_OPTION deferred (blocked). */
export function labelsFor(bars: Bar[], cand: CandidateMoment, cfg: SeedConfig): EpisodeLabel[] {
  const t0 = cand.t0Ms;
  const forward = bars.filter((b) => b.t > t0).sort((a, b) => a.t - b.t);
  if (forward.length === 0) return [];
  const entry = forward[0].o;
  const labels: EpisodeLabel[] = [];
  for (const h of HORIZONS) {
    const end = resolveHorizonEnd(bars, t0, h);
    if (end == null) continue;
    const l = computeUnderlyingLabel({ t0Ms: t0, horizon: h, entryPrice: entry, side: cand.direction, forwardBars: forward, horizonEndMs: end, targetPct: cfg.targetPct, stopPct: cfg.stopPct });
    if (l) labels.push(l);
  }
  return labels;
}

/** Pure seed: bars → episodes + labels. Deterministic; no I/O. */
export function seedEpisodesPure(symbol: string, bars: Bar[], cfg: SeedConfig = defaultSeedConfig()): SeededEpisode[] {
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  return identifyCandidateMoments(sorted, cfg).map((cand) => {
    const episode = buildEpisode(symbol, sorted, cand, cfg);
    return { episode, labels: labelsFor(sorted, cand, cfg), episodeKey: episodeKeyOf("replay", symbol, cand.t0Ms, FEATURE_SCHEMA_VERSION) };
  });
}

// ── OnDb + live driver ───────────────────────────────────────────────────────
interface SeedDb { prepare(sql: string): { get: (...a: any[]) => any; run: (...a: any[]) => { changes: number } } }

export interface SeedSymbolResult { episodesCaptured: number; episodesRefused: number; labels: number }

/** Persist one symbol's seeded episodes + labels. Idempotent; refuses any leaky row. */
export function seedSymbolOnDb(db: SeedDb, symbol: string, bars: Bar[], cfg: SeedConfig = defaultSeedConfig(), nowMs: number = Date.now()): SeedSymbolResult {
  let episodesCaptured = 0, episodesRefused = 0, labels = 0;
  for (const s of seedEpisodesPure(symbol, bars, cfg)) {
    const r = persistEpisodeOnDb(db as any, s.episode, nowMs);
    if (!r.ok) { episodesRefused += 1; continue; }
    if (r.inserted) episodesCaptured += 1;
    for (const l of s.labels) if (persistLabelOnDb(db as any, s.episodeKey, s.episode.t0Ms, l, nowMs).inserted) labels += 1;
  }
  return { episodesCaptured, episodesRefused, labels };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveDb = () => require("@/lib/db").getDb();

export interface ReplaySeedResult { ran: boolean; skippedReason: string | null; symbolsDone: number; episodes: number; labels: number }

/**
 * Live replay-seeding driver. HARD no-op unless HISTORICAL_REPLAY_ENABLED=1 AND
 * EPISODE_CAPTURE_ENABLED=1. The caller MUST supply a survivorship-free symbol list.
 * Reuses replay_runs for a run row + resumable checkpoint (done symbols). Bars are
 * fetched split/dividend-ADJUSTED via the provider. Never throws into the caller.
 */
export async function runReplaySeed(
  opts: { symbols: string[]; from: string; to: string; timespan?: string; providerCallBudget?: number; config?: SeedConfig },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReplaySeedResult> {
  const f = researchFlags(env);
  if (!f.historicalReplay || !f.episodeCapture) {
    return { ran: false, skippedReason: "requires HISTORICAL_REPLAY_ENABLED=1 and EPISODE_CAPTURE_ENABLED=1", symbolsDone: 0, episodes: 0, labels: 0 };
  }
  if (!opts.symbols?.length) return { ran: false, skippedReason: "no survivorship-free universe supplied", symbolsDone: 0, episodes: 0, labels: 0 };
  const cfg = opts.config ?? defaultSeedConfig();
  const nowMs = Date.now();
  const runId = `episode_seed_${nowMs}`;
  try {
    const db = liveDb() as SeedDb;
    db.prepare(
      `INSERT OR IGNORE INTO replay_runs (run_id, experiment_id, asset_class, symbols_json, date_from, date_to, timespan, strategy_version, config_json, status, checkpoint_json, provider_call_budget, created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(runId, runId, "stock", JSON.stringify(opts.symbols), opts.from, opts.to, opts.timespan ?? "minute", cfg.configVersion, JSON.stringify(cfg), "RUNNING", JSON.stringify({ done: [] }), opts.providerCallBudget ?? opts.symbols.length, nowMs, nowMs);
    const { fetchHistoricalStockBars } = await import("./../replay-provider.ts");
    const done = new Set<string>();
    let episodes = 0, labels = 0, calls = 0;
    const budget = opts.providerCallBudget ?? opts.symbols.length;
    for (const symbol of opts.symbols) {
      if (calls >= budget) break;
      const r = await fetchHistoricalStockBars(symbol, { from: opts.from, to: opts.to, timespan: opts.timespan ?? "minute" }, env);
      calls += r.providerCalls;
      const res = seedSymbolOnDb(db, symbol, r.bars, cfg, nowMs);
      episodes += res.episodesCaptured; labels += res.labels; done.add(symbol);
      db.prepare("UPDATE replay_runs SET checkpoint_json=?, updated_at_ms=? WHERE run_id=?").run(JSON.stringify({ done: [...done] }), nowMs, runId);
    }
    db.prepare("UPDATE replay_runs SET status='COMPLETED', updated_at_ms=? WHERE run_id=?").run(nowMs, runId);
    return { ran: true, skippedReason: null, symbolsDone: done.size, episodes, labels };
  } catch (err: any) {
    return { ran: false, skippedReason: `seed error (isolated): ${err?.message ?? String(err)}`, symbolsDone: 0, episodes: 0, labels: 0 };
  }
}

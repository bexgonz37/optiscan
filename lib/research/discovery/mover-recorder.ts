/**
 * mover-recorder.ts — the observation lane. Ranks the whole-market snapshot the
 * scanner has ALREADY fetched and writes what the market did, once per cycle.
 *
 * ZERO PROVIDER COST. It is handed the parsed rows from the same
 * `fetchMarketSnapshot()` response the discovery cycle already paid for. It
 * issues no request of its own, and if it is never called nothing else changes.
 *
 * ZERO LIVE AUTHORITY. It cannot promote a symbol into the scanner, emit a
 * callout, open a position, touch a gate, or reach Discord. The only thing it
 * does is write rows. Everything it touches is wrapped so that a failure here
 * cannot propagate into the discovery cycle that called it — a research
 * subsystem must never be able to break the scanner.
 *
 * GATED. `MARKET_MOVER_OBSERVATION=0` turns it off entirely. It is opt-OUT
 * rather than opt-in because an observation lane that is off by default records
 * nothing, and a record that does not exist is exactly the failure being fixed.
 */
import {
  marketDiscoveryConfig,
  rankMarketMovers,
  type MarketQuote,
  type MoverSnapshot,
} from "./market-movers.ts";
import { recordMarketMoversOnDb, type MoverObservationInput } from "./mover-store.ts";

/** Previous cycle's move per symbol, so velocity is computable without a fetch. */
type RecorderState = { prev: Map<string, MoverSnapshot>; lastCycleAtMs: number; lastRecorded: number; lastRankedCount: number };
type G = typeof globalThis & { __optiscanMoverRecorder?: RecorderState };

function state(): RecorderState {
  const g = globalThis as G;
  return (g.__optiscanMoverRecorder ??= { prev: new Map(), lastCycleAtMs: 0, lastRecorded: 0, lastRankedCount: 0 });
}

/** Test seam: forget the rolling snapshot so tests are order-independent. */
export function __resetMoverRecorderForTest(): void {
  delete (globalThis as G).__optiscanMoverRecorder;
}

export interface RecordCycleResult {
  ran: boolean;
  reason: string | null;
  /** Rows the snapshot carried. */
  scanned: number;
  /** Rows that cleared MARKET DISCOVERY eligibility (not trading eligibility). */
  ranked: number;
  /** Rows written or advanced. */
  recorded: number;
  /** The top movers this cycle, for the caller's diagnostic. Never used to decide anything. */
  top: { symbol: string; movePct: number; rank: number; extreme: boolean }[];
}

/**
 * Rank and persist one cycle of whole-market state.
 *
 * `getDb` is injected so the scanner's import graph does not gain a database
 * dependency and so tests can pass an in-memory handle.
 */
export function recordMarketMoverCycle(
  quotes: readonly MarketQuote[],
  opts: {
    nowMs: number;
    sessionDate: string;
    sessionPhase: "premarket" | "regular" | "afterhours" | "closed";
    getDb: () => unknown;
    env?: NodeJS.ProcessEnv;
    /** How many ranked movers to persist per cycle. Bounded so a wild day cannot write unboundedly. */
    maxRecorded?: number;
  },
): RecordCycleResult {
  const out: RecordCycleResult = { ran: false, reason: null, scanned: quotes.length, ranked: 0, recorded: 0, top: [] };
  const env = opts.env ?? process.env;
  if (String(env.MARKET_MOVER_OBSERVATION ?? "") === "0") {
    out.reason = "MARKET_MOVER_OBSERVATION=0";
    return out;
  }
  if (!quotes.length) {
    out.reason = "empty snapshot";
    return out;
  }
  try {
    const s = state();
    const cfg = marketDiscoveryConfig(env);
    const ranked = rankMarketMovers(quotes, s.prev, opts.nowMs, cfg);
    out.ranked = ranked.length;
    out.ran = true;

    // Roll the snapshot forward BEFORE persisting, so a write failure still
    // leaves the next cycle able to compute velocity.
    s.prev = new Map(
      quotes.filter((q) => q.symbol).map((q) => [String(q.symbol).toUpperCase(), { changePercent: q.changePercent ?? null, atMs: opts.nowMs }]),
    );
    s.lastCycleAtMs = opts.nowMs;
    s.lastRankedCount = ranked.length;

    const cap = Math.max(1, Math.min(500, Math.floor(opts.maxRecorded ?? 100)));
    const selected = ranked.slice(0, cap);
    out.top = selected.slice(0, 10).map((m) => ({ symbol: m.symbol, movePct: m.movePct, rank: m.rank, extreme: m.extreme }));

    const db = opts.getDb() as any;
    if (!db) { out.reason = "no database"; return out; }
    const inputs: MoverObservationInput[] = selected.map((mover) => ({
      sessionDate: opts.sessionDate,
      sessionPhase: opts.sessionPhase,
      mover,
      atMs: opts.nowMs,
    }));
    const res = recordMarketMoversOnDb(db, inputs);
    out.recorded = res.inserted;
    s.lastRecorded = res.inserted;
    if (res.error) out.reason = res.error;
    return out;
  } catch (err: any) {
    out.reason = String(err?.message ?? err);
    return out;
  }
}

/** What the recorder last did. Observability only. */
export function moverRecorderState(): { lastCycleAtMs: number; lastRecorded: number; lastRankedCount: number; trackedSymbols: number } {
  const s = state();
  return {
    lastCycleAtMs: s.lastCycleAtMs,
    lastRecorded: s.lastRecorded,
    lastRankedCount: s.lastRankedCount,
    trackedSymbols: s.prev.size,
  };
}

/**
 * rvol-shadow.ts — Phase K. CAN a point-in-time-safe relative volume be built at all?
 *
 * `rel_volume` is a live early signal (`activeSignals` adds it at >= 2x) and it
 * is DEAD: nothing supplies `FeatureContext.timeOfDayAvgVolume`, so `relVolume`
 * is null on every candidate and the signal never fires. Four strategies list it
 * — `breakout_forming`, `confirmed_breakout`, `opening_range_breakout`,
 * `premarket_level_break`, all of them CALL or `either` — and each is scored as
 * `matched / earlySignals.length`. A permanently-absent signal is therefore not
 * a neutral omission: it is a permanent score penalty applied to exactly the
 * bullish half of the catalog, which is a candidate explanation for a 9/93 mix
 * that has nothing to do with the market.
 *
 * That makes "just turn it on" the most tempting and most dangerous option
 * available, so this module deliberately cannot do it.
 *
 * ── WHAT THIS MODULE REFUSES TO DO ──────────────────────────────────────────
 *
 * IT DOES NOT ACTIVATE rel_volume. It computes a feasibility verdict and, only
 * where the evidence genuinely supports one, an expected volume. Nothing here is
 * wired into `activeSignals`, and the production signal stays exactly as dead as
 * it was until the owner has evidence to change it deliberately.
 *
 * IT DOES NOT LOOK AHEAD. The baseline may only be built from volume that PRIOR
 * sessions had accumulated by the SAME time of day. Two things are therefore
 * banned by construction, and the SQL enforces both rather than trusting a
 * comment:
 *
 *   · the current session contributes NOTHING, not even its earlier bars —
 *     `ts_ms < sessionStartMs` is a hard predicate;
 *   · a prior session's FULL-DAY volume is never used, only the part before the
 *     same clock time — otherwise a 10:15 reading would be compared against a
 *     16:00 total and every symbol would look quiet every morning.
 *
 * A relVolume computed against a guessed baseline is strictly worse than no
 * relVolume, because it is indistinguishable from a real one downstream.
 *
 * IT DOES NOT FABRICATE. Where the history is absent or too sparse the verdict
 * is `INSUFFICIENT_*` / `NO_INTRADAY_HISTORY` with a null expectation, and the
 * blockers say what is missing. A verdict of BLOCKED is a finding.
 *
 * ── ON THE LOCAL SNAPSHOT ───────────────────────────────────────────────────
 *
 * `historical_underlying_bars` is ABSENT from the local development database, so
 * running this locally reports `NO_INTRADAY_HISTORY` — which is a fact about the
 * local snapshot, NOT about production. The verdict is therefore computed at
 * runtime against whatever database it is handed rather than being declared in
 * a document; that is the only way the answer stays true after the off-peak
 * ingestion lane fills the table.
 */
import { tradingDay, etSessionOpenMs } from "../../trading-session.ts";
import {
  assessRelativeVolume,
  type PriorSessionVolume, type RelVolumeAssessment,
} from "./feature-semantics-shadow.ts";

export const RVOL_SHADOW_VERSION = "OPTIONS_RVOL_SHADOW_V1" as const;

type StoreDb = {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
};

export interface RvolShadowConfig {
  /** Prior sessions required before a median is a baseline rather than an anecdote. */
  minSessions: number;
  /** Bars a prior session must have before the time of day to count as usable. */
  minBarsPerSession: number;
  /** How far back to look. Bounds the scan; also bounds how stale a baseline may be. */
  lookbackSessions: number;
}

export const DEFAULT_RVOL_SHADOW: Readonly<RvolShadowConfig> = Object.freeze({
  minSessions: 10,
  minBarsPerSession: 5,
  lookbackSessions: 30,
});

export function rvolShadowConfig(env: NodeJS.ProcessEnv = process.env): RvolShadowConfig {
  const d = DEFAULT_RVOL_SHADOW;
  const n = (v: string | undefined, dflt: number, min: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= min ? Math.floor(x) : dflt;
  };
  return {
    minSessions: n(env.OPTIONS_RVOL_SHADOW_MIN_SESSIONS, d.minSessions, 1),
    minBarsPerSession: n(env.OPTIONS_RVOL_SHADOW_MIN_BARS, d.minBarsPerSession, 1),
    lookbackSessions: n(env.OPTIONS_RVOL_SHADOW_LOOKBACK, d.lookbackSessions, 1),
  };
}

export type RvolShadowStatus = "AVAILABLE" | "BLOCKED";

export interface RvolShadowResult {
  version: typeof RVOL_SHADOW_VERSION;
  symbol: string;
  status: RvolShadowStatus;
  /** The underlying feasibility verdict, verbatim. */
  assessment: RelVolumeAssessment;
  /**
   * The SHADOW ratio, present only when a baseline genuinely exists AND the
   * caller supplied the current session's cumulative volume. Never null-coerced
   * to a number, never defaulted to 1.
   */
  shadowRelVolume: number | null;
  /** Minutes since the session open that the baseline was cut at. */
  minutesIntoSession: number | null;
  /** Whether the bar store exists at all in this database. */
  storePresent: boolean;
  /** Production authority. Constant, and constant on purpose. */
  productionSignalActive: false;
}

function tableExists(db: StoreDb, name: string): boolean {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch {
    return false;
  }
}

/**
 * Prior sessions' cumulative volume at the SAME minute-of-session.
 *
 * The join key is MINUTES SINCE THAT SESSION'S OWN OPEN, not a wall-clock time,
 * so a DST shift compares 45-minutes-in against 45-minutes-in rather than
 * against an hour earlier. That is the whole reason `etSessionOpenMs` is called
 * per candidate day instead of subtracting a fixed offset once.
 */
export function priorSessionVolumes(
  db: StoreDb,
  symbol: string,
  nowMs: number,
  cfg: RvolShadowConfig = DEFAULT_RVOL_SHADOW,
): { sessions: PriorSessionVolume[]; storePresent: boolean; minutesIntoSession: number | null } {
  if (!tableExists(db, "historical_underlying_bars")) {
    return { sessions: [], storePresent: false, minutesIntoSession: null };
  }

  const today = tradingDay(nowMs);
  const openMs = etSessionOpenMs(today);
  const minutesIntoSession = Number.isFinite(openMs) && nowMs >= openMs
    ? Math.floor((nowMs - openMs) / 60_000)
    : null;
  if (minutesIntoSession == null) {
    return { sessions: [], storePresent: true, minutesIntoSession: null };
  }

  const sym = String(symbol ?? "").toUpperCase();
  const lookbackStartMs = openMs - cfg.lookbackSessions * 2 * 86_400_000; // calendar slack for weekends/holidays

  let rows: { day: string; ts_ms: number; volume: number }[] = [];
  try {
    rows = db.prepare(
      `SELECT date(ts_ms/1000,'unixepoch','-4 hours') AS day, ts_ms, volume
         FROM historical_underlying_bars
        WHERE symbol = ? AND timeframe = '1m'
          AND ts_ms >= ? AND ts_ms < ?
        ORDER BY ts_ms ASC`,
    ).all(sym, lookbackStartMs, openMs) as { day: string; ts_ms: number; volume: number }[];
  } catch {
    return { sessions: [], storePresent: true, minutesIntoSession };
  }

  // Group by that session's own day, then cut each at the same minute offset
  // from ITS open. `ts_ms < openMs` above already excluded the current session
  // entirely, so no branch below can readmit it.
  const byDay = new Map<string, { ts: number; v: number }[]>();
  for (const r of rows) {
    const day = String(r.day ?? "");
    if (!day || day >= today) continue; // defensive: the current session never contributes
    const v = Number(r.volume);
    if (!Number.isFinite(v) || v < 0) continue;
    const list = byDay.get(day) ?? [];
    list.push({ ts: Number(r.ts_ms), v });
    byDay.set(day, list);
  }

  const sessions: PriorSessionVolume[] = [];
  const days = [...byDay.keys()].sort().slice(-cfg.lookbackSessions);
  for (const day of days) {
    const dayOpen = etSessionOpenMs(day);
    if (!Number.isFinite(dayOpen)) continue;
    const cutoff = dayOpen + minutesIntoSession * 60_000;
    const bars = (byDay.get(day) ?? []).filter((b) => b.ts >= dayOpen && b.ts < cutoff);
    sessions.push({
      sessionDate: day,
      cumVolumeAtSameTimeOfDay: bars.length ? bars.reduce((a, b) => a + b.v, 0) : null,
      barsBeforeTimeOfDay: bars.length,
    });
  }

  return { sessions, storePresent: true, minutesIntoSession };
}

/**
 * The Phase-K verdict for one symbol at one instant.
 *
 * `currentCumVolume` is OPTIONAL and its absence is not a failure: the question
 * Phase K was asked is whether a baseline can be built, and that is answerable
 * without a numerator. Supplying one adds the shadow ratio; supplying a bad one
 * cannot manufacture a baseline that the history does not support.
 */
export function assessRvolShadow(
  db: StoreDb,
  symbol: string,
  nowMs: number,
  currentCumVolume: number | null = null,
  cfg: RvolShadowConfig = DEFAULT_RVOL_SHADOW,
): RvolShadowResult {
  const { sessions, storePresent, minutesIntoSession } = priorSessionVolumes(db, symbol, nowMs, cfg);
  const assessment = assessRelativeVolume(sessions, {
    minSessions: cfg.minSessions,
    minBarsPerSession: cfg.minBarsPerSession,
  });

  const expected = assessment.expectedCumVolume;
  const shadowRelVolume = assessment.feasibility === "AVAILABLE"
    && expected != null && expected > 0
    && typeof currentCumVolume === "number" && Number.isFinite(currentCumVolume)
    ? +(currentCumVolume / expected).toFixed(3)
    : null;

  return {
    version: RVOL_SHADOW_VERSION,
    symbol: String(symbol ?? "").toUpperCase(),
    status: assessment.feasibility === "AVAILABLE" ? "AVAILABLE" : "BLOCKED",
    assessment: storePresent ? assessment : {
      ...assessment,
      blockers: ["historical_underlying_bars is not present in this database"],
    },
    shadowRelVolume,
    minutesIntoSession,
    storePresent,
    productionSignalActive: false,
  };
}

/**
 * Feasibility across a sample of symbols — the answer to "is Phase K blocked?".
 *
 * Sampled and bounded rather than exhaustive: this is a coverage question, and
 * scanning the full universe to answer it would cost more than the answer is
 * worth. The sample size is reported so a reader can tell a real verdict from a
 * thin one.
 */
export function rvolShadowFeasibility(
  db: StoreDb,
  symbols: readonly string[],
  nowMs: number,
  cfg: RvolShadowConfig = DEFAULT_RVOL_SHADOW,
  maxSymbols = 25,
): {
  version: typeof RVOL_SHADOW_VERSION;
  status: RvolShadowStatus;
  storePresent: boolean;
  sampled: number;
  available: number;
  blocked: number;
  byFeasibility: Record<string, number>;
  blockers: string[];
  productionSignalActive: false;
} {
  const sample = symbols.slice(0, Math.max(1, maxSymbols));
  const byFeasibility: Record<string, number> = {};
  const blockers = new Set<string>();
  let available = 0, storePresent = false;

  for (const sym of sample) {
    const r = assessRvolShadow(db, sym, nowMs, null, cfg);
    storePresent = storePresent || r.storePresent;
    byFeasibility[r.assessment.feasibility] = (byFeasibility[r.assessment.feasibility] ?? 0) + 1;
    if (r.status === "AVAILABLE") available += 1;
    for (const b of r.assessment.blockers) blockers.add(b);
  }

  return {
    version: RVOL_SHADOW_VERSION,
    // A single symbol succeeding does not make the lane feasible; the majority
    // must, or the shadow would be reporting on a biased subset of the universe.
    status: sample.length > 0 && available * 2 > sample.length ? "AVAILABLE" : "BLOCKED",
    storePresent,
    sampled: sample.length,
    available,
    blocked: sample.length - available,
    byFeasibility,
    blockers: [...blockers].sort(),
    productionSignalActive: false,
  };
}

/**
 * setup-families.ts — PURE deterministic technical setup detection for the
 * professional Watchlist.
 *
 * Every supported family is detected from COMPLETED bars only. A family that has
 * no deterministic evidence returns null; nothing is inferred, estimated, or
 * filled in from a later bar. There is deliberately no generic/fallback family:
 * a symbol with no qualifying structure simply produces no setup.
 *
 * Trigger vocabulary is fixed: CALLS ABOVE <price> and/or PUTS BELOW <price>,
 * each anchored to a named source level that a reader can verify on a chart.
 *
 * No I/O. No provider access. No clock reads beyond the caller-supplied `nowMs`.
 */

export type SetupFamily =
  | "INSIDE_BAR_DAILY"
  | "GAP_FILL_DAILY"
  | "DAILY_BREAKOUT"
  | "DAILY_BREAKDOWN"
  | "PRIOR_DAY_HIGH_BREAK"
  | "PRIOR_DAY_LOW_BREAK"
  | "SUPPORT_RECLAIM"
  | "RESISTANCE_REJECTION"
  | "VWAP_RECLAIM"
  | "VWAP_REJECTION"
  | "OPENING_RANGE_BREAKOUT"
  | "OPENING_RANGE_BREAKDOWN"
  | "TREND_CONTINUATION"
  | "FAILED_BREAKOUT"
  | "FAILED_BREAKDOWN"
  | "RELATIVE_STRENGTH"
  | "RELATIVE_WEAKNESS"
  | "EARNINGS_CONTINUATION"
  | "CATALYST_MOMENTUM";

/** Display label per family. Internal pipeline names never reach subscriber copy. */
export const SETUP_FAMILY_LABEL: Record<SetupFamily, string> = {
  INSIDE_BAR_DAILY: "Inside Bar — Daily",
  GAP_FILL_DAILY: "Gap Fill — Daily",
  DAILY_BREAKOUT: "Daily Breakout",
  DAILY_BREAKDOWN: "Daily Breakdown",
  PRIOR_DAY_HIGH_BREAK: "Prior-Day High Break",
  PRIOR_DAY_LOW_BREAK: "Prior-Day Low Break",
  SUPPORT_RECLAIM: "Support Reclaim",
  RESISTANCE_REJECTION: "Resistance Rejection",
  VWAP_RECLAIM: "VWAP Reclaim",
  VWAP_REJECTION: "VWAP Rejection",
  OPENING_RANGE_BREAKOUT: "Opening Range Breakout",
  OPENING_RANGE_BREAKDOWN: "Opening Range Breakdown",
  TREND_CONTINUATION: "Trend Continuation",
  FAILED_BREAKOUT: "Failed Breakout",
  FAILED_BREAKDOWN: "Failed Breakdown",
  RELATIVE_STRENGTH: "Relative Strength",
  RELATIVE_WEAKNESS: "Relative Weakness",
  EARNINGS_CONTINUATION: "Earnings Continuation",
  CATALYST_MOMENTUM: "Catalyst Momentum",
};

export const SUPPORTED_SETUP_FAMILIES = Object.keys(SETUP_FAMILY_LABEL) as SetupFamily[];

/**
 * Earliest publication phase for a family.
 * OVERNIGHT   — provable from completed daily bars alone.
 * PREMARKET   — needs premarket extended-hours evidence.
 * LIVE_SESSION— needs live regular-session evidence (VWAP, opening range).
 */
export type SetupAvailability = "OVERNIGHT" | "PREMARKET" | "LIVE_SESSION";

export const SETUP_FAMILY_AVAILABILITY: Record<SetupFamily, SetupAvailability> = {
  INSIDE_BAR_DAILY: "OVERNIGHT",
  GAP_FILL_DAILY: "OVERNIGHT",
  DAILY_BREAKOUT: "OVERNIGHT",
  DAILY_BREAKDOWN: "OVERNIGHT",
  PRIOR_DAY_HIGH_BREAK: "OVERNIGHT",
  PRIOR_DAY_LOW_BREAK: "OVERNIGHT",
  SUPPORT_RECLAIM: "OVERNIGHT",
  RESISTANCE_REJECTION: "OVERNIGHT",
  TREND_CONTINUATION: "OVERNIGHT",
  FAILED_BREAKOUT: "OVERNIGHT",
  FAILED_BREAKDOWN: "OVERNIGHT",
  RELATIVE_STRENGTH: "OVERNIGHT",
  RELATIVE_WEAKNESS: "OVERNIGHT",
  EARNINGS_CONTINUATION: "OVERNIGHT",
  CATALYST_MOMENTUM: "OVERNIGHT",
  VWAP_RECLAIM: "LIVE_SESSION",
  VWAP_REJECTION: "LIVE_SESSION",
  OPENING_RANGE_BREAKOUT: "LIVE_SESSION",
  OPENING_RANGE_BREAKDOWN: "LIVE_SESSION",
};

/** One completed daily candle. `day` is the ET trading day, YYYY-MM-DD. */
export interface DailyBar {
  day: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** End-of-session timestamp for the bar (ms). Used for freshness only. */
  closedAtMs?: number | null;
}

/** Session evidence beyond the daily series. Every field is optional and never invented. */
export interface SessionLevels {
  /** Extended-hours premarket high/low for the upcoming session. */
  premarketHigh?: number | null;
  premarketLow?: number | null;
  /**
   * When the premarket extremes were observed, and where they came from.
   * BOTH are required before a premarket level may move a published trigger —
   * an unsourced or undated extreme is not evidence, it is a number.
   */
  premarketAsOfMs?: number | null;
  premarketSource?: string | null;
  /** Live regular-session VWAP. Only supply when it is genuinely live. */
  vwap?: number | null;
  /** Regular-session opening range. */
  openingRangeHigh?: number | null;
  openingRangeLow?: number | null;
  /** Most recent observed underlying price and when it was observed. */
  lastPrice?: number | null;
  lastPriceAtMs?: number | null;
}

/** A catalyst the caller has independently CONFIRMED. Never derived here. */
export interface ConfirmedCatalyst {
  kind: "EARNINGS" | "CATALYST";
  label: string;
  confirmedAtMs: number;
  source: string;
  /** Trading day the event is attached to (ET, YYYY-MM-DD). */
  tradingDay: string;
}

export interface SourceLevel {
  name: string;
  value: number;
  /** Which completed session or window the level came from. */
  origin: string;
}

export interface SetupTrigger {
  side: "CALL" | "PUT";
  relation: "ABOVE" | "BELOW";
  price: number;
  sourceLevelName: string;
}

export interface DetectedSetup {
  symbol: string;
  family: SetupFamily;
  familyLabel: string;
  availability: SetupAvailability;
  callTrigger: SetupTrigger | null;
  putTrigger: SetupTrigger | null;
  /** One concise plain-English sentence. No internal pipeline names. */
  reason: string;
  sourceLevels: SourceLevel[];
  /** Latest evidence timestamp used. Never in the future relative to nowMs. */
  evidenceAsOfMs: number;
  /** Human freshness label, e.g. "Completed session 2026-07-29". */
  freshness: string;
  /** Confirmed catalyst attached to this setup, when the caller supplied one. */
  catalyst: string | null;
  /** Deterministic ordering strength, 0..100. Not a confidence score. */
  structureScore: number;
}

export interface DetectSetupsInput {
  symbol: string;
  /** Completed daily bars, oldest first. Partial/forming days must be excluded. */
  dailyBars: DailyBar[];
  /** Benchmark daily bars (usually SPY) for relative strength/weakness. */
  benchmarkDailyBars?: DailyBar[] | null;
  session?: SessionLevels | null;
  catalyst?: ConfirmedCatalyst | null;
  nowMs: number;
  /** Highest phase the caller is allowed to publish. Defaults to OVERNIGHT. */
  phase?: SetupAvailability;
}

// ── Deterministic thresholds ────────────────────────────────────────────────
const MIN_DAILY_BARS = 21;
const RANGE_LOOKBACK = 20;
const BREAKOUT_PROXIMITY_PCT = 2.0;   // close within 2% of the range extreme
const GAP_MIN_PCT = 1.0;              // a gap smaller than this is noise
const TREND_RUN = 3;                  // consecutive directional closes
const PIVOT_WING = 2;                 // fractal swing pivot half-width
const LEVEL_TOUCH_PCT = 0.75;         // how near a level counts as "at" it
const RS_MIN_SPREAD_PCT = 3.0;        // relative performance spread over lookback
const RS_LOOKBACK = 5;
const CATALYST_MIN_MOVE_PCT = 4.0;

const round2 = (n: number) => Math.round(n * 100) / 100;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pctDiff = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / Math.abs(b)) * 100);
const money = (n: number) => `$${round2(n).toFixed(2)}`;

function positiveBars(bars: DailyBar[] | null | undefined): DailyBar[] {
  if (!Array.isArray(bars)) return [];
  return bars
    .filter((b) =>
      b && typeof b.day === "string" && b.day.length === 10 &&
      isNum(b.o) && isNum(b.h) && isNum(b.l) && isNum(b.c) &&
      b.h >= b.l && b.h > 0 && b.l > 0)
    .slice()
    .sort((a, b) => a.day.localeCompare(b.day));
}

function barAsOfMs(bar: DailyBar, fallbackMs: number): number {
  return isNum(bar.closedAtMs) && bar.closedAtMs > 0 ? bar.closedAtMs : fallbackMs;
}

function call(price: number, sourceLevelName: string): SetupTrigger {
  return { side: "CALL", relation: "ABOVE", price: round2(price), sourceLevelName };
}
function put(price: number, sourceLevelName: string): SetupTrigger {
  return { side: "PUT", relation: "BELOW", price: round2(price), sourceLevelName };
}
function level(name: string, value: number, origin: string): SourceLevel {
  return { name, value: round2(value), origin };
}

/** Fractal swing highs/lows over completed bars. Excludes the wing at each end. */
function swingLevels(bars: DailyBar[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = PIVOT_WING; i < bars.length - PIVOT_WING; i++) {
    let isHigh = true;
    let isLow = true;
    for (let k = i - PIVOT_WING; k <= i + PIVOT_WING; k++) {
      if (k === i) continue;
      if (bars[k].h >= bars[i].h) isHigh = false;
      if (bars[k].l <= bars[i].l) isLow = false;
    }
    if (isHigh) highs.push(bars[i].h);
    if (isLow) lows.push(bars[i].l);
  }
  return { highs, lows };
}

function nearestBelow(values: number[], price: number): number | null {
  const below = values.filter((v) => v < price);
  return below.length ? Math.max(...below) : null;
}
function nearestAbove(values: number[], price: number): number | null {
  const above = values.filter((v) => v > price);
  return above.length ? Math.min(...above) : null;
}

function totalReturnPct(bars: DailyBar[], lookback: number): number | null {
  if (bars.length < lookback + 1) return null;
  const start = bars[bars.length - 1 - lookback].c;
  const end = bars[bars.length - 1].c;
  if (!isNum(start) || start <= 0) return null;
  return pctDiff(end, start);
}

type Candidate = Omit<DetectedSetup, "symbol" | "familyLabel" | "availability">;

/**
 * Detect every qualifying setup for one symbol.
 * Results are ordered by structureScore descending, then family name, so the
 * output is stable for identical input.
 */
export function detectSetups(input: DetectSetupsInput): DetectedSetup[] {
  const symbol = String(input.symbol ?? "").toUpperCase();
  const bars = positiveBars(input.dailyBars).filter((b) => barAsOfMs(b, 0) <= input.nowMs || !isNum(b.closedAtMs));
  const phase: SetupAvailability = input.phase ?? "OVERNIGHT";
  if (!symbol || bars.length < MIN_DAILY_BARS) return [];

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const asOfMs = barAsOfMs(last, input.nowMs);
  if (asOfMs > input.nowMs) return [];
  const freshness = `Completed session ${last.day}`;
  const window = bars.slice(-RANGE_LOOKBACK - 1, -1); // completed range EXCLUDING the last bar
  const rangeHigh = Math.max(...window.map((b) => b.h));
  const rangeLow = Math.min(...window.map((b) => b.l));
  const catalyst = input.catalyst ?? null;
  const session = input.session ?? null;

  const out: Candidate[] = [];
  const push = (c: Candidate) => { if (c.callTrigger || c.putTrigger) out.push(c); };

  // ── Inside Bar — Daily ────────────────────────────────────────────────────
  if (last.h <= prev.h && last.l >= prev.l && !(last.h === prev.h && last.l === prev.l)) {
    push({
      family: "INSIDE_BAR_DAILY",
      callTrigger: call(last.h, "Inside-bar high"),
      putTrigger: put(last.l, "Inside-bar low"),
      reason: `${last.day} traded fully inside the prior day's range, coiling between ${money(last.l)} and ${money(last.h)}.`,
      sourceLevels: [
        level("Inside-bar high", last.h, `Session ${last.day}`),
        level("Inside-bar low", last.l, `Session ${last.day}`),
        level("Prior-day high", prev.h, `Session ${prev.day}`),
        level("Prior-day low", prev.l, `Session ${prev.day}`),
      ],
      evidenceAsOfMs: asOfMs,
      freshness,
      catalyst: catalyst?.label ?? null,
      structureScore: 72,
    });
  }

  // ── Gap Fill — Daily (unfilled gap between prev close and last session) ───
  const gapPct = pctDiff(last.o, prev.c);
  if (Math.abs(gapPct) >= GAP_MIN_PCT) {
    const gapUpUnfilled = gapPct > 0 && last.l > prev.c;
    const gapDownUnfilled = gapPct < 0 && last.h < prev.c;
    if (gapUpUnfilled || gapDownUnfilled) {
      push({
        family: "GAP_FILL_DAILY",
        callTrigger: gapDownUnfilled ? call(last.h, "Gap-session high") : null,
        putTrigger: gapUpUnfilled ? put(last.l, "Gap-session low") : null,
        reason: gapUpUnfilled
          ? `An unfilled ${Math.abs(gapPct).toFixed(1)}% gap up leaves open air back to ${money(prev.c)}.`
          : `An unfilled ${Math.abs(gapPct).toFixed(1)}% gap down leaves open air back to ${money(prev.c)}.`,
        sourceLevels: [
          level("Gap boundary (prior close)", prev.c, `Session ${prev.day}`),
          level(gapUpUnfilled ? "Gap-session low" : "Gap-session high", gapUpUnfilled ? last.l : last.h, `Session ${last.day}`),
        ],
        evidenceAsOfMs: asOfMs,
        freshness,
        catalyst: catalyst?.label ?? null,
        structureScore: 68,
      });
    }
  }

  // ── Daily Breakout / Breakdown ────────────────────────────────────────────
  if (last.c <= rangeHigh && pctDiff(last.c, rangeHigh) >= -BREAKOUT_PROXIMITY_PCT) {
    push({
      family: "DAILY_BREAKOUT",
      callTrigger: call(rangeHigh, `${RANGE_LOOKBACK}-day high`),
      putTrigger: null,
      reason: `Price closed ${Math.abs(pctDiff(last.c, rangeHigh)).toFixed(1)}% under the ${RANGE_LOOKBACK}-day high at ${money(rangeHigh)} without breaking it.`,
      sourceLevels: [
        level(`${RANGE_LOOKBACK}-day high`, rangeHigh, `Sessions ${window[0].day} to ${window[window.length - 1].day}`),
        level("Last close", last.c, `Session ${last.day}`),
      ],
      evidenceAsOfMs: asOfMs,
      freshness,
      catalyst: catalyst?.label ?? null,
      structureScore: 70,
    });
  }
  if (last.c >= rangeLow && pctDiff(last.c, rangeLow) <= BREAKOUT_PROXIMITY_PCT) {
    push({
      family: "DAILY_BREAKDOWN",
      callTrigger: null,
      putTrigger: put(rangeLow, `${RANGE_LOOKBACK}-day low`),
      reason: `Price closed ${Math.abs(pctDiff(last.c, rangeLow)).toFixed(1)}% above the ${RANGE_LOOKBACK}-day low at ${money(rangeLow)} without losing it.`,
      sourceLevels: [
        level(`${RANGE_LOOKBACK}-day low`, rangeLow, `Sessions ${window[0].day} to ${window[window.length - 1].day}`),
        level("Last close", last.c, `Session ${last.day}`),
      ],
      evidenceAsOfMs: asOfMs,
      freshness,
      catalyst: catalyst?.label ?? null,
      structureScore: 70,
    });
  }

  // ── Prior-Day High / Low break ────────────────────────────────────────────
  if (last.c < last.h) {
    push({
      family: "PRIOR_DAY_HIGH_BREAK",
      callTrigger: call(last.h, "Prior-day high"),
      putTrigger: null,
      reason: `Price closed under the prior-day high at ${money(last.h)}, leaving that level as the first upside decision point.`,
      sourceLevels: [
        level("Prior-day high", last.h, `Session ${last.day}`),
        level("Prior-day close", last.c, `Session ${last.day}`),
      ],
      evidenceAsOfMs: asOfMs,
      freshness,
      catalyst: catalyst?.label ?? null,
      structureScore: 60,
    });
  }
  if (last.c > last.l) {
    push({
      family: "PRIOR_DAY_LOW_BREAK",
      callTrigger: null,
      putTrigger: put(last.l, "Prior-day low"),
      reason: `Price closed above the prior-day low at ${money(last.l)}, leaving that level as the first downside decision point.`,
      sourceLevels: [
        level("Prior-day low", last.l, `Session ${last.day}`),
        level("Prior-day close", last.c, `Session ${last.day}`),
      ],
      evidenceAsOfMs: asOfMs,
      freshness,
      catalyst: catalyst?.label ?? null,
      structureScore: 60,
    });
  }

  // ── Support Reclaim / Resistance Rejection ────────────────────────────────
  const swings = swingLevels(bars.slice(0, -1));
  const support = nearestBelow(swings.lows, last.c);
  const resistance = nearestAbove(swings.highs, last.c);
  const lostSupport = swings.lows.filter((v) => v > last.c);
  const reclaimTarget = lostSupport.length ? Math.min(...lostSupport) : null;
  if (reclaimTarget != null && Math.abs(pctDiff(last.c, reclaimTarget)) <= LEVEL_TOUCH_PCT * 3) {
    push({
      family: "SUPPORT_RECLAIM",
      callTrigger: call(reclaimTarget, "Lost swing support"),
      putTrigger: null,
      reason: `Price is sitting just under prior swing support at ${money(reclaimTarget)}; reclaiming it turns that level back into a floor.`,
      sourceLevels: [
        level("Lost swing support", reclaimTarget, "Prior swing pivot"),
        level("Last close", last.c, `Session ${last.day}`),
      ],
      evidenceAsOfMs: asOfMs,
      freshness,
      catalyst: catalyst?.label ?? null,
      structureScore: 64,
    });
  }
  if (resistance != null && last.h >= resistance && last.c < resistance) {
    push({
      family: "RESISTANCE_REJECTION",
      callTrigger: null,
      putTrigger: put(last.l, "Rejection-session low"),
      reason: `Price tagged swing resistance at ${money(resistance)} and closed back under it, leaving ${money(last.l)} as the failure level.`,
      sourceLevels: [
        level("Swing resistance", resistance, "Prior swing pivot"),
        level("Rejection-session low", last.l, `Session ${last.day}`),
      ],
      evidenceAsOfMs: asOfMs,
      freshness,
      catalyst: catalyst?.label ?? null,
      structureScore: 66,
    });
  }

  // ── Trend Continuation ────────────────────────────────────────────────────
  const recent = bars.slice(-(TREND_RUN + 1));
  const risingRun = recent.length === TREND_RUN + 1 &&
    recent.every((b, i) => i === 0 || (b.c > recent[i - 1].c && b.l > recent[i - 1].l));
  const fallingRun = recent.length === TREND_RUN + 1 &&
    recent.every((b, i) => i === 0 || (b.c < recent[i - 1].c && b.h < recent[i - 1].h));
  if (risingRun || fallingRun) {
    push({
      family: "TREND_CONTINUATION",
      callTrigger: risingRun ? call(last.h, "Trend-session high") : null,
      putTrigger: fallingRun ? put(last.l, "Trend-session low") : null,
      reason: risingRun
        ? `${TREND_RUN} straight sessions of higher closes and higher lows keep ${money(last.h)} as the continuation level.`
        : `${TREND_RUN} straight sessions of lower closes and lower highs keep ${money(last.l)} as the continuation level.`,
      sourceLevels: [
        level(risingRun ? "Trend-session high" : "Trend-session low", risingRun ? last.h : last.l, `Session ${last.day}`),
        level("Run start close", recent[0].c, `Session ${recent[0].day}`),
      ],
      evidenceAsOfMs: asOfMs,
      freshness,
      catalyst: catalyst?.label ?? null,
      structureScore: 65,
    });
  }

  // ── Failed Breakout / Failed Breakdown ────────────────────────────────────
  if (last.h > rangeHigh && last.c < rangeHigh) {
    push({
      family: "FAILED_BREAKOUT",
      callTrigger: null,
      putTrigger: put(last.l, "Failed-breakout low"),
      reason: `Price poked above the ${RANGE_LOOKBACK}-day high at ${money(rangeHigh)} and closed back inside the range.`,
      sourceLevels: [
        level(`${RANGE_LOOKBACK}-day high`, rangeHigh, `Sessions ${window[0].day} to ${window[window.length - 1].day}`),
        level("Failed-breakout low", last.l, `Session ${last.day}`),
      ],
      evidenceAsOfMs: asOfMs,
      freshness,
      catalyst: catalyst?.label ?? null,
      structureScore: 74,
    });
  }
  if (last.l < rangeLow && last.c > rangeLow) {
    push({
      family: "FAILED_BREAKDOWN",
      callTrigger: call(last.h, "Failed-breakdown high"),
      putTrigger: null,
      reason: `Price lost the ${RANGE_LOOKBACK}-day low at ${money(rangeLow)} and closed back inside the range.`,
      sourceLevels: [
        level(`${RANGE_LOOKBACK}-day low`, rangeLow, `Sessions ${window[0].day} to ${window[window.length - 1].day}`),
        level("Failed-breakdown high", last.h, `Session ${last.day}`),
      ],
      evidenceAsOfMs: asOfMs,
      freshness,
      catalyst: catalyst?.label ?? null,
      structureScore: 74,
    });
  }

  // ── Relative Strength / Weakness (requires a real benchmark series) ───────
  const benchBars = positiveBars(input.benchmarkDailyBars);
  if (benchBars.length >= RS_LOOKBACK + 1) {
    const own = totalReturnPct(bars, RS_LOOKBACK);
    const bench = totalReturnPct(benchBars, RS_LOOKBACK);
    if (own != null && bench != null) {
      const spread = own - bench;
      if (spread >= RS_MIN_SPREAD_PCT) {
        push({
          family: "RELATIVE_STRENGTH",
          callTrigger: call(last.h, "Prior-day high"),
          putTrigger: null,
          reason: `Over ${RS_LOOKBACK} sessions this name outperformed the broad market by ${spread.toFixed(1)} points, with ${money(last.h)} as the next upside level.`,
          sourceLevels: [
            level("Prior-day high", last.h, `Session ${last.day}`),
            level("Last close", last.c, `Session ${last.day}`),
          ],
          evidenceAsOfMs: asOfMs,
          freshness,
          catalyst: catalyst?.label ?? null,
          structureScore: 62,
        });
      } else if (spread <= -RS_MIN_SPREAD_PCT) {
        push({
          family: "RELATIVE_WEAKNESS",
          callTrigger: null,
          putTrigger: put(last.l, "Prior-day low"),
          reason: `Over ${RS_LOOKBACK} sessions this name underperformed the broad market by ${Math.abs(spread).toFixed(1)} points, with ${money(last.l)} as the next downside level.`,
          sourceLevels: [
            level("Prior-day low", last.l, `Session ${last.day}`),
            level("Last close", last.c, `Session ${last.day}`),
          ],
          evidenceAsOfMs: asOfMs,
          freshness,
          catalyst: catalyst?.label ?? null,
          structureScore: 62,
        });
      }
    }
  }

  // ── Earnings Continuation / Catalyst Momentum ─────────────────────────────
  // Both REQUIRE a caller-confirmed event. Without one they never detect, so a
  // catalyst can never be invented from price action alone.
  if (catalyst && catalyst.tradingDay === last.day && catalyst.confirmedAtMs <= input.nowMs) {
    const movePct = pctDiff(last.c, prev.c);
    if (catalyst.kind === "EARNINGS" && Math.abs(gapPct) >= GAP_MIN_PCT && Math.sign(movePct) === Math.sign(gapPct)) {
      push({
        family: "EARNINGS_CONTINUATION",
        callTrigger: gapPct > 0 ? call(last.h, "Post-earnings high") : null,
        putTrigger: gapPct < 0 ? put(last.l, "Post-earnings low") : null,
        reason: `Confirmed earnings (${catalyst.label}) produced a ${gapPct > 0 ? "gap up" : "gap down"} that held into the close.`,
        sourceLevels: [
          level(gapPct > 0 ? "Post-earnings high" : "Post-earnings low", gapPct > 0 ? last.h : last.l, `Session ${last.day}`),
          level("Gap boundary (prior close)", prev.c, `Session ${prev.day}`),
        ],
        evidenceAsOfMs: asOfMs,
        freshness,
        catalyst: catalyst.label,
        structureScore: 78,
      });
    }
    if (catalyst.kind === "CATALYST" && Math.abs(movePct) >= CATALYST_MIN_MOVE_PCT) {
      push({
        family: "CATALYST_MOMENTUM",
        callTrigger: movePct > 0 ? call(last.h, "Catalyst-session high") : null,
        putTrigger: movePct < 0 ? put(last.l, "Catalyst-session low") : null,
        reason: `Confirmed catalyst (${catalyst.label}) drove a ${Math.abs(movePct).toFixed(1)}% session move that closed near its extreme.`,
        sourceLevels: [
          level(movePct > 0 ? "Catalyst-session high" : "Catalyst-session low", movePct > 0 ? last.h : last.l, `Session ${last.day}`),
          level("Prior close", prev.c, `Session ${prev.day}`),
        ],
        evidenceAsOfMs: asOfMs,
        freshness,
        catalyst: catalyst.label,
        structureScore: 76,
      });
    }
  }

  // ── Live-session families (VWAP, opening range) ───────────────────────────
  if (phase === "LIVE_SESSION" && session) {
    const price = isNum(session.lastPrice) ? session.lastPrice : null;
    const liveAsOfMs = isNum(session.lastPriceAtMs) && session.lastPriceAtMs <= input.nowMs
      ? session.lastPriceAtMs
      : null;
    if (isNum(session.vwap) && session.vwap > 0 && price != null && liveAsOfMs != null) {
      if (price < session.vwap) {
        push({
          family: "VWAP_RECLAIM",
          callTrigger: call(session.vwap, "Session VWAP"),
          putTrigger: null,
          reason: `Price is trading under the session VWAP at ${money(session.vwap)}; reclaiming it flips intraday control back to buyers.`,
          sourceLevels: [level("Session VWAP", session.vwap, "Live regular session")],
          evidenceAsOfMs: liveAsOfMs,
          freshness: "Live regular session",
          catalyst: catalyst?.label ?? null,
          structureScore: 58,
        });
      } else {
        push({
          family: "VWAP_REJECTION",
          callTrigger: null,
          putTrigger: put(session.vwap, "Session VWAP"),
          reason: `Price is holding above the session VWAP at ${money(session.vwap)}; losing it flips intraday control to sellers.`,
          sourceLevels: [level("Session VWAP", session.vwap, "Live regular session")],
          evidenceAsOfMs: liveAsOfMs,
          freshness: "Live regular session",
          catalyst: catalyst?.label ?? null,
          structureScore: 58,
        });
      }
    }
    if (isNum(session.openingRangeHigh) && isNum(session.openingRangeLow) && liveAsOfMs != null
      && session.openingRangeHigh > session.openingRangeLow) {
      push({
        family: "OPENING_RANGE_BREAKOUT",
        callTrigger: call(session.openingRangeHigh, "Opening-range high"),
        putTrigger: null,
        reason: `The opening range set a ceiling at ${money(session.openingRangeHigh)}.`,
        sourceLevels: [level("Opening-range high", session.openingRangeHigh, "Live regular session")],
        evidenceAsOfMs: liveAsOfMs,
        freshness: "Live regular session",
        catalyst: catalyst?.label ?? null,
        structureScore: 56,
      });
      push({
        family: "OPENING_RANGE_BREAKDOWN",
        callTrigger: null,
        putTrigger: put(session.openingRangeLow, "Opening-range low"),
        reason: `The opening range set a floor at ${money(session.openingRangeLow)}.`,
        sourceLevels: [level("Opening-range low", session.openingRangeLow, "Live regular session")],
        evidenceAsOfMs: liveAsOfMs,
        freshness: "Live regular session",
        catalyst: catalyst?.label ?? null,
        structureScore: 56,
      });
    }
  }

  const allowed = new Set<SetupAvailability>(
    phase === "LIVE_SESSION" ? ["OVERNIGHT", "PREMARKET", "LIVE_SESSION"]
      : phase === "PREMARKET" ? ["OVERNIGHT", "PREMARKET"]
      : ["OVERNIGHT"],
  );

  return out
    .map((c) => ({
      ...c,
      symbol,
      familyLabel: SETUP_FAMILY_LABEL[c.family],
      availability: SETUP_FAMILY_AVAILABILITY[c.family],
    }))
    .filter((c) => allowed.has(c.availability))
    .sort((a, b) => b.structureScore - a.structureScore || a.family.localeCompare(b.family));
}

/** How stale a premarket extreme may be before it stops counting as evidence. */
export const PREMARKET_LEVEL_MAX_AGE_MS = 30 * 60_000;

/**
 * Is this premarket evidence usable? It must carry a named source and an
 * observation time that is in the past and recent. Anything else is excluded
 * with a reason rather than silently applied.
 */
export function premarketEvidenceVerdict(
  session: SessionLevels | null | undefined,
  nowMs: number,
  maxAgeMs: number = PREMARKET_LEVEL_MAX_AGE_MS,
): { usable: boolean; reason: string | null } {
  if (!session) return { usable: false, reason: "No premarket evidence" };
  const source = String(session.premarketSource ?? "").trim();
  if (!source) return { usable: false, reason: "Premarket levels carry no source" };
  const asOf = session.premarketAsOfMs;
  if (!isNum(asOf) || asOf <= 0) return { usable: false, reason: "Premarket levels carry no observation time" };
  if (asOf > nowMs) return { usable: false, reason: "Premarket levels are timestamped in the future" };
  if (nowMs - asOf > maxAgeMs) return { usable: false, reason: "Premarket levels are stale" };
  if (!isNum(session.premarketHigh) && !isNum(session.premarketLow)) {
    return { usable: false, reason: "No premarket high or low observed" };
  }
  return { usable: true, reason: null };
}

/**
 * Apply premarket evidence to an overnight setup: a premarket extreme that has
 * already traded beyond a daily trigger REPLACES that trigger, because the daily
 * level is no longer the live decision point. Returns the setup unchanged when
 * no USABLE premarket evidence applies — unsourced, undated, future-dated, and
 * stale extremes never move a published level.
 */
export function applyPremarketLevels(
  setup: DetectedSetup,
  session: SessionLevels | null | undefined,
  observedAtMs: number,
): { setup: DetectedSetup; changed: boolean; changes: string[]; excludedReason: string | null } {
  const verdict = premarketEvidenceVerdict(session, observedAtMs);
  if (!verdict.usable) return { setup, changed: false, changes: [], excludedReason: verdict.reason };
  const changes: string[] = [];
  let callTrigger = setup.callTrigger;
  let putTrigger = setup.putTrigger;
  const sourceLevels = setup.sourceLevels.slice();

  const origin = `Premarket session (${String(session!.premarketSource).trim()})`;

  if (callTrigger && isNum(session!.premarketHigh) && session!.premarketHigh > callTrigger.price) {
    changes.push(`CALL trigger moved from ${money(callTrigger.price)} to the premarket high ${money(session!.premarketHigh)}`);
    callTrigger = call(session!.premarketHigh, "Premarket high");
    sourceLevels.push(level("Premarket high", session!.premarketHigh, origin));
  }
  if (putTrigger && isNum(session!.premarketLow) && session!.premarketLow < putTrigger.price) {
    changes.push(`PUT trigger moved from ${money(putTrigger.price)} to the premarket low ${money(session!.premarketLow)}`);
    putTrigger = put(session!.premarketLow, "Premarket low");
    sourceLevels.push(level("Premarket low", session!.premarketLow, origin));
  }
  if (!changes.length) return { setup, changed: false, changes: [], excludedReason: null };
  return {
    setup: {
      ...setup,
      callTrigger,
      putTrigger,
      sourceLevels,
      // The premarket observation time is the freshness anchor, never `now`.
      evidenceAsOfMs: Math.max(setup.evidenceAsOfMs, session!.premarketAsOfMs as number),
      freshness: "Premarket update",
    },
    changed: true,
    changes,
    excludedReason: null,
  };
}

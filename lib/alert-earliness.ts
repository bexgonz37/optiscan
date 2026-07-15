/**
 * alert-earliness.ts — PURE post-trade timing-quality grading (§Part 6).
 *
 * For each ALERTED momentum stock, decide WHERE in the move the alert landed,
 * using only market data already stored on the diagnostic row. This is strictly
 * post-hoc evaluation — NOTHING here feeds the live decision (no hindsight in the
 * live path). It answers "did we alert this fresh, or after it had already run /
 * topped?" so the nightly report can explain performance and so drift toward late
 * alerts is measurable. A row without the fields to judge is UNGRADABLE, never
 * force-graded.
 */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: string | undefined, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);

export type EarlinessGrade = "EARLY" | "DEVELOPING" | "LATE" | "EXHAUSTED" | "UNGRADABLE";

export interface EarlinessInput {
  /** Signed day-move % at the alert. */
  movePct?: number | null;
  /** Signed day-move % the first time we saw this symbol (before it triggered). */
  firstSeenMovePct?: number | null;
  /** Trailing returns (%) at alert. */
  ret10sPct?: number | null;
  ret30sPct?: number | null;
  ret60sPct?: number | null;
  /** Velocity (%/min) and acceleration at alert. */
  velocityPctMin?: number | null;
  acceleration?: number | null;
  /** Extension from session VWAP (%) at alert. */
  vwapDistPct?: number | null;
  classification?: string | null;
  /** Timing anchors (ms) for acceleration-onset → alert latency. */
  firstDetectedMs?: number | null;
  firstActionableMs?: number | null;
  firstSeenMs?: number | null;
}

export interface EarlinessConfig {
  earlyVwapPct: number;      // ≤ this extension is still early
  extendedVwapPct: number;   // ≥ this extension is late/extended
  earlyDayMovePct: number;   // ≤ this day-move is still early
  lateDayMovePct: number;    // ≥ this day-move is late
  lateVelocityFloor: number; // below this |velocity| while up is a late grind
}

export function earlinessConfig(env: NodeJS.ProcessEnv = process.env): EarlinessConfig {
  return {
    earlyVwapPct: num(env.EARLINESS_EARLY_VWAP_PCT, 1.0),
    extendedVwapPct: num(env.EARLINESS_EXTENDED_VWAP_PCT, 2.5),
    earlyDayMovePct: num(env.EARLINESS_EARLY_DAY_MOVE_PCT, 2.5),
    lateDayMovePct: num(env.EARLINESS_LATE_DAY_MOVE_PCT, 6),
    lateVelocityFloor: num(env.EARLINESS_LATE_VELOCITY_FLOOR, 0.12),
  };
}

export interface EarlinessResult {
  grade: EarlinessGrade;
  reason: string;
  /** |move since first seen| — how much accrued while we watched before alerting. */
  preAlertMovePct: number | null;
  extensionPct: number | null;
  /** ms from acceleration onset (first detected) to the actionable alert. */
  onsetToAlertMs: number | null;
}

/** Signed value in the move's own direction (a reversal reads negative). */
function aligned(move: number | null | undefined, value: number | null | undefined): number | null {
  if (!isNum(value) || !isNum(move)) return null;
  return move >= 0 ? value : -value;
}

export function gradeEarliness(input: EarlinessInput, cfg: EarlinessConfig = earlinessConfig()): EarlinessResult {
  const move = input.movePct;
  const absMove = isNum(move) ? Math.abs(move) : null;
  const extension = isNum(input.vwapDistPct) ? Math.abs(input.vwapDistPct) : null;
  const preAlert = isNum(move) && isNum(input.firstSeenMovePct) ? +(Math.abs(move) - Math.abs(input.firstSeenMovePct)).toFixed(3) : null;
  const onsetToAlertMs = isNum(input.firstActionableMs) && isNum(input.firstDetectedMs) && input.firstActionableMs >= input.firstDetectedMs
    ? input.firstActionableMs - input.firstDetectedMs
    : null;

  const ret10 = aligned(move, input.ret10sPct);
  const ret30 = aligned(move, input.ret30sPct);
  const vel = aligned(move, input.velocityPctMin);
  const accel = aligned(move, input.acceleration);

  const base = { preAlertMovePct: preAlert, extensionPct: extension, onsetToAlertMs };

  // Need at least the day-move to judge anything.
  if (absMove == null) return { grade: "UNGRADABLE", reason: "no day-move recorded", ...base };
  const noRecent = ret10 == null && ret30 == null && vel == null;
  if (noRecent && extension == null) return { grade: "UNGRADABLE", reason: "no recent-return or extension data", ...base };

  // EXHAUSTED: recent returns rolling over, or acceleration negative while extended.
  if ((ret10 != null && ret30 != null && ret10 <= 0 && ret30 <= 0)
      || (accel != null && accel < -0.05 && extension != null && extension >= cfg.extendedVwapPct)) {
    return { grade: "EXHAUSTED", reason: "recent returns rolling over / decelerating while extended", ...base };
  }

  // LATE: extended from VWAP, or most of the day-move already done, or grinding slowly while up.
  if ((extension != null && extension >= cfg.extendedVwapPct)
      || absMove >= cfg.lateDayMovePct
      || (vel != null && Math.abs(vel) < cfg.lateVelocityFloor && absMove >= 1)) {
    return { grade: "LATE", reason: "alerted after most of the move / while extended", ...base };
  }

  // EARLY: low extension, small day-move so far, and current momentum still strong.
  const momentumStrong = (ret10 != null && ret10 > 0.05) || (vel != null && Math.abs(vel) >= cfg.lateVelocityFloor);
  if ((extension == null || extension <= cfg.earlyVwapPct) && absMove <= cfg.earlyDayMovePct && momentumStrong) {
    return { grade: "EARLY", reason: "alerted with low extension while momentum is still building", ...base };
  }

  return { grade: "DEVELOPING", reason: "mid-move — neither clearly early nor extended", ...base };
}

export interface EarlinessSummary {
  graded: number;
  ungradable: number;
  counts: Record<EarlinessGrade, number>;
  pctEarly: number | null;
  pctLateOrExhausted: number | null;
  medianOnsetToAlertMs: number | null;
  slowGrinderAlerts: number;
  fastRunnerAlerts: number;
}

/** Aggregate earliness across a batch of alerted rows (SENT / RESCUED_SENT only). */
export function summarizeEarliness(inputs: EarlinessInput[], cfg: EarlinessConfig = earlinessConfig()): EarlinessSummary {
  const counts: Record<EarlinessGrade, number> = { EARLY: 0, DEVELOPING: 0, LATE: 0, EXHAUSTED: 0, UNGRADABLE: 0 };
  const onsets: number[] = [];
  let slowGrinderAlerts = 0, fastRunnerAlerts = 0;
  for (const inp of inputs) {
    const r = gradeEarliness(inp, cfg);
    counts[r.grade] += 1;
    if (isNum(r.onsetToAlertMs)) onsets.push(r.onsetToAlertMs);
    if (inp.classification === "SLOW_GRINDER") slowGrinderAlerts += 1;
    if (inp.classification === "FRESH_ACCELERATION") fastRunnerAlerts += 1;
  }
  const graded = counts.EARLY + counts.DEVELOPING + counts.LATE + counts.EXHAUSTED;
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };
  const pct = (n: number) => (graded > 0 ? +((n / graded) * 100).toFixed(1) : null);
  return {
    graded,
    ungradable: counts.UNGRADABLE,
    counts,
    pctEarly: pct(counts.EARLY),
    pctLateOrExhausted: pct(counts.LATE + counts.EXHAUSTED),
    medianOnsetToAlertMs: median(onsets),
    slowGrinderAlerts,
    fastRunnerAlerts,
  };
}

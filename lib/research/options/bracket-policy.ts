/**
 * bracket-policy.ts — versioned, deterministic bracket definitions and SHADOW
 * evaluation over verified rows. PURE: no DB, no network, no AI.
 *
 * WHY THIS EXISTS. Production runs a symmetric bracket — median target
 * +44.94 %, median stop −44.94 %, a 1:1 reward-to-risk — at an 18.29 % win
 * rate. That implies −28.5 % expectancy against an observed −25.88 %. A 1:1
 * bracket needs a win rate above 50 % merely to break even; at 18.29 % the
 * target would have to be roughly +201 % against that stop.
 *
 * No exit policy, spread fix or signal tweak repairs that. It is arithmetic.
 *
 * NOTHING HERE IS PROMOTED BY BEING EVALUATED. Every policy below is SHADOW
 * ONLY: it cannot send Discord, cannot alter subscriber state, cannot open a
 * position, and cannot touch official P&L. Promotion requires a frozen forward
 * sample, which by definition does not exist yet.
 *
 * NO FUTURE LEAKAGE. A policy sees only marks at or before the instant it acts.
 * `simulatePolicy` walks the series forward and stops at the first triggering
 * observation — it never inspects the outcome to choose an exit.
 */

export const BRACKET_FRAMEWORK_VERSION = "BRACKET_V1" as const;

export type BracketFamily =
  | "SYMMETRIC_BASELINE"
  | "TIGHTER_STOP_SAME_TARGET"
  | "ASYMMETRIC_2R"
  | "ASYMMETRIC_3R"
  | "TIME_EXIT_TIGHT_STOP"
  | "MFE_TRAILING";

export interface BracketPolicy {
  id: string;
  family: BracketFamily;
  version: string;
  /** Target as a percentage gain from entry. Null = no fixed target. */
  targetPct: number | null;
  /** Stop as a NEGATIVE percentage from entry. */
  stopPct: number;
  /** Minutes after entry to force an exit. Null = none. */
  timeExitMinutes: number | null;
  /** Give-back from peak, in points of return, that closes the position. */
  trailGiveBackPts: number | null;
  /** Peak return that must be reached before the trail activates. */
  trailActivateAtPct: number | null;
  rationale: string;
}

const P = (p: BracketPolicy): BracketPolicy => Object.freeze(p);

/**
 * Candidate set. Deliberately small and each one falsifiable.
 *
 * Note what is ABSENT: no policy was reverse-engineered from the outcomes it
 * will be scored on. Each is a prior stated in advance, which is the only way
 * the comparison means anything.
 */
export const CANDIDATE_POLICIES: readonly BracketPolicy[] = Object.freeze([
  P({
    id: "BASELINE_SYMMETRIC_45", family: "SYMMETRIC_BASELINE", version: BRACKET_FRAMEWORK_VERSION,
    targetPct: 45, stopPct: -45, timeExitMinutes: null, trailGiveBackPts: null, trailActivateAtPct: null,
    rationale: "Production today. Included as the control, not as a candidate.",
  }),
  P({
    id: "TIGHT_STOP_20", family: "TIGHTER_STOP_SAME_TARGET", version: BRACKET_FRAMEWORK_VERSION,
    targetPct: 45, stopPct: -20, timeExitMinutes: null, trailGiveBackPts: null, trailActivateAtPct: null,
    rationale: "Same target, stop cut to -20% — 2.25:1. Breakeven win rate falls from 50% to 31%.",
  }),
  P({
    id: "ASYM_2R", family: "ASYMMETRIC_2R", version: BRACKET_FRAMEWORK_VERSION,
    targetPct: 50, stopPct: -25, timeExitMinutes: null, trailGiveBackPts: null, trailActivateAtPct: null,
    rationale: "2:1. Breakeven win rate 33%. Observed 23.2% reach +25%, so +50% is a stretch.",
  }),
  P({
    id: "ASYM_3R", family: "ASYMMETRIC_3R", version: BRACKET_FRAMEWORK_VERSION,
    targetPct: 60, stopPct: -20, timeExitMinutes: null, trailGiveBackPts: null, trailActivateAtPct: null,
    rationale: "3:1. Breakeven win rate 25%. Still above the observed 18.29% — included to test the gap.",
  }),
  P({
    id: "TIME_30_STOP_20", family: "TIME_EXIT_TIGHT_STOP", version: BRACKET_FRAMEWORK_VERSION,
    targetPct: 45, stopPct: -20, timeExitMinutes: 30, trailGiveBackPts: null, trailActivateAtPct: null,
    rationale: "Tight stop plus a 30-minute cut. Time stops produced the largest median improvement in Checkpoint 1.",
  }),
  P({
    id: "TRAIL_15_FROM_10", family: "MFE_TRAILING", version: BRACKET_FRAMEWORK_VERSION,
    targetPct: null, stopPct: -20, timeExitMinutes: null, trailGiveBackPts: 15, trailActivateAtPct: 10,
    rationale: "Protects the 43.9% that trade profitably at some point. Requires independent marks to be meaningful.",
  }),
]);

// ── bracket arithmetic ─────────────────────────────────────────────────────

export interface BracketMath {
  riskRewardRatio: number | null;
  breakevenWinRate: number | null;
  impliedExpectancyPct: number | null;
  survivableAtWinRate: boolean | null;
}

/**
 * What the bracket requires, independent of any sample. This is the check that
 * should have been run before the symmetric bracket ever shipped.
 */
export function bracketMath(policy: BracketPolicy, observedWinRate: number | null): BracketMath {
  const loss = Math.abs(policy.stopPct);
  const target = policy.targetPct;
  if (target == null || !(loss > 0)) {
    return { riskRewardRatio: null, breakevenWinRate: null, impliedExpectancyPct: null, survivableAtWinRate: null };
  }
  const rr = round4(target / loss);
  const be = round4(loss / (target + loss));
  if (observedWinRate == null) return { riskRewardRatio: rr, breakevenWinRate: be, impliedExpectancyPct: null, survivableAtWinRate: null };
  const w = Math.min(1, Math.max(0, observedWinRate));
  const exp = round4(w * target - (1 - w) * loss);
  return { riskRewardRatio: rr, breakevenWinRate: be, impliedExpectancyPct: exp, survivableAtWinRate: exp > 0 };
}

// ── shadow simulation ──────────────────────────────────────────────────────

export interface MarkPoint {
  atMs: number;
  returnPct: number;
  /** Only independent observations may trigger an exit. */
  independent: boolean;
}

export type ShadowExitReason =
  | "TARGET_HIT" | "STOP_HIT" | "TIME_EXIT" | "TRAIL_EXIT" | "END_OF_SERIES" | "NO_USABLE_MARKS";

export interface ShadowOutcome {
  policyId: string;
  exitReason: ShadowExitReason;
  returnPct: number | null;
  exitAtMs: number | null;
  mfePct: number | null;
  /** How many independent observations the simulation could act on. */
  independentObservations: number;
  /** False when the series cannot support the policy's logic. */
  supported: boolean;
  note: string;
}

/**
 * Walk the mark series forward and exit at the first trigger.
 *
 * ONLY INDEPENDENT MARKS MAY TRIGGER. A carried-forward quote repeated across
 * horizons would otherwise "hit" a stop at an instant when no such price was
 * ever observed, manufacturing exits that never happened. A trailing policy
 * evaluated on one repeated mark is reported UNSUPPORTED rather than scored,
 * because a claim that trailing helps needs evidence that prices moved between
 * the marks.
 */
export function simulatePolicy(
  policy: BracketPolicy,
  entryAtMs: number,
  marks: readonly MarkPoint[],
): ShadowOutcome {
  const usable = marks.filter((m) => m.independent && Number.isFinite(m.returnPct)).sort((a, b) => a.atMs - b.atMs);
  const base = { policyId: policy.id, independentObservations: usable.length };

  if (usable.length === 0) {
    return { ...base, exitReason: "NO_USABLE_MARKS", returnPct: null, exitAtMs: null, mfePct: null, supported: false, note: "No independent marks; nothing can be simulated without inventing prices." };
  }
  const needsSeries = policy.trailGiveBackPts != null;
  if (needsSeries && usable.length < 2) {
    return { ...base, exitReason: "NO_USABLE_MARKS", returnPct: null, exitAtMs: null, mfePct: usable[0].returnPct, supported: false, note: "A trailing policy needs at least two independent observations to be meaningful." };
  }

  let peak = -Infinity;
  for (const m of usable) {
    if (m.returnPct > peak) peak = m.returnPct;
    const elapsedMin = (m.atMs - entryAtMs) / 60_000;

    // Precedence: stop, then target, then trail, then time. Stop first is the
    // conservative reading when one observation clears several levels at once —
    // it never credits a favourable fill that the same tick could contradict.
    if (m.returnPct <= policy.stopPct) return done("STOP_HIT", policy.stopPct, m.atMs);
    if (policy.targetPct != null && m.returnPct >= policy.targetPct) return done("TARGET_HIT", policy.targetPct, m.atMs);
    if (policy.trailGiveBackPts != null && policy.trailActivateAtPct != null
      && peak >= policy.trailActivateAtPct && (peak - m.returnPct) >= policy.trailGiveBackPts) {
      return done("TRAIL_EXIT", m.returnPct, m.atMs);
    }
    if (policy.timeExitMinutes != null && elapsedMin >= policy.timeExitMinutes) {
      return done("TIME_EXIT", m.returnPct, m.atMs);
    }
  }
  const last = usable[usable.length - 1];
  return done("END_OF_SERIES", last.returnPct, last.atMs);

  function done(exitReason: ShadowExitReason, returnPct: number, exitAtMs: number): ShadowOutcome {
    return {
      ...base, exitReason, returnPct: round4(returnPct), exitAtMs,
      mfePct: peak === -Infinity ? null : round4(peak),
      supported: true,
      note: `${exitReason} on an independent observation`,
    };
  }
}

export interface PolicyEvaluation {
  policyId: string;
  family: BracketFamily;
  count: number;
  supportedCount: number;
  winRate: number | null;
  medianReturnPct: number | null;
  expectancyPct: number | null;
  profitFactor: number | null;
  stopRate: number | null;
  targetHitRate: number | null;
  medianMfePct: number | null;
  medianGiveBackPts: number | null;
  math: BracketMath;
  /** Null when the sample is too small to support any claim. */
  sampleWarning: string | null;
  version: string;
}

/** Below this many supported simulations, no policy claim is made. */
export const MIN_POLICY_SAMPLE = 30;

/**
 * Score a policy over verified opportunities.
 *
 * Rows the policy could not simulate are EXCLUDED from the rates and counted in
 * `supportedCount`, never scored as zero. Scoring an unsimulatable row as flat
 * would make a policy look safer exactly where the evidence is weakest.
 */
export function evaluatePolicy(
  policy: BracketPolicy, outcomes: readonly ShadowOutcome[],
): PolicyEvaluation {
  const supported = outcomes.filter((o) => o.supported && o.returnPct != null);
  const rets = supported.map((o) => o.returnPct as number);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const winRate = rets.length ? round4(wins.length / rets.length) : null;
  const giveBacks = supported
    .map((o) => (o.mfePct != null && o.returnPct != null ? o.mfePct - o.returnPct : null))
    .filter((v): v is number => v != null);

  return {
    policyId: policy.id, family: policy.family,
    count: outcomes.length, supportedCount: supported.length,
    winRate,
    medianReturnPct: median(rets),
    expectancyPct: rets.length ? round4(rets.reduce((a, b) => a + b, 0) / rets.length) : null,
    profitFactor: grossLoss > 0 ? round4(grossWin / grossLoss) : null,
    stopRate: supported.length ? round4(supported.filter((o) => o.exitReason === "STOP_HIT").length / supported.length) : null,
    targetHitRate: supported.length ? round4(supported.filter((o) => o.exitReason === "TARGET_HIT").length / supported.length) : null,
    medianMfePct: median(supported.map((o) => o.mfePct).filter((v): v is number => v != null)),
    medianGiveBackPts: median(giveBacks),
    math: bracketMath(policy, winRate),
    sampleWarning: supported.length < MIN_POLICY_SAMPLE
      ? `Only ${supported.length} simulatable rows, below the ${MIN_POLICY_SAMPLE} minimum — descriptive only, not evidence for promotion.`
      : null,
    version: BRACKET_FRAMEWORK_VERSION,
  };
}

export type PromotionDecision = "PROMOTE_TO_FORWARD_TEST" | "RESEARCH_ONLY";

export interface PromotionResult {
  decision: PromotionDecision;
  policyId: string | null;
  rationale: string;
}

/**
 * Choose at most ONE policy for forward validation — or refuse.
 *
 * Refusing is the expected outcome while samples are small, and it is a
 * success, not a failure of the analysis. Promoting the best row of a
 * 30-row table is how the symmetric bracket was justified in the first place.
 */
export function selectForwardTestPolicy(
  evaluations: readonly PolicyEvaluation[],
  opts: { minSample?: number; requireIndependentMarks?: boolean; independentRate?: number | null } = {},
): PromotionResult {
  const minSample = opts.minSample ?? MIN_POLICY_SAMPLE;
  const indep = opts.independentRate ?? null;

  if (opts.requireIndependentMarks !== false && (indep == null || indep < 0.5)) {
    return {
      decision: "RESEARCH_ONLY", policyId: null,
      rationale: `Independent mark rate ${indep == null ? "unknown" : `${(indep * 100).toFixed(1)}%`} is below 50% — every simulated exit rests on carried-forward quotes, so no policy can be promoted.`,
    };
  }
  const eligible = evaluations.filter(
    (e) => e.supportedCount >= minSample && e.policyId !== "BASELINE_SYMMETRIC_45",
  );
  if (eligible.length === 0) {
    return { decision: "RESEARCH_ONLY", policyId: null, rationale: `No candidate reached the ${minSample}-row minimum on independent marks.` };
  }
  const positive = eligible.filter((e) => (e.profitFactor ?? 0) >= 1.0 && (e.expectancyPct ?? -1) > 0);
  if (positive.length === 0) {
    return { decision: "RESEARCH_ONLY", policyId: null, rationale: "No candidate achieved profit factor >= 1.0 with positive expectancy on verified rows." };
  }
  const best = positive.slice().sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))[0];
  return {
    decision: "PROMOTE_TO_FORWARD_TEST", policyId: best.policyId,
    rationale: `${best.policyId} reached PF ${best.profitFactor} with expectancy ${best.expectancyPct}% over ${best.supportedCount} simulatable verified rows. Forward validation resets to zero.`,
  };
}

function median(xs: readonly number[]): number | null {
  const s = xs.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return round4(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}
function round4(n: number): number { return Math.round(n * 10_000) / 10_000; }

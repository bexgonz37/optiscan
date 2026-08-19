/**
 * coverage.ts — Missed Opportunity V2: learning from a symbol OptiScan NEVER
 * OBSERVED.
 *
 * THE CIRCULARITY THIS BREAKS. The V1 forensic reconstructs exclusively from
 * OptiScan's own persisted decisions and NBBO, and its classifier gates
 * everything on `hadQuoteEvidence`:
 *
 *     if (!input.hadQuoteEvidence) return INSUFFICIENT_EVIDENCE;   // step 1
 *     ...
 *     if (!sawRegular && !sawAsymmetry) return OUTSIDE_DISCOVERY_UNIVERSE;  // step 2
 *
 * So `OUTSIDE_DISCOVERY_UNIVERSE` — the verdict that exists to name exactly this
 * failure — is UNREACHABLE for the symbols it describes, because reaching it
 * requires a quote the system never took. On 2026-08-19 the MRNA forensic
 * returned `evidenceQuality: NONE` — "the system never quoted one" — which is
 * true, and useless: the loop that exists to notice a giant miss could not
 * notice it, because noticing required having already looked.
 *
 * THE FIX IS A SECOND CLAIM, NOT A WEAKER ONE. Two different statements were
 * being conflated:
 *
 *   "OptiScan missed a verified +293% executable winner"
 *        — a claim about a FILL. Needs NBBO. Still gated exactly as before.
 *          Nothing in this module can produce it.
 *
 *   "OptiScan never observed the 5th largest mover in the market"
 *        — a claim about COVERAGE. Needs only market-state evidence, which
 *          `market_mover_observations` now holds independently of OptiScan's
 *          universe.
 *
 * A coverage case therefore carries NO executable return, keeps the verdict
 * `INSUFFICIENT_EVIDENCE`, and says so in its own note. It is not a smaller
 * winner claim; it is a different kind of fact, and blurring the two is exactly
 * what the agent's grading rule exists to prevent.
 *
 * MAKES NO PROVIDER CALL. Every input is a persisted row: the mover
 * observations written from the snapshot the scanner already paid for, and the
 * reconstruction, which reads OptiScan's own tables. That matters — this must
 * stay runnable while the minute cap is saturated, including when the thing
 * under investigation is whether the budget caused the miss.
 *
 * PURE classification; the DB read is a separate function below.
 */
import type { SymbolReconstruction } from "./reconstruct.ts";
import type { MoverObservationRow } from "../discovery/mover-store.ts";

/**
 * Where a market mover fell out of OptiScan, decided from coverage evidence
 * alone. Deliberately NOT merged into `MissedRootCause`: those values describe
 * why a VERIFIED winner was missed, and every one of them presumes evidence
 * this path does not have.
 */
export type CoverageOutcome =
  /** The market moved and OptiScan holds no observation of the symbol at all. */
  | "NOT_ADMITTED_TO_UNIVERSE"
  /** The underlying was observed, but no option on it was ever quoted. */
  | "ADMITTED_NOT_QUOTED"
  /** OptiScan observed it and quoted it — the V1 forensic is the right tool. */
  | "OBSERVED_BY_OPTISCAN"
  /** Not enough market-state evidence to say anything. */
  | "INSUFFICIENT_EVIDENCE";

/** How strong the COVERAGE evidence is. Never describes execution quality. */
export type CoverageEvidence = "MARKET_STATE_ONLY" | "MARKET_STATE_AND_SCANNER" | "NONE";

export interface CoverageInput {
  mover: MoverObservationRow;
  reconstruction: SymbolReconstruction;
  /** |peak move| a symbol must reach before a coverage gap is worth a case. */
  minPeakAbsMovePct: number;
}

export interface CoverageAssessment {
  symbol: string;
  sessionDate: string;
  outcome: CoverageOutcome;
  evidence: CoverageEvidence;
  /** When independent market-state discovery first saw it. NOT an OptiScan observation. */
  firstIndependentObservationAtMs: number;
  firstIndependentMovePct: number;
  firstObservedPhase: string;
  peakAbsMovePct: number;
  peakObservedAtMs: number;
  /** Did OptiScan's own lanes record ANY observation of this symbol? */
  admittedToUniverse: boolean;
  /** Did OptiScan ever quote an option on it? */
  everQuoted: boolean;
  /** Minutes between independent discovery and OptiScan's first observation. Null when never observed. */
  admissionLagMinutes: number | null;
  /**
   * ALWAYS NULL on this path, and present so the absence is explicit rather than
   * merely missing. A coverage case cannot quote an executable return: without
   * NBBO there is no fill to claim, and a claim about a print is not a result.
   */
  executableReturnPct: null;
  notes: string[];
}

const numOr = (v: unknown, d: number): number => (Number.isFinite(v as number) ? (v as number) : d);

/**
 * Classify one market mover against what OptiScan actually did with it. PURE.
 */
export function classifyCoverage(input: CoverageInput): CoverageAssessment {
  const { mover, reconstruction: rc } = input;
  const notes: string[] = [];

  const sawRegular = numOr(rc.regularScanner?.observationCount, 0) > 0;
  const sawAsymmetry = numOr(rc.highAsymmetry?.observationCount, 0) > 0;
  const admittedToUniverse = sawRegular || sawAsymmetry;

  // "Quoted" means a contract was actually selected or considered — the thing
  // that would have produced NBBO. An observation of the UNDERLYING is not it.
  const everQuoted = Boolean(
    rc.regularScanner?.selectedOcc
    || (rc.regularScanner?.consideredOccs?.length ?? 0) > 0
    || rc.highAsymmetry?.selectedOcc
    || (rc.highAsymmetry?.consideredOccs?.length ?? 0) > 0,
  );

  const firstOptiscanSeenAtMs = [
    rc.regularScanner?.firstSeenAtMs ?? null,
    rc.highAsymmetry?.firstSeenAtMs ?? null,
  ].filter((v): v is number => Number.isFinite(v as number)).sort((a, b) => a - b)[0] ?? null;

  const admissionLagMinutes = firstOptiscanSeenAtMs == null
    ? null
    : +((firstOptiscanSeenAtMs - mover.firstObservedAtMs) / 60_000).toFixed(2);

  let outcome: CoverageOutcome;
  if (mover.peakAbsMovePct < input.minPeakAbsMovePct) {
    outcome = "INSUFFICIENT_EVIDENCE";
    notes.push(
      `Peak move ${mover.peakAbsMovePct.toFixed(1)}% is below the ${input.minPeakAbsMovePct}% coverage floor — not treated as a gap.`,
    );
  } else if (!admittedToUniverse) {
    outcome = "NOT_ADMITTED_TO_UNIVERSE";
    notes.push(
      `Independent market-state discovery first saw ${mover.symbol} at ${mover.firstMovePct >= 0 ? "+" : ""}${mover.firstMovePct.toFixed(1)}% `
      + `during ${mover.firstObservedPhase} and it peaked at ${mover.peakAbsMovePct.toFixed(1)}%, `
      + `on $${(mover.dollarVolume / 1e6).toFixed(0)}M. OptiScan recorded no observation of it in any lane.`,
    );
    notes.push("This is a COVERAGE gap, not a rejection: nothing in the system ever had the chance to judge it.");
  } else if (!everQuoted) {
    outcome = "ADMITTED_NOT_QUOTED";
    notes.push(
      `OptiScan observed the underlying${firstOptiscanSeenAtMs != null ? ` (first at ${new Date(firstOptiscanSeenAtMs).toISOString()})` : ""} `
      + "but never evaluated a contract on it, so no NBBO exists and no executable claim is possible.",
    );
  } else {
    outcome = "OBSERVED_BY_OPTISCAN";
    notes.push("OptiScan observed and quoted this symbol — the V1 forensic can grade it on NBBO.");
  }

  const evidence: CoverageEvidence = outcome === "INSUFFICIENT_EVIDENCE"
    ? "NONE"
    : admittedToUniverse ? "MARKET_STATE_AND_SCANNER" : "MARKET_STATE_ONLY";

  notes.push(
    "No executable return is quoted on this path. A coverage case says what the MARKET did and what OptiScan "
    + "saw; it never claims what a fill would have paid.",
  );

  return {
    symbol: mover.symbol,
    sessionDate: mover.sessionDate,
    outcome,
    evidence,
    firstIndependentObservationAtMs: mover.firstObservedAtMs,
    firstIndependentMovePct: mover.firstMovePct,
    firstObservedPhase: mover.firstObservedPhase,
    peakAbsMovePct: mover.peakAbsMovePct,
    peakObservedAtMs: mover.peakObservedAtMs,
    admittedToUniverse,
    everQuoted,
    admissionLagMinutes,
    executableReturnPct: null,
    notes,
  };
}

export interface CoverageSweepResult {
  sessionDate: string;
  /** Movers considered, from the independent source. */
  moversConsidered: number;
  assessments: CoverageAssessment[];
  tally: Record<CoverageOutcome, number>;
}

/**
 * Assess every independently-discovered mover for a session.
 *
 * `listMovers` and `reconstruct` are injected so this stays testable and so the
 * module does not acquire a database import. Both are DB-only; this function
 * makes NO provider call.
 */
export function runCoverageSweep(deps: {
  sessionDate: string;
  listMovers: () => MoverObservationRow[];
  reconstruct: (symbol: string) => SymbolReconstruction;
  minPeakAbsMovePct?: number;
}): CoverageSweepResult {
  const minPeakAbsMovePct = numOr(deps.minPeakAbsMovePct, 25);
  const movers = deps.listMovers();
  const tally: Record<CoverageOutcome, number> = {
    NOT_ADMITTED_TO_UNIVERSE: 0,
    ADMITTED_NOT_QUOTED: 0,
    OBSERVED_BY_OPTISCAN: 0,
    INSUFFICIENT_EVIDENCE: 0,
  };
  const assessments: CoverageAssessment[] = [];
  for (const mover of movers) {
    try {
      const a = classifyCoverage({
        mover,
        reconstruction: deps.reconstruct(mover.symbol),
        minPeakAbsMovePct,
      });
      assessments.push(a);
      tally[a.outcome] += 1;
    } catch {
      /* one bad symbol must not lose the sweep */
    }
  }
  return { sessionDate: deps.sessionDate, moversConsidered: movers.length, assessments, tally };
}

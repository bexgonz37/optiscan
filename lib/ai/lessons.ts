/**
 * ai/lessons.ts — PURE derivation of candidate lessons from a deterministic
 * nightly summary. A candidate lesson is created ONLY when a real evidence
 * threshold is met (never every night for noise), and each carries a STABLE
 * dedup_key so a repeated finding updates one lesson instead of spawning
 * near-duplicates. The LLM is not involved in creating lessons — they are
 * deterministic, evidence-gated facts.
 */
import type { NightlySummary } from "./nightly-summary.ts";
import type { LessonInput } from "./store.ts";

export interface LessonDerivationOpts {
  /** Minimum supporting count before a finding becomes a candidate lesson. */
  minSample?: number;
}

/** Deterministic confidence tier from a supporting sample size. */
function confidenceFor(n: number): string {
  if (n >= 15) return "HIGH";
  if (n >= 6) return "MEDIUM";
  return "LOW";
}

/**
 * Derive candidate lessons from a nightly summary. Returns LessonInput rows
 * (without source/nowMs, which the caller fills). Empty when no threshold is met.
 */
export function deriveCandidateLessons(summary: NightlySummary, opts: LessonDerivationOpts = {}): LessonInput[] {
  const minSample = Math.max(1, Math.floor(opts.minSample ?? 3));
  const day = summary.tradingDay;
  const out: LessonInput[] = [];

  // 1. Signal correct but exit management failed.
  if (summary.signalCorrectExitFailed >= minSample) {
    const n = summary.signalCorrectExitFailed;
    out.push({
      dedupKey: "exit_management|all|all|all",
      findingType: "exit_management",
      title: "Winning setups given back by exit management",
      summary: `${n} trades reached a profit opportunity (opportunity HIT) but were managed to a non-win. Exit management, not signal quality, is the leak.`,
      evidence: { signalCorrectExitFailed: n, opportunityGrade: summary.opportunityGrade, realizedGrade: summary.realizedGrade },
      sampleSize: n,
      affectedStrategy: null,
      affectedSession: null,
      affectedDuration: null,
      dateRangeStart: day,
      dateRangeEnd: day,
      confidence: confidenceFor(n),
    });
  }

  // 2. Signal quality — ONLY for losses that never traded above entry. A trade that
  // ran to +12% before closing red is an exit defect, not a signal defect, so it gets
  // its own lesson below instead of being folded into "never worked".
  if ((summary.neverProfitable ?? 0) >= minSample) {
    const n = summary.neverProfitable ?? 0;
    out.push({
      dedupKey: "signal_quality|all|all|all",
      findingType: "signal_quality",
      title: "Setups that never traded above entry and lost",
      summary: `${n} trades never traded above their entry price and closed at a loss. Signal quality (not exit) is the leak here.`,
      evidence: {
        neverProfitable: n,
        profitableThenLost: summary.profitableThenLost ?? 0,
        lossesWithoutExcursionEvidence: summary.lossesWithoutExcursionEvidence ?? 0,
        opportunityGrade: summary.opportunityGrade,
        realizedGrade: summary.realizedGrade,
      },
      sampleSize: n,
      dateRangeStart: day,
      dateRangeEnd: day,
      confidence: confidenceFor(n),
    });
  }

  // 2b. Losses that WERE profitable at some point — an exit/profit-protection leak.
  if ((summary.profitableThenLost ?? 0) >= minSample) {
    const n = summary.profitableThenLost ?? 0;
    out.push({
      dedupKey: "profit_giveback|all|all|all",
      findingType: "exit_management",
      title: "Trades that traded above entry and still closed red",
      summary: `${n} losing trades traded above their entry price before closing red. The setups worked; the exits did not protect them.`,
      evidence: {
        profitableThenLost: n,
        neverProfitable: summary.neverProfitable ?? 0,
        realizedGrade: summary.realizedGrade,
      },
      sampleSize: n,
      dateRangeStart: day,
      dateRangeEnd: day,
      confidence: confidenceFor(n),
    });
  }

  // 3. A dominant rejection reason (liquidity / contract data / other).
  const topReason = Object.entries(summary.rejectionReasons).sort((a, b) => b[1] - a[1])[0];
  if (topReason && topReason[1] >= minSample) {
    const [reason, n] = topReason;
    const isLiquidity = /spread|liquid|quote|nbbo|bid|ask|wide/i.test(reason);
    const isContract = /contract|occ|symbol|strike|expiration|incomplete/i.test(reason);
    const findingType = isLiquidity ? "liquidity_reject" : isContract ? "contract_data" : "rejection_pattern";
    out.push({
      dedupKey: `${findingType}|all|all|all`,
      findingType,
      title: `Repeated callout rejection: ${reason}`.slice(0, 90),
      summary: `${n} callouts were rejected for "${reason}". A recurring gate is filtering setups here.`,
      evidence: { reason, count: n, rejectionReasons: summary.rejectionReasons },
      sampleSize: n,
      dateRangeStart: day,
      dateRangeEnd: day,
      confidence: confidenceFor(n),
    });
  }

  return out;
}

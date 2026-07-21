/**
 * lib/research/analog/report.ts — the durable, versioned Phase-D evidence report + the
 * GO / REMEDIATE / STOP verdict (Analog Engine, Phase D). PURE assembler + OnDb persist.
 *
 * Honesty rules baked into the verdict:
 *   • A survivorship-biased universe can NEVER issue GO — it is marked EXPLORATORY_ONLY.
 *   • GO requires beating EVERY baseline out-of-sample (CI-significant), acceptable
 *     calibration, and non-trivial coverage — otherwise REMEDIATE or STOP.
 *   • Synthetic-only results are never GO (the caller sets datasetKind).
 */

export type DatasetKind = "real_seeded" | "survivorship_fallback" | "synthetic";
export type Verdict = "GO" | "REMEDIATE" | "STOP" | "EXPLORATORY_ONLY";

export interface BaselineOutcome { baseline: string; liftPoint: number; liftLo: number; liftHi: number; significant: boolean }

export interface PhaseDReportInput {
  datasetKind: DatasetKind;
  provenance: { universeSource: string; survivorshipBias: boolean; corporateActionAdjusted: boolean };
  dateFrom: string; dateTo: string;
  episodeCount: number; excludedCount: number; rejectedCount: number;
  missingFeatureRates: Record<string, number>;
  trainTestWindows: number; embargoMs: number;
  candidate: { name: string; expectancy: number; hitRate: number; brier: number; ece: number; coverage: number; abstentionRate: number; nOos: number };
  baselines: BaselineOutcome[];
  transactionCostAssumptions: string;
  modeledOutcomeShare: number;   // fraction of outcomes that are MODELED vs observed
  minCoverage?: number; maxEce?: number;
}

export interface PhaseDReport extends PhaseDReportInput {
  reportVersion: number;
  acceptance: { criterion: string; pass: boolean; detail: string }[];
  verdict: Verdict;
  verdictReason: string;
  generatedAtMs: number;
}

const REPORT_VERSION = 1;

export function buildPhaseDReport(input: PhaseDReportInput, nowMs: number = Date.now()): PhaseDReport {
  const minCoverage = input.minCoverage ?? 0.02;
  const maxEce = input.maxEce ?? 0.1;
  const beatsAll = input.baselines.length > 0 && input.baselines.every((b) => b.significant);
  const beatsRandom = input.baselines.find((b) => b.baseline === "random")?.significant ?? false;
  const calibrated = input.candidate.ece <= maxEce;
  const covers = input.candidate.coverage >= minCoverage;

  const acceptance = [
    { criterion: "beats every baseline OOS (CI-significant)", pass: beatsAll, detail: `${input.baselines.filter((b) => b.significant).length}/${input.baselines.length} baselines beaten` },
    { criterion: "beats random OOS", pass: beatsRandom, detail: `random lift significant=${beatsRandom}` },
    { criterion: `calibration ECE <= ${maxEce}`, pass: calibrated, detail: `ece=${input.candidate.ece}` },
    { criterion: `coverage >= ${minCoverage}`, pass: covers, detail: `coverage=${input.candidate.coverage}, abstention=${input.candidate.abstentionRate}` },
    { criterion: "universe is survivorship-free", pass: !input.provenance.survivorshipBias, detail: input.provenance.universeSource },
  ];

  let verdict: Verdict, verdictReason: string;
  if (input.datasetKind !== "real_seeded" || input.provenance.survivorshipBias) {
    verdict = "EXPLORATORY_ONLY";
    verdictReason = input.datasetKind === "synthetic"
      ? "synthetic data — not evidence of real-market edge; cannot GO"
      : "survivorship-biased or non-real universe — cannot issue a GO verdict";
  } else if (beatsAll && calibrated && covers) {
    verdict = "GO";
    verdictReason = "beat every baseline out-of-sample with acceptable calibration and coverage on a real, survivorship-free library";
  } else if (beatsRandom) {
    // There IS out-of-sample lift, but some gate (all-baselines / calibration / coverage) is not
    // yet cleared — promising, but must be remediated, not shipped and not abandoned.
    verdict = "REMEDIATE";
    const gaps = [!beatsAll ? "not beating every baseline" : null, !calibrated ? `calibration ECE ${input.candidate.ece} > ${maxEce}` : null, !covers ? `coverage ${input.candidate.coverage} < ${minCoverage}` : null].filter(Boolean).join("; ");
    verdictReason = `out-of-sample lift present but a gate is unmet (${gaps}) — run the bounded remediation cycle, do NOT tune to a positive backtest`;
  } else {
    verdict = "STOP";
    verdictReason = "no out-of-sample lift over baselines — diagnose leakage / episode quality / features / similarity / sampling; do not proceed";
  }

  return { ...input, reportVersion: REPORT_VERSION, acceptance, verdict, verdictReason, generatedAtMs: nowMs };
}

interface ReportDb { prepare(sql: string): { run: (...a: any[]) => { changes: number } } }

/** Persist a versioned report (idempotent per reportId). */
export function persistPhaseDReportOnDb(db: ReportDb, reportId: string, report: PhaseDReport, nowMs: number = Date.now()): void {
  db.prepare(
    `INSERT OR IGNORE INTO analog_eval_reports (report_id, report_version, dataset_kind, verdict, verdict_reason, universe_source, survivorship_bias, date_from, date_to, episode_count, report_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(reportId, report.reportVersion, report.datasetKind, report.verdict, report.verdictReason, report.provenance.universeSource, report.provenance.survivorshipBias ? 1 : 0, report.dateFrom, report.dateTo, report.episodeCount, JSON.stringify(report), nowMs);
}

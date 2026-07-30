/**
 * High-Asymmetry Radar — candidate identity and duplicate-detection audit. PURE.
 *
 * Phase 1 grouped observations by exact OCC and treated the FIRST observation
 * of a contract as the candidate. That is a real choice with real consequences,
 * and this module exists to measure them rather than assume them:
 *
 *  - The scanner re-observes a contract on every tick while it stays a
 *    candidate, so one OCC routinely carries many observations in a session.
 *  - If those observations form several clusters separated by a long quiet gap,
 *    OCC grouping collapses what may be genuinely separate setups into one.
 *  - Because the first observation is BOTH the candidate and the earliest quote
 *    available to anchor premium chase, the Phase 1 identity makes the chase
 *    measurement structurally vacuous (always 0% or UNKNOWN).
 *
 * The audit reports cluster counts at several gap widths rather than picking
 * one, so the finding is a sensitivity curve and not a tuned threshold. The
 * default identity is DELIBERATELY UNCHANGED until real data supports changing
 * it; alternatives are available but must be selected explicitly.
 */
import type { AsymmetryObservationRow } from "./db-read.ts";

export type CandidateIdentityStrategy =
  /** Phase 1 default: one candidate per exact OCC per session, first sighting. */
  | "OCC_SESSION_FIRST_OBSERVATION"
  /** One candidate per detection cluster: OCC + session + bounded quiet gap. */
  | "OCC_SESSION_CLUSTER"
  /** One candidate per persisted thesis fingerprint on that OCC and session. */
  | "OCC_SESSION_FINGERPRINT";

export const CANDIDATE_IDENTITY_STRATEGIES: CandidateIdentityStrategy[] = [
  "OCC_SESSION_FIRST_OBSERVATION", "OCC_SESSION_CLUSTER", "OCC_SESSION_FINGERPRINT",
];

/** Gap widths the audit reports, so no single value is privileged. */
export const CLUSTER_GAP_PROBES_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000] as const;
/** Default gap used only when a caller explicitly selects the cluster strategy. */
export const DEFAULT_CLUSTER_GAP_MS = 15 * 60_000;

export interface CandidateGroup {
  key: string;
  occSymbol: string;
  strategy: CandidateIdentityStrategy;
  rows: AsymmetryObservationRow[];
}

const occOf = (row: AsymmetryObservationRow): string => String(row.occSymbolRaw ?? "").trim().toUpperCase();

/** Groups observations by exact OCC, preserving time order within each group. */
function byOcc(rows: AsymmetryObservationRow[]): Map<string, AsymmetryObservationRow[]> {
  const map = new Map<string, AsymmetryObservationRow[]>();
  for (const row of rows) {
    const occSymbol = occOf(row);
    if (!occSymbol || row.observedAtMs == null) continue;
    const bucket = map.get(occSymbol) ?? [];
    bucket.push(row);
    map.set(occSymbol, bucket);
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => (a.observedAtMs as number) - (b.observedAtMs as number) || (a.id ?? 0) - (b.id ?? 0));
  }
  return map;
}

/** Splits time-ordered rows wherever the quiet gap exceeds `gapMs`. */
export function splitIntoClusters(rows: AsymmetryObservationRow[], gapMs: number): AsymmetryObservationRow[][] {
  const clusters: AsymmetryObservationRow[][] = [];
  let current: AsymmetryObservationRow[] = [];
  let previousAtMs: number | null = null;
  for (const row of rows) {
    const atMs = row.observedAtMs;
    if (atMs == null) continue;
    if (previousAtMs != null && atMs - previousAtMs > gapMs) {
      clusters.push(current);
      current = [];
    }
    current.push(row);
    previousAtMs = atMs;
  }
  if (current.length) clusters.push(current);
  return clusters;
}

/**
 * Produces candidate groups under the requested identity.
 * Deterministic: the same rows always produce the same groups in the same order.
 */
export function groupCandidates(
  rows: AsymmetryObservationRow[],
  opts: { strategy?: CandidateIdentityStrategy; clusterGapMs?: number } = {},
): CandidateGroup[] {
  const strategy = opts.strategy ?? "OCC_SESSION_FIRST_OBSERVATION";
  const gapMs = Number.isFinite(opts.clusterGapMs) ? Number(opts.clusterGapMs) : DEFAULT_CLUSTER_GAP_MS;
  const grouped = byOcc(rows);
  const groups: CandidateGroup[] = [];

  for (const [occSymbol, bucket] of grouped) {
    if (strategy === "OCC_SESSION_FIRST_OBSERVATION") {
      groups.push({ key: occSymbol, occSymbol, strategy, rows: bucket });
      continue;
    }
    if (strategy === "OCC_SESSION_CLUSTER") {
      splitIntoClusters(bucket, gapMs).forEach((cluster, index) => {
        groups.push({ key: `${occSymbol}#c${index}`, occSymbol, strategy, rows: cluster });
      });
      continue;
    }
    // OCC_SESSION_FINGERPRINT — rows with no persisted fingerprint cannot be
    // split by one, so they stay together under an explicit "no fingerprint"
    // key rather than being invented an identity.
    const byFingerprint = new Map<string, AsymmetryObservationRow[]>();
    for (const row of bucket) {
      const fingerprint = row.thesisFingerprint ?? "NO_FINGERPRINT";
      const list = byFingerprint.get(fingerprint) ?? [];
      list.push(row);
      byFingerprint.set(fingerprint, list);
    }
    for (const [fingerprint, list] of byFingerprint) {
      groups.push({ key: `${occSymbol}#${fingerprint}`, occSymbol, strategy, rows: list });
    }
  }

  // Stable ordering by first observation, then key.
  return groups.sort((a, b) =>
    (a.rows[0]?.observedAtMs ?? 0) - (b.rows[0]?.observedAtMs ?? 0) || a.key.localeCompare(b.key));
}

export interface ContractClusterAudit {
  occSymbol: string;
  symbol: string;
  sessionDate: string | null;
  observationCount: number;
  firstObservedAtMs: number | null;
  lastObservedAtMs: number | null;
  spanMs: number | null;
  /** Gap width (ms, as a string key) → number of clusters at that width. */
  clusterCountByGapMs: Record<string, number>;
  /** Quiet gaps between consecutive observations, descending, capped at 10. */
  largestGapsMs: number[];
  distinctCandidateStates: string[];
  distinctThesisFingerprints: number;
  rowsWithFingerprint: number;
  /** True when ANY probed gap width yields more than one cluster. */
  collapsesMultipleClusters: boolean;
}

export type IdentityRecommendation =
  | "KEEP_OCC_SESSION_FIRST_OBSERVATION"
  | "ADOPT_OCC_SESSION_FINGERPRINT"
  | "ADOPT_OCC_SESSION_CLUSTER"
  | "INSUFFICIENT_EVIDENCE";

export interface DuplicateDetectionAudit {
  advisoryOnly: true;
  productionBehaviorChanged: false;
  contractsExamined: number;
  contractsWithMultipleObservations: number;
  /** Contracts whose observations form >1 cluster at the given gap width. */
  contractsWithMultipleClustersByGapMs: Record<string, number>;
  contractsWithMultipleFingerprints: number;
  rowsCarryingFingerprint: number;
  totalRows: number;
  /** Candidate counts each strategy would produce over the same rows. */
  candidateCountByStrategy: Record<CandidateIdentityStrategy, number>;
  /**
   * Under the Phase 1 identity the candidate quote IS the earliest quote, so
   * premium chase can only ever be 0% or UNKNOWN. Counted explicitly.
   */
  candidatesWithVacuousPremiumChase: number;
  contracts: ContractClusterAudit[];
  recommendation: IdentityRecommendation;
  recommendationReason: string;
  notes: string[];
}

/**
 * Measures whether one OCC can represent several genuinely separate setups in
 * one session, and what each identity strategy would cost or recover.
 */
export function auditDetectionClusters(
  rows: AsymmetryObservationRow[],
  opts: { detailLimit?: number } = {},
): DuplicateDetectionAudit {
  const detailLimit = Math.max(1, Math.min(200, opts.detailLimit ?? 50));
  const grouped = byOcc(rows);

  const contracts: ContractClusterAudit[] = [];
  for (const [occSymbol, bucket] of grouped) {
    const times = bucket.map((row) => row.observedAtMs as number);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1]);
    const fingerprints = new Set(bucket.map((row) => row.thesisFingerprint).filter((f): f is string => f != null));

    const clusterCountByGapMs: Record<string, number> = {};
    for (const gapMs of CLUSTER_GAP_PROBES_MS) {
      clusterCountByGapMs[String(gapMs)] = splitIntoClusters(bucket, gapMs).length;
    }

    contracts.push({
      occSymbol,
      symbol: bucket[0]?.symbol ?? "",
      sessionDate: bucket[0]?.sessionDate ?? null,
      observationCount: bucket.length,
      firstObservedAtMs: times[0] ?? null,
      lastObservedAtMs: times[times.length - 1] ?? null,
      spanMs: times.length > 1 ? times[times.length - 1] - times[0] : null,
      clusterCountByGapMs,
      largestGapsMs: [...gaps].sort((a, b) => b - a).slice(0, 10),
      distinctCandidateStates: [...new Set(bucket.map((row) => row.candidateState).filter((s): s is string => s != null))].sort(),
      distinctThesisFingerprints: fingerprints.size,
      rowsWithFingerprint: bucket.filter((row) => row.thesisFingerprint != null).length,
      collapsesMultipleClusters: Object.values(clusterCountByGapMs).some((count) => count > 1),
    });
  }

  const contractsWithMultipleClustersByGapMs: Record<string, number> = {};
  for (const gapMs of CLUSTER_GAP_PROBES_MS) {
    contractsWithMultipleClustersByGapMs[String(gapMs)] =
      contracts.filter((contract) => contract.clusterCountByGapMs[String(gapMs)] > 1).length;
  }

  const candidateCountByStrategy = Object.fromEntries(
    CANDIDATE_IDENTITY_STRATEGIES.map((strategy) => [strategy, groupCandidates(rows, { strategy }).length]),
  ) as Record<CandidateIdentityStrategy, number>;

  const rowsCarryingFingerprint = rows.filter((row) => row.thesisFingerprint != null).length;
  const contractsWithMultipleFingerprints = contracts.filter((c) => c.distinctThesisFingerprints > 1).length;

  // Phase 1 identity: candidate = first observation, so the only quotes at or
  // before it are its own. Every such candidate has a vacuous chase figure.
  const candidatesWithVacuousPremiumChase = groupCandidates(rows, { strategy: "OCC_SESSION_FIRST_OBSERVATION" })
    .filter((group) => {
      const firstAtMs = group.rows[0]?.observedAtMs;
      if (firstAtMs == null) return false;
      return !group.rows.some((row) => row.observedAtMs != null && row.observedAtMs < firstAtMs);
    }).length;

  const { recommendation, recommendationReason } = recommendIdentity({
    contractsExamined: contracts.length,
    contractsWithMultipleClustersByGapMs,
    contractsWithMultipleFingerprints,
    rowsCarryingFingerprint,
    totalRows: rows.length,
  });

  return {
    advisoryOnly: true,
    productionBehaviorChanged: false,
    contractsExamined: contracts.length,
    contractsWithMultipleObservations: contracts.filter((c) => c.observationCount > 1).length,
    contractsWithMultipleClustersByGapMs,
    contractsWithMultipleFingerprints,
    rowsCarryingFingerprint,
    totalRows: rows.length,
    candidateCountByStrategy,
    candidatesWithVacuousPremiumChase,
    contracts: contracts
      .sort((a, b) => b.observationCount - a.observationCount || a.occSymbol.localeCompare(b.occSymbol))
      .slice(0, detailLimit),
    recommendation,
    recommendationReason,
    notes: [
      "Cluster counts are reported at several gap widths so the result is a sensitivity curve, not a tuned threshold.",
      "The active identity is unchanged. An alternative strategy must be selected explicitly by a caller.",
      "Under OCC_SESSION_FIRST_OBSERVATION the candidate quote is also the earliest quote, so premium chase is structurally 0% or UNKNOWN.",
      "thesis_fingerprint is written by the delivery path only; candidate-lifecycle observations persist it as NULL.",
    ],
  };
}

/**
 * Recommends an identity from measured evidence alone. With no rows there is
 * nothing to recommend, and it says so rather than defaulting to an opinion.
 */
export function recommendIdentity(input: {
  contractsExamined: number;
  contractsWithMultipleClustersByGapMs: Record<string, number>;
  contractsWithMultipleFingerprints: number;
  rowsCarryingFingerprint: number;
  totalRows: number;
}): { recommendation: IdentityRecommendation; recommendationReason: string } {
  if (input.totalRows === 0 || input.contractsExamined === 0) {
    return {
      recommendation: "INSUFFICIENT_EVIDENCE",
      recommendationReason: "No persisted observations were available, so no identity can be justified by evidence.",
    };
  }
  if (input.contractsWithMultipleFingerprints > 0) {
    return {
      recommendation: "ADOPT_OCC_SESSION_FINGERPRINT",
      recommendationReason: `${input.contractsWithMultipleFingerprints} contract(s) carry more than one persisted thesis fingerprint, which is direct evidence that one OCC represented separate setups.`,
    };
  }
  const widest = String(CLUSTER_GAP_PROBES_MS[CLUSTER_GAP_PROBES_MS.length - 1]);
  const splitAtWidest = input.contractsWithMultipleClustersByGapMs[widest] ?? 0;
  if (splitAtWidest > 0) {
    return {
      recommendation: "ADOPT_OCC_SESSION_CLUSTER",
      recommendationReason: `${splitAtWidest} contract(s) still form separate detection clusters at a ${Number(widest) / 60_000}-minute quiet gap, and no thesis fingerprint is available to separate them.`,
    };
  }
  if (input.rowsCarryingFingerprint === 0) {
    return {
      recommendation: "KEEP_OCC_SESSION_FIRST_OBSERVATION",
      recommendationReason: "No contract split into multiple clusters at any probed gap, and no fingerprint evidence exists to justify a finer identity.",
    };
  }
  return {
    recommendation: "KEEP_OCC_SESSION_FIRST_OBSERVATION",
    recommendationReason: "Every contract formed a single detection cluster and carried at most one thesis fingerprint.",
  };
}

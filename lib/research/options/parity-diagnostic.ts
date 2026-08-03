/**
 * parity-diagnostic.ts — compare the two verifiers over ONE shared keyed
 * population, and explain every row that fails delivery proof. PURE.
 *
 * WHY AGGREGATE CLOSENESS IS NOT PARITY. Checkpoint 3 brought Quant Lab from
 * 276 verified to 85 against paper-chain's 82 — a headline gap of 3. That
 * proves nothing: the two systems evaluate DIFFERENT populations (357 exited
 * paper trades vs 553 alert-oriented rows), so 85 and 82 could disagree on
 * dozens of individual rows and still land three apart. Parity is a row-by-row
 * property; `compareKeyedParity` refuses to infer it from totals.
 *
 * THE POPULATION MUST BE DEFINED, NOT ASSUMED. Rows present on one side only
 * are POPULATION_ONLY_* and are never counted as agreement or disagreement —
 * they are a population-definition finding, which needs a different fix from a
 * classification finding.
 */
import type { VerificationStatus } from "./verification-contract.ts";

export const PARITY_DIAGNOSTIC_VERSION = "PARITY_V1" as const;

/** Key precedence. The first non-null wins, and the choice is reported. */
export type KeyKind = "OPPORTUNITY_CASE_ID" | "OPTIONS_ALERT_ID" | "PAPER_POSITION_ID" | "OCC_SESSION_FALLBACK";

export const KEY_PRECEDENCE: readonly KeyKind[] = Object.freeze([
  "OPPORTUNITY_CASE_ID", "OPTIONS_ALERT_ID", "PAPER_POSITION_ID", "OCC_SESSION_FALLBACK",
]);

export interface KeyParts {
  opportunityCaseId?: string | null;
  optionsAlertId?: string | null;
  paperPositionId?: string | number | null;
  occ?: string | null;
  sessionDate?: string | null;
  thesisLane?: string | null;
}

export interface CanonicalKey {
  key: string;
  kind: KeyKind | null;
  /** True when the fallback was used — documented, never silent. */
  usedFallback: boolean;
}

/**
 * Build the canonical key. The OCC+session fallback is DOCUMENTED as a fallback
 * because it can collide: two positions on the same contract in the same
 * session share it. It is used only when no identifier exists.
 */
export function canonicalKey(parts: KeyParts): CanonicalKey {
  const s = (v: unknown): string | null => {
    const t = String(v ?? "").trim();
    return t ? t : null;
  };
  const oc = s(parts.opportunityCaseId);
  if (oc) return { key: `oc:${oc}`, kind: "OPPORTUNITY_CASE_ID", usedFallback: false };
  const al = s(parts.optionsAlertId);
  if (al) return { key: `al:${al}`, kind: "OPTIONS_ALERT_ID", usedFallback: false };
  const pp = s(parts.paperPositionId);
  if (pp) return { key: `pp:${pp}`, kind: "PAPER_POSITION_ID", usedFallback: false };
  const occ = s(parts.occ), sd = s(parts.sessionDate);
  if (occ && sd) {
    return { key: `occ:${occ.toUpperCase()}|${sd}|${s(parts.thesisLane) ?? "NA"}`, kind: "OCC_SESSION_FALLBACK", usedFallback: true };
  }
  return { key: "", kind: null, usedFallback: false };
}

export type MismatchCategory =
  | "STATUS_MISMATCH"
  | "DELIVERY_PROOF_MISMATCH"
  | "ENTRY_PROOF_MISMATCH"
  | "EXIT_PROOF_MISMATCH"
  | "OCC_MISMATCH"
  | "DUPLICATE_MISMATCH"
  | "MIRROR_MISMATCH"
  | "AUDIT_ONLY_MISMATCH"
  | "SESSION_MISMATCH"
  | "POPULATION_ONLY_QUANT"
  | "POPULATION_ONLY_PAPER_CHAIN"
  | "LEGACY_UNLINKABLE"
  | "OTHER_PROVEN_REASON";

export interface ParityRow {
  key: string;
  keyKind: KeyKind | null;
  optionsAlertId: string | null;
  opportunityCaseId: string | null;
  paperPositionId: string | null;
  occ: string | null;
  sessionDate: string | null;
  quantLabStatus: VerificationStatus | null;
  paperChainStatus: VerificationStatus | null;
  quantLabReasons: string[];
  paperChainReasons: string[];
  matches: boolean;
  mismatchCategory: MismatchCategory | null;
}

/**
 * Which kind of disagreement this is. Naming the AXIS matters: a delivery-proof
 * disagreement and an exit-proof disagreement have different fixes, and lumping
 * both into STATUS_MISMATCH hides which subsystem to look at.
 */
export function categorizeMismatch(
  ql: VerificationStatus | null, pc: VerificationStatus | null,
): MismatchCategory | null {
  if (ql == null && pc == null) return null;
  if (pc == null) return "POPULATION_ONLY_QUANT";
  if (ql == null) return "POPULATION_ONLY_PAPER_CHAIN";
  if (ql === pc) return null;
  const pair = new Set([ql, pc]);
  if (pair.has("UNVERIFIED_DELIVERY")) return "DELIVERY_PROOF_MISMATCH";
  if (pair.has("UNVERIFIED_ENTRY")) return "ENTRY_PROOF_MISMATCH";
  if (pair.has("UNVERIFIED_EXIT")) return "EXIT_PROOF_MISMATCH";
  if (pair.has("WRONG_OCC")) return "OCC_MISMATCH";
  if (pair.has("DUPLICATE")) return "DUPLICATE_MISMATCH";
  if (pair.has("MISSING_MIRROR")) return "MIRROR_MISMATCH";
  if (pair.has("AUDIT_ONLY")) return "AUDIT_ONLY_MISMATCH";
  if (pair.has("SESSION_INVALID")) return "SESSION_MISMATCH";
  return "STATUS_MISMATCH";
}

export type ParityStatus = "ACHIEVED" | "EXPLAINED_DIFFERENCE" | "NOT_ACHIEVED" | "NOT_COMPARABLE";

export interface KeyedParityReport {
  version: string;
  parityStatus: ParityStatus;
  sharedPopulationCount: number;
  matchingCount: number;
  mismatchCount: number;
  matchPct: number | null;
  quantOnlyCount: number;
  paperChainOnlyCount: number;
  quantLabVerifiedCount: number;
  paperChainVerifiedCount: number;
  /** Rows verified in one system and excluded in the other. Must be 0 for ACHIEVED. */
  disagreeOnVerified: number;
  mismatchReasons: Array<{ category: MismatchCategory; quantLab: string; paperChain: string; count: number; sampleKeys: string[] }>;
  keyKinds: Record<string, number>;
  fallbackKeyCount: number;
  note: string;
}

/**
 * Row-by-row parity over the SHARED population.
 *
 * ACHIEVED requires every shared row to agree exactly. EXPLAINED_DIFFERENCE
 * permits differing exclusion REASONS as long as neither side calls a row
 * verified that the other excludes — that distinction is what actually matters
 * for whether official numbers can be trusted.
 */
export function compareKeyedParity(rows: readonly ParityRow[]): KeyedParityReport {
  let matching = 0, mismatching = 0, quantOnly = 0, pcOnly = 0, disagreeVerified = 0, fallbackKeys = 0;
  const reasons = new Map<string, { category: MismatchCategory; quantLab: string; paperChain: string; count: number; sampleKeys: string[] }>();
  const keyKinds: Record<string, number> = {};

  for (const r of rows) {
    keyKinds[r.keyKind ?? "UNKEYED"] = (keyKinds[r.keyKind ?? "UNKEYED"] ?? 0) + 1;
    if (r.keyKind === "OCC_SESSION_FALLBACK") fallbackKeys += 1;

    const cat = categorizeMismatch(r.quantLabStatus, r.paperChainStatus);
    if (cat === "POPULATION_ONLY_QUANT") { quantOnly += 1; continue; }
    if (cat === "POPULATION_ONLY_PAPER_CHAIN") { pcOnly += 1; continue; }
    if (r.quantLabStatus == null && r.paperChainStatus == null) continue;

    if (cat == null) { matching += 1; continue; }
    mismatching += 1;
    if (r.quantLabStatus === "VERIFIED_GRADED" || r.paperChainStatus === "VERIFIED_GRADED") disagreeVerified += 1;

    const k = `${cat}|${r.quantLabStatus}|${r.paperChainStatus}`;
    const prev = reasons.get(k);
    if (prev) { prev.count += 1; if (prev.sampleKeys.length < 5) prev.sampleKeys.push(r.key); }
    else reasons.set(k, { category: cat, quantLab: String(r.quantLabStatus), paperChain: String(r.paperChainStatus), count: 1, sampleKeys: [r.key] });
  }

  const shared = matching + mismatching;
  const parityStatus: ParityStatus = shared === 0
    ? "NOT_COMPARABLE"
    : mismatching === 0
      ? "ACHIEVED"
      : disagreeVerified === 0 ? "EXPLAINED_DIFFERENCE" : "NOT_ACHIEVED";

  return {
    version: PARITY_DIAGNOSTIC_VERSION,
    parityStatus,
    sharedPopulationCount: shared,
    matchingCount: matching,
    mismatchCount: mismatching,
    matchPct: shared > 0 ? Math.round((matching / shared) * 10_000) / 100 : null,
    quantOnlyCount: quantOnly,
    paperChainOnlyCount: pcOnly,
    quantLabVerifiedCount: rows.filter((r) => r.quantLabStatus === "VERIFIED_GRADED").length,
    paperChainVerifiedCount: rows.filter((r) => r.paperChainStatus === "VERIFIED_GRADED").length,
    disagreeOnVerified: disagreeVerified,
    mismatchReasons: [...reasons.values()].sort((a, b) => b.count - a.count),
    keyKinds, fallbackKeyCount: fallbackKeys,
    note: shared === 0
      ? "No shared rows. Aggregate counts must NOT be read as parity."
      : parityStatus === "ACHIEVED"
        ? `All ${shared} shared rows agree exactly.`
        : parityStatus === "EXPLAINED_DIFFERENCE"
          ? `${mismatching} shared rows carry different exclusion reasons, but neither system calls a row verified that the other excludes.`
          : `${disagreeVerified} shared row(s) are VERIFIED in one system and excluded in the other. Parity is NOT achieved.`,
  };
}

// ── §3 delivery classification ─────────────────────────────────────────────

export type DeliveryClass =
  | "ACTUAL_DELIVERY_FAILURE"
  | "DELIVERY_NOT_ATTEMPTED"
  | "RESEARCH_ONLY_EXPECTED"
  | "PAPER_ONLY_EXPECTED"
  | "LEGACY_DELIVERY_UNLINKABLE"
  | "MISSING_ALERT_LINK"
  | "MISSING_MESSAGE_ID"
  | "WRONG_ALERT_LINK"
  | "DUPLICATE_SUPPRESSED"
  | "DELIVERY_PROVEN_ELSEWHERE"
  | "OTHER_PROVEN_REASON"
  | "UNKNOWN";

export interface DeliveryFacts {
  alertRowPresent: boolean | null;
  alertState: string | null;
  researchOnly: boolean | null;
  discordMessageIdPresent: boolean | null;
  opportunityCasePresent: boolean | null;
  paperLinkedFlag: boolean | null;
  /** True when a delivery ledger row proves the send independently. */
  deliveryLedgerProof?: boolean | null;
  duplicateSuppressed?: boolean | null;
  /** Row predates the lifecycle/delivery-proof implementation. */
  predatesDeliveryProof?: boolean | null;
}

export interface DeliveryClassification {
  deliveryClass: DeliveryClass;
  reason: string;
  /** Does this represent a production DEFECT, or expected behaviour? */
  isProductionDefect: boolean;
  /** Could it ever become officially eligible? */
  affectsOfficialEligibility: boolean;
  /** Can proof be reconstructed deterministically? */
  safelyBackfillable: boolean;
  permanentlyUnverifiable: boolean;
}

/**
 * Explain WHY a row failed delivery proof.
 *
 * The 270 UNVERIFIED_DELIVERY rows are emphatically NOT 270 failed Discord
 * sends. Research-only rows were never meant to be delivered; legacy rows
 * predate the proof fields; a missing message id on an otherwise-sent alert is
 * an instrumentation gap, not a delivery failure. Treating them as one bucket
 * would invent a catastrophic delivery-failure rate that never happened.
 */
export function classifyDelivery(f: DeliveryFacts): DeliveryClassification {
  const mk = (
    deliveryClass: DeliveryClass, reason: string,
    o: Partial<Omit<DeliveryClassification, "deliveryClass" | "reason">> = {},
  ): DeliveryClassification => ({
    deliveryClass, reason,
    isProductionDefect: o.isProductionDefect ?? false,
    affectsOfficialEligibility: o.affectsOfficialEligibility ?? true,
    safelyBackfillable: o.safelyBackfillable ?? false,
    permanentlyUnverifiable: o.permanentlyUnverifiable ?? false,
  });

  if (f.researchOnly === true) {
    return mk("RESEARCH_ONLY_EXPECTED", "research_only=1 — this row was never intended for a subscriber",
      { affectsOfficialEligibility: false });
  }
  if (f.alertRowPresent === null) {
    return mk("LEGACY_DELIVERY_UNLINKABLE", "no alerts table or unknowable provenance",
      { permanentlyUnverifiable: true, affectsOfficialEligibility: false });
  }
  if (f.alertRowPresent === false) {
    return mk("MISSING_ALERT_LINK", "paper row has no alert to prove delivery against — paper existence is not delivery",
      { isProductionDefect: false, affectsOfficialEligibility: false });
  }
  if (f.predatesDeliveryProof === true) {
    return mk("LEGACY_DELIVERY_UNLINKABLE", "row predates the delivery-proof fields",
      { permanentlyUnverifiable: true, affectsOfficialEligibility: false });
  }
  if (f.duplicateSuppressed === true) {
    return mk("DUPLICATE_SUPPRESSED", "suppressed as a duplicate — correctly never delivered",
      { affectsOfficialEligibility: false });
  }
  const state = String(f.alertState ?? "").toUpperCase();
  if (state && state !== "SENT") {
    return mk("DELIVERY_NOT_ATTEMPTED", `alert state is ${state} — no send was attempted`,
      { affectsOfficialEligibility: false });
  }
  if (f.deliveryLedgerProof === true && f.discordMessageIdPresent !== true) {
    return mk("DELIVERY_PROVEN_ELSEWHERE", "the delivery ledger proves the send even though the message id is absent",
      { isProductionDefect: true, safelyBackfillable: true });
  }
  if (state === "SENT" && f.discordMessageIdPresent !== true) {
    return mk("MISSING_MESSAGE_ID", "alert is SENT but no Discord message id was recorded — an instrumentation gap, not a failed send",
      { isProductionDefect: true, safelyBackfillable: false });
  }
  if (state === "SENT" && f.paperLinkedFlag === false) {
    return mk("WRONG_ALERT_LINK", "alert is SENT but does not claim a paper link", { isProductionDefect: true });
  }
  if (state === "SENT" && f.opportunityCasePresent !== true) {
    return mk("MISSING_ALERT_LINK", "alert is SENT but carries no opportunity case", { isProductionDefect: true });
  }
  if (f.alertRowPresent === true && !state) {
    return mk("UNKNOWN", "alert row exists but its state is unreadable");
  }
  return mk("OTHER_PROVEN_REASON", "delivery proof incomplete for a reason outside the taxonomy");
}

export interface DeliveryCensus {
  total: number;
  byClass: Record<string, number>;
  productionDefects: number;
  eligibilityAffecting: number;
  permanentlyUnverifiable: number;
  backfillable: number;
  /** Rows that were never meant to be delivered. Not failures. */
  expectedNonDelivery: number;
  note: string;
}

export function buildDeliveryCensus(rows: readonly DeliveryClassification[]): DeliveryCensus {
  const byClass: Record<string, number> = {};
  let defects = 0, eligibility = 0, permanent = 0, backfill = 0, expected = 0;
  for (const r of rows) {
    byClass[r.deliveryClass] = (byClass[r.deliveryClass] ?? 0) + 1;
    if (r.isProductionDefect) defects += 1;
    if (r.affectsOfficialEligibility) eligibility += 1;
    if (r.permanentlyUnverifiable) permanent += 1;
    if (r.safelyBackfillable) backfill += 1;
    if (r.deliveryClass === "RESEARCH_ONLY_EXPECTED" || r.deliveryClass === "PAPER_ONLY_EXPECTED"
      || r.deliveryClass === "DELIVERY_NOT_ATTEMPTED" || r.deliveryClass === "DUPLICATE_SUPPRESSED") expected += 1;
  }
  const actualFailures = byClass.ACTUAL_DELIVERY_FAILURE ?? 0;
  return {
    total: rows.length, byClass,
    productionDefects: defects, eligibilityAffecting: eligibility,
    permanentlyUnverifiable: permanent, backfillable: backfill, expectedNonDelivery: expected,
    note: `${actualFailures} actual delivery failure(s) of ${rows.length} rows lacking delivery proof. The remainder are research-only, legacy, unlinked or instrumentation gaps — NOT failed sends.`,
  };
}

// ── §10 eligible population ────────────────────────────────────────────────

export interface EligiblePopulation {
  totalRows: number;
  eligible: number;
  verifiedEligible: number;
  permanentlyIneligibleLegacy: number;
  researchOnly: number;
  /** Verified as a fraction of the ELIGIBLE population, not of all history. */
  verifiedFractionOfEligible: number | null;
  note: string;
}

/**
 * Verified fraction measured against what could ever qualify.
 *
 * Measuring against all history permanently blocks quotability: legacy and
 * research-only rows can never become verified, so demanding 80% of everything
 * is demanding the impossible. The honest denominator is the eligible
 * population — and it must be stated, not silently chosen.
 */
export function buildEligiblePopulation(
  rows: readonly { verified: boolean; permanentlyUnverifiable: boolean; researchOnly: boolean }[],
): EligiblePopulation {
  const total = rows.length;
  const legacy = rows.filter((r) => r.permanentlyUnverifiable).length;
  const research = rows.filter((r) => r.researchOnly && !r.permanentlyUnverifiable).length;
  const eligible = total - legacy - research;
  const verifiedEligible = rows.filter((r) => r.verified && !r.permanentlyUnverifiable && !r.researchOnly).length;
  return {
    totalRows: total, eligible, verifiedEligible,
    permanentlyIneligibleLegacy: legacy, researchOnly: research,
    verifiedFractionOfEligible: eligible > 0 ? Math.round((verifiedEligible / eligible) * 10_000) / 10_000 : null,
    note: eligible === 0
      ? "No eligible rows — every row is legacy or research-only."
      : `Verified fraction is measured against ${eligible} eligible rows, not all ${total} historical rows.`,
  };
}

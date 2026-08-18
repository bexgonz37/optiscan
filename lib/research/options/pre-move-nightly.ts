/**
 * pre-move-nightly.ts — the deterministic pre-move section of the nightly analysis.
 *
 * Answers, per LANE and never pooled:
 *
 *   Which winners did we find BEFORE the run?
 *   Which alerts were late?
 *   How much of the premium was already paid for by the time we alerted?
 *   How long after the alert did +25 / +50 / +100 actually arrive?
 *
 * Two rules shape every number below.
 *
 * FIRST: lead time is measured from the alert, on the frozen contract's own marks, and a
 * milestone reached BEFORE the alert is never counted toward it. Without that split a
 * trade that had already run +60% before we spoke would be reported as a +50% success
 * with a lead time of zero, which is the exact opposite of the finding.
 *
 * SECOND: post-alert MFE requires VERIFIED excursion evidence. A trajectory claim on a
 * trade marked twice asserts that the gaps held nothing larger. Realized return is a
 * different and weaker claim — one observation against the entry — and it is never
 * suppressed just because the trajectory is unknown.
 *
 * No provider call, and no model call: this module is deterministic over stored evidence
 * only. The narration layer may later describe these numbers, but it cannot produce them.
 * (`lib/` outside `lib/ai/` is an enforced model-free boundary — see
 * tests/architecture.test.mjs — so even naming the technology here trips the guard.)
 */
import {
  computeAlertLeadTime,
  DEFAULT_LEAD_TIME_MILESTONES,
  type DiscoveryStage,
} from "./pre-move-discovery.ts";
import {
  censusFromPreMoveRows,
  listPreMoveDiscoveriesByCaseIdsOnDb,
  listPreMoveDiscoveriesOnDb,
  summarizePreMoveDiscoveryOnDb,
  type PreMoveLane,
  type PreMoveRow,
  type PreMoveStageCensus,
} from "./pre-move-store.ts";
import { excursionForPaperTradeOnDb } from "../../opportunity-case/excursion.ts";
import {
  loadOwnerMirrorPopulationOnDb,
  type OwnerMirrorPopulation,
  type OwnerMirrorRecord,
} from "../../opportunity-case/owner-mirror-identity.ts";

export interface PreMoveNightlyDb {
  prepare(sql: string): { get?: (...a: any[]) => any; all?: (...a: any[]) => any[] };
}

export const PRE_MOVE_NIGHTLY_VERSION = "PRE_MOVE_NIGHTLY_V1" as const;

export interface AlertLeadTimeRow {
  /** The case this PRE_MOVE row is filed under — often the PENDING audit case. */
  opportunityCaseId: string;
  /** The CLAIM case that owns the mirror, when the two differ. Null when unresolved. */
  ownerCaseId: string | null;
  paperTradeId: number | null;
  symbol: string | null;
  optionSymbol: string | null;
  discoveryStage: DiscoveryStage | null;
  ownerNotifiedAtMs: number | null;
  /** Whether that instant was recorded at delivery or derived from the mirror's entry. */
  ownerAlertInstantProvenance: OwnerAlertInstantProvenance;
  /** Premium already consumed between detection and alert. Large = we were late. */
  premiumConsumedBeforeAlertPct: number | null;
  rewardRemainingFraction: number | null;
  rewardRemainingBand: string | null;
  /** ms from the alert to the first touch of each milestone. Null = never reached. */
  msToMilestone: Record<string, number | null>;
  /** Milestones already reached BEFORE the alert. Any is a red flag. */
  milestonesReachedBeforeAlert: number[];
  postAlertMfePct: number | null;
  excursionState: string;
  marksOnContract: number;
  realizedReturnPct: number | null;
  realizedEvidence: "VERIFIED" | "STILL_OPEN" | "UNAVAILABLE";
}

export interface PreMoveNightlyLane {
  lane: PreMoveLane;
  census: PreMoveStageCensus;
  /** Openings with a real alert, hence a real lead time. */
  gradedAlerts: number;
  /** Share of alerted trades that reached each milestone AFTER the alert. */
  milestoneAttainment: Record<string, { reached: number; of: number; rate: number | null; medianMsToReach: number | null }>;
  /** Alerts where a milestone had ALREADY been hit before we spoke. */
  alertsWithMilestoneAlreadyHit: number;
  /** Rows whose alert instant came from the mirror's entry rather than a recorded send. */
  alertInstantsDerived: number;
  medianPremiumConsumedBeforeAlertPct: number | null;
  medianRewardRemainingFraction: number | null;
  rows: AlertLeadTimeRow[];
}

export interface PreMoveNightlyReport {
  version: typeof PRE_MOVE_NIGHTLY_VERSION;
  sinceMs: number | null;
  lanes: PreMoveNightlyLane[];
  questions: Array<{ question: string; answer: string }>;
  note: string;
}

const LANES: PreMoveLane[] = ["OWNER", "RESEARCH", "SHADOW", "EXPERIMENT"];

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : +(((s[m - 1] + s[m]) / 2).toFixed(4));
}

/**
 * The frozen mirror for a case, and its marks on that exact contract.
 *
 * IDENTITY RUNS THROUGH THE OPPORTUNITY CASE, NOT AN ALERT ID.
 *
 * This function used to read `opportunity_cases.alert_id` and look the mirror up by it.
 * An owner callout never writes an `options_alerts` row, so that column is null on every
 * owner case in existence — 0 of 106 in production. The lookup returned null for the
 * entire owner lane, silently, and every owner lead time, milestone and realized outcome
 * on this report was therefore absent rather than wrong.
 *
 * The mirror is now resolved from the owner population index, which is keyed on BOTH
 * identities of a callout: the claim case that owns the mirror, and the pending audit
 * case that owns this very PRE_MOVE row. Marks are still filtered on their OWN
 * `option_symbol` inside `excursionForPaperTradeOnDb` — a mark on a re-selected strike is
 * an observation of a different instrument and can never enter a lead time for this one.
 */
function mirrorForCase(
  population: OwnerMirrorPopulation,
  opportunityCaseId: string,
): OwnerMirrorRecord | null {
  const m = population.byCaseId.get(opportunityCaseId);
  // An OCC mismatch is a mirror, but not THIS callout's evidence. Refused rather than
  // priced, which is the same rule the owner mirror audit applies.
  return m && m.occExact ? m : null;
}

function marksFor(db: PreMoveNightlyDb, tradeId: number, occ: string | null): Array<{ atMs: number | null; returnPct: number | null }> {
  if (!occ) return [];
  try {
    return ((db.prepare(
      `SELECT mark_at_ms, return_pct FROM options_paper_marks
        WHERE trade_id=? AND UPPER(TRIM(option_symbol))=UPPER(TRIM(?))
        ORDER BY mark_at_ms ASC`,
    ).all?.(tradeId, occ) ?? []) as any[]).map((r) => ({
      atMs: r.mark_at_ms == null ? null : Number(r.mark_at_ms),
      returnPct: r.return_pct == null ? null : Number(r.return_pct),
    }));
  } catch {
    return [];
  }
}

/**
 * How an owner alert instant was obtained, so a derived one can never be quoted as a
 * recorded one.
 */
export type OwnerAlertInstantProvenance = "RECORDED" | "DERIVED_FROM_MIRROR_ENTRY" | "UNAVAILABLE";

/**
 * The alert instant for a PRE_MOVE row, and where it came from.
 *
 * `owner_notified_at_ms` is null on every historical row, because the promotion that
 * writes it was keyed on the wrong case id for its whole life. Those rows are not
 * backfilled — nothing invents a notification timestamp — but the owner mirror's own
 * `entered_at_ms` is a real observation of the same event: the mirror is opened
 * immediately AFTER the Discord send, in the same block, so it is at or after the true
 * alert instant. Every lead time measured from it is therefore equal to or SHORTER than
 * the truth, which is the safe direction: it can understate how early a callout was and
 * cannot overstate it.
 *
 * The provenance travels with the value. A derived instant is never written back.
 */
function alertInstantFor(
  row: PreMoveRow,
  mirror: OwnerMirrorRecord | null,
): { atMs: number | null; provenance: OwnerAlertInstantProvenance } {
  if (row.ownerNotifiedAtMs != null) return { atMs: row.ownerNotifiedAtMs, provenance: "RECORDED" };
  if (mirror?.enteredAtMs != null) return { atMs: mirror.enteredAtMs, provenance: "DERIVED_FROM_MIRROR_ENTRY" };
  return { atMs: null, provenance: "UNAVAILABLE" };
}

function laneFromRows(
  db: PreMoveNightlyDb,
  lane: PreMoveLane,
  census: PreMoveStageCensus,
  discoveries: readonly PreMoveRow[],
  population: OwnerMirrorPopulation,
): PreMoveNightlyLane {
  const rows: AlertLeadTimeRow[] = [];
  for (const d of discoveries) {
    const mirror = mirrorForCase(population, d.opportunityCaseId);
    const excursion = mirror
      ? excursionForPaperTradeOnDb(db as any, mirror.paperTradeId, mirror.optionSymbol)
      : { state: "NO_MIRROR" as const, mfePct: null, maePct: null, marksOnContract: 0 };
    const marks = mirror ? marksFor(db, mirror.paperTradeId, mirror.optionSymbol) : [];
    const alert = alertInstantFor(d, mirror);

    const lead = computeAlertLeadTime({
      alertAtMs: alert.atMs,
      marks,
      premiumConsumedBeforeAlertPct: d.premiumExpansionConsumedPct,
      excursionVerified: excursion.state === "VERIFIED_EXCURSION",
    });

    // A return is REALIZED only on a closed mirror on the exact contract. An open trade's
    // absent return is "not yet", never a zero, and pooling the two would drag every
    // expectancy toward 0.
    rows.push({
      opportunityCaseId: d.opportunityCaseId,
      ownerCaseId: mirror?.opportunityCaseId ?? null,
      paperTradeId: mirror?.paperTradeId ?? null,
      symbol: d.symbol,
      optionSymbol: d.optionSymbol,
      discoveryStage: d.discoveryStage,
      ownerNotifiedAtMs: alert.atMs,
      ownerAlertInstantProvenance: alert.provenance,
      premiumConsumedBeforeAlertPct: d.premiumExpansionConsumedPct,
      rewardRemainingFraction: d.rewardRemainingFraction,
      rewardRemainingBand: d.rewardRemainingBand,
      msToMilestone: lead.msToMilestone,
      milestonesReachedBeforeAlert: lead.milestonesReachedBeforeAlert,
      postAlertMfePct: lead.postAlertMfePct,
      excursionState: excursion.state,
      marksOnContract: excursion.marksOnContract,
      realizedReturnPct: mirror?.realizedEvidence === "VERIFIED" ? mirror.realizedReturnPct : null,
      realizedEvidence: mirror?.realizedEvidence ?? "UNAVAILABLE",
    });
  }

  // Attainment is measured only over trades that could have reached the milestone AFTER
  // the alert — i.e. those with usable marks. A trade with no marks is unmeasured, not a
  // failure to reach +25%, and counting it as one would understate every rate.
  const measurable = rows.filter((r) => r.marksOnContract > 0);
  const milestoneAttainment: PreMoveNightlyLane["milestoneAttainment"] = {};
  for (const m of DEFAULT_LEAD_TIME_MILESTONES) {
    const key = String(m);
    const times = measurable
      .map((r) => r.msToMilestone[key])
      .filter((v): v is number => v != null);
    milestoneAttainment[key] = {
      reached: times.length,
      of: measurable.length,
      rate: measurable.length ? +(times.length / measurable.length).toFixed(4) : null,
      medianMsToReach: median(times),
    };
  }

  return {
    lane,
    census,
    gradedAlerts: rows.length,
    milestoneAttainment,
    alertsWithMilestoneAlreadyHit: rows.filter((r) => r.milestonesReachedBeforeAlert.length > 0).length,
    alertInstantsDerived: rows.filter((r) => r.ownerAlertInstantProvenance === "DERIVED_FROM_MIRROR_ENTRY").length,
    medianPremiumConsumedBeforeAlertPct: median(
      rows.map((r) => r.premiumConsumedBeforeAlertPct).filter((v): v is number => v != null),
    ),
    medianRewardRemainingFraction: median(
      rows.map((r) => r.rewardRemainingFraction).filter((v): v is number => v != null),
    ),
    rows,
  };
}

/**
 * A non-owner lane, exactly as before: membership from the stored `lane` column, and only
 * rows that actually recorded an owner notification.
 *
 * Rows the owner lane has claimed are removed here so the lanes stay disjoint. A PRE_MOVE
 * row stamped SHADOW at capture time that later produced an owner callout belongs to one
 * population, not two, and pooling it would double-count the only lane that matters.
 */
function buildLane(
  db: PreMoveNightlyDb,
  lane: PreMoveLane,
  sinceMs: number | null,
  population: OwnerMirrorPopulation,
  claimedByOwner: ReadonlySet<string>,
): PreMoveNightlyLane {
  const census = summarizePreMoveDiscoveryOnDb(db, { sinceMs, lane });
  const discoveries = listPreMoveDiscoveriesOnDb(db, { sinceMs, lane, ownerAlertedOnly: true, limit: 1000 })
    .filter((d) => !claimedByOwner.has(d.opportunityCaseId));
  return laneFromRows(db, lane, census, discoveries, population);
}

/**
 * THE OWNER LANE, RESOLVED CASE-FIRST.
 *
 * Membership cannot come from the `lane` column. That column is stamped at CAPTURE time,
 * on a tick that cannot know whether an owner will later be notified, so it reads SHADOW
 * or RESEARCH; `recordPreMoveAlertOnDb` was supposed to promote it and never matched a
 * row, because the observation is written under the scanner's PENDING audit case while
 * the promotion was keyed on the claim case minted at delivery. Production at 801b7d0d:
 * 0 rows with `lane='OWNER'`, 0 rows with a non-null `owner_notified_at_ms`, against 74
 * exact owner mirrors.
 *
 * So the owner lane is built from the mirrors — the objects that PROVE an owner was
 * notified, because a mirror only exists if the Discord opening was sent — and their
 * PRE_MOVE rows are fetched by both case identities. That is evidence, not a label.
 */
function buildOwnerLane(
  db: PreMoveNightlyDb,
  sinceMs: number | null,
  population: OwnerMirrorPopulation,
): { lane: PreMoveNightlyLane; claimedCaseIds: Set<string> } {
  const caseIds: string[] = [];
  for (const m of population.mirrors) {
    if (!m.occExact || m.caseIdentityAmbiguous) continue;
    caseIds.push(m.opportunityCaseId);
    if (m.preMoveCaseId) caseIds.push(m.preMoveCaseId);
  }
  const all = listPreMoveDiscoveriesByCaseIdsOnDb(db as any, caseIds)
    .filter((r) => sinceMs == null || (r.firstDetectedAtMs != null && r.firstDetectedAtMs >= sinceMs));

  // One callout can own two PRE_MOVE rows — the pending audit row and, on later ticks, a
  // row under the claim case. Keep the EARLIEST detection per mirror: it is the one that
  // saw the setup before the alert, and the later one would report every callout as late.
  const best = new Map<number, PreMoveRow>();
  for (const r of all) {
    const mirror = mirrorForCase(population, r.opportunityCaseId);
    if (!mirror) continue;
    const prev = best.get(mirror.paperTradeId);
    if (!prev || (r.firstDetectedAtMs ?? Infinity) < (prev.firstDetectedAtMs ?? Infinity)) {
      best.set(mirror.paperTradeId, r);
    }
  }
  const discoveries = [...best.values()].sort(
    (a, b) => (b.firstDetectedAtMs ?? 0) - (a.firstDetectedAtMs ?? 0),
  );

  const claimedCaseIds = new Set(all.map((r) => r.opportunityCaseId));
  const census = censusFromPreMoveRows(
    discoveries,
    (r) => alertInstantFor(r, mirrorForCase(population, r.opportunityCaseId)).atMs,
  );
  return { lane: laneFromRows(db, "OWNER", census, discoveries, population), claimedCaseIds };
}

/**
 * The standing questions the nightly must answer, answered from evidence or refused.
 *
 * They are emitted as question/answer pairs rather than as bare numbers so an absent
 * answer stays legible as a refusal. "INSUFFICIENT_EVIDENCE" is a finding; a silently
 * omitted metric looks like a question nobody asked.
 */
function standingQuestions(owner: PreMoveNightlyLane): Array<{ question: string; answer: string }> {
  const q: Array<{ question: string; answer: string }> = [];
  const c = owner.census;

  q.push({
    question: "Which owner alerts were found BEFORE the move ran?",
    answer: c.earlyRate == null
      ? "INSUFFICIENT_EVIDENCE — no gradable owner discovery rows"
      : `${Math.round(c.earlyRate * 100)}% of gradable owner rows were PRE_TRIGGER or EARLY `
        + `(${c.byStage.PRE_TRIGGER} pre-trigger, ${c.byStage.EARLY_CONFIRMATION} early confirmation, `
        + `${c.byStage.EARLY_EXPANSION} early expansion of ${c.examined} examined)`,
  });

  q.push({
    question: "Which owner alerts were late?",
    answer: c.tooLateRate == null
      ? "INSUFFICIENT_EVIDENCE — no gradable owner discovery rows"
      : `${Math.round(c.tooLateRate * 100)}% were TOO_LATE and ${c.byStage.MATURE_MOVE} were MATURE_MOVE`,
  });

  q.push({
    question: "How much premium had already been paid for by the time we alerted?",
    answer: owner.medianPremiumConsumedBeforeAlertPct == null
      ? "INSUFFICIENT_EVIDENCE — no alerted row carries both a detection and an alert premium"
      : `median ${owner.medianPremiumConsumedBeforeAlertPct}% expansion between detection and alert`,
  });

  const m25 = owner.milestoneAttainment["25"];
  q.push({
    question: "Did the move pay AFTER the alert?",
    answer: !m25 || m25.of === 0
      ? "INSUFFICIENT_EVIDENCE — no alerted trade has same-contract marks yet"
      : `+25% reached after the alert on ${m25.reached}/${m25.of} measurable alerts`
        + (m25.medianMsToReach != null ? `, median ${Math.round(m25.medianMsToReach / 60_000)} min after the alert` : ""),
  });

  q.push({
    question: "Did any alert fire on a move that had already hit a milestone?",
    answer: owner.alertsWithMilestoneAlreadyHit === 0
      ? "No alerted trade had reached a milestone before the alert"
      : `${owner.alertsWithMilestoneAlreadyHit} alert(s) fired after a milestone had already been reached — `
        + "their realized returns are real, but the alert cannot claim credit for that part of the move",
  });

  q.push({
    question: "How much reward was typically left at alert time?",
    answer: owner.medianRewardRemainingFraction == null
      ? "INSUFFICIENT_EVIDENCE — no measurable favourable session extent on the alerted rows"
      : `median ${Math.round(owner.medianRewardRemainingFraction * 100)}% of the session's observed `
        + "favourable extent was still unspent (advisory; not a forecast)",
  });

  return q;
}

export function buildPreMoveNightlyReport(
  db: PreMoveNightlyDb,
  opts: { sinceMs?: number | null } = {},
): PreMoveNightlyReport {
  const sinceMs = opts.sinceMs ?? null;
  // Resolved ONCE. Every lane below reads the same owner population, so a mirror cannot be
  // counted in two lanes and the owner lane cannot disagree with itself between sections.
  const population = (() => {
    try { return loadOwnerMirrorPopulationOnDb(db as any, { sinceMs: null }); }
    catch {
      return {
        version: "OWNER_MIRROR_IDENTITY_V1" as const,
        mirrors: [], withoutCaseIdentity: 0, ambiguousCaseIds: [],
        byCaseId: new Map(),
      } as OwnerMirrorPopulation;
    }
  })();

  const ownerBuilt = buildOwnerLane(db, sinceMs, population);
  const lanes = LANES.map((lane) =>
    lane === "OWNER"
      ? ownerBuilt.lane
      : buildLane(db, lane, sinceMs, population, ownerBuilt.claimedCaseIds),
  );
  const owner = lanes.find((l) => l.lane === "OWNER")!;
  return {
    version: PRE_MOVE_NIGHTLY_VERSION,
    sinceMs,
    lanes,
    questions: standingQuestions(owner),
    note:
      "Lanes are never pooled: an owner validation alert and a shadow observation describe "
      + "populations that have never coexisted. OWNER membership is proven by the paper mirror the "
      + "callout left, not by the `lane` column — that column is stamped at capture time, before "
      + "anyone knows an owner will be notified, and its promotion was keyed on the wrong case id "
      + "for its entire life. Lead time is measured FROM the alert on the frozen contract's own "
      + "marks; a milestone reached before the alert is reported separately and never counted as "
      + "lead time. Where no send instant was recorded, the mirror's own entry is used and the row "
      + "says so in `ownerAlertInstantProvenance` — that instant is at or AFTER the true send, so "
      + "every lead time derived from it is a floor, never a flattering estimate. Post-alert MFE "
      + "requires VERIFIED excursion evidence; realized return does not and is never suppressed "
      + "alongside it.",
  };
}

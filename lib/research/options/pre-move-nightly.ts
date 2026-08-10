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
  listPreMoveDiscoveriesOnDb,
  summarizePreMoveDiscoveryOnDb,
  type PreMoveLane,
  type PreMoveStageCensus,
} from "./pre-move-store.ts";
import { excursionForPaperTradeOnDb } from "../../opportunity-case/excursion.ts";

export interface PreMoveNightlyDb {
  prepare(sql: string): { get?: (...a: any[]) => any; all?: (...a: any[]) => any[] };
}

export const PRE_MOVE_NIGHTLY_VERSION = "PRE_MOVE_NIGHTLY_V1" as const;

export interface AlertLeadTimeRow {
  opportunityCaseId: string;
  symbol: string | null;
  optionSymbol: string | null;
  discoveryStage: DiscoveryStage | null;
  ownerNotifiedAtMs: number | null;
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
 * Identity comes from the mirror row, and the marks are filtered on their OWN
 * option_symbol inside `excursionForPaperTradeOnDb`. A mark on a re-selected strike is
 * an observation of a different instrument and can never enter a lead time for this one.
 */
function mirrorForCase(
  db: PreMoveNightlyDb,
  opportunityCaseId: string,
): { tradeId: number; optionSymbol: string | null; returnPct: number | null; status: string | null } | null {
  try {
    const alert = db.prepare("SELECT alert_id FROM opportunity_cases WHERE opportunity_id=?").get?.(opportunityCaseId) as any;
    if (!alert?.alert_id) return null;
    const t = db.prepare(
      `SELECT id, option_symbol, return_pct, status FROM options_paper_trades
        WHERE alert_id=? ORDER BY id ASC LIMIT 1`,
    ).get?.(alert.alert_id) as any;
    if (!t?.id) return null;
    return {
      tradeId: Number(t.id),
      optionSymbol: t.option_symbol == null ? null : String(t.option_symbol),
      returnPct: t.return_pct == null ? null : Number(t.return_pct),
      status: t.status == null ? null : String(t.status),
    };
  } catch {
    return null;
  }
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

function buildLane(db: PreMoveNightlyDb, lane: PreMoveLane, sinceMs: number | null): PreMoveNightlyLane {
  const census = summarizePreMoveDiscoveryOnDb(db, { sinceMs, lane });
  const discoveries = listPreMoveDiscoveriesOnDb(db, { sinceMs, lane, ownerAlertedOnly: true, limit: 1000 });

  const rows: AlertLeadTimeRow[] = [];
  for (const d of discoveries) {
    const mirror = mirrorForCase(db, d.opportunityCaseId);
    const excursion = mirror
      ? excursionForPaperTradeOnDb(db as any, mirror.tradeId, mirror.optionSymbol)
      : { state: "NO_MIRROR" as const, mfePct: null, maePct: null, marksOnContract: 0 };
    const marks = mirror ? marksFor(db, mirror.tradeId, mirror.optionSymbol) : [];

    const lead = computeAlertLeadTime({
      alertAtMs: d.ownerNotifiedAtMs,
      marks,
      premiumConsumedBeforeAlertPct: d.premiumExpansionConsumedPct,
      excursionVerified: excursion.state === "VERIFIED_EXCURSION",
    });

    // A return is REALIZED only on a closed mirror. An open trade's absent return is
    // "not yet", never a zero, and pooling the two would drag every expectancy toward 0.
    const closed = mirror?.status === "EXITED";
    const realizedEvidence = !mirror
      ? "UNAVAILABLE" as const
      : closed && mirror.returnPct != null
        ? "VERIFIED" as const
        : closed
          ? "UNAVAILABLE" as const
          : "STILL_OPEN" as const;

    rows.push({
      opportunityCaseId: d.opportunityCaseId,
      symbol: d.symbol,
      optionSymbol: d.optionSymbol,
      discoveryStage: d.discoveryStage,
      ownerNotifiedAtMs: d.ownerNotifiedAtMs,
      premiumConsumedBeforeAlertPct: d.premiumExpansionConsumedPct,
      rewardRemainingFraction: d.rewardRemainingFraction,
      rewardRemainingBand: d.rewardRemainingBand,
      msToMilestone: lead.msToMilestone,
      milestonesReachedBeforeAlert: lead.milestonesReachedBeforeAlert,
      postAlertMfePct: lead.postAlertMfePct,
      excursionState: excursion.state,
      marksOnContract: excursion.marksOnContract,
      realizedReturnPct: realizedEvidence === "VERIFIED" ? (mirror?.returnPct ?? null) : null,
      realizedEvidence,
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
  const lanes = LANES.map((lane) => buildLane(db, lane, sinceMs));
  const owner = lanes.find((l) => l.lane === "OWNER")!;
  return {
    version: PRE_MOVE_NIGHTLY_VERSION,
    sinceMs,
    lanes,
    questions: standingQuestions(owner),
    note:
      "Lanes are never pooled: an owner validation alert and a shadow observation describe "
      + "populations that have never coexisted. Lead time is measured FROM the alert on the frozen "
      + "contract's own marks; a milestone reached before the alert is reported separately and never "
      + "counted as lead time. Post-alert MFE requires VERIFIED excursion evidence; realized return "
      + "does not and is never suppressed alongside it.",
  };
}

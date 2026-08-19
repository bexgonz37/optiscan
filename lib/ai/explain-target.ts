/**
 * explain-target.ts — "Explain this" for the private research view.
 *
 * There is ONE chatbot. This module does not add a second one: it resolves what the
 * owner clicked into deterministic evidence, and hands that evidence to the existing
 * Ask OptiScan path as supplemental context. The answer that comes back is validated
 * by the same validator, metered against the same budget, and carries the same
 * ADVISORY_ONLY authority as every other answer.
 *
 * ── Identity is passed, never reconstructed ───────────────────────────────────
 *
 * A target is named by a STABLE ID — a case id, an experiment id, a cohort id, a
 * metric key. Never by ticker text. "Explain the IWM put" is a question with more than
 * one answer on any day the scanner saw IWM twice, and the wrong answer is
 * indistinguishable from the right one because both are about IWM puts. Resolution is
 * therefore exact-match on an identifier the surface already had in hand, and an
 * unresolvable id is refused rather than fuzzy-matched.
 *
 * ── The deterministic answer always exists ────────────────────────────────────
 *
 * `buildExplainTarget` never needs the model. It returns the glossary definition, the
 * evidence, the population, the sample, the sessions and the limitations on its own.
 * The AI narration is ADDITIVE. When the monthly budget is exhausted, when the key is
 * absent, when the provider is down, or when the answer fails validation, the page
 * still renders everything below and simply says the narration is unavailable.
 *
 * That ordering is the whole design. A panel that shows nothing when the AI is out is
 * a panel whose numbers were never really deterministic.
 *
 * PURE apart from the explicit `*OnDb` reads. No provider call, no write, no send
 * authority, and nothing here is consulted by any live decision.
 */
import { metricInfo, type MetricInfo } from "../metric-glossary.ts";

export const EXPLAIN_TARGET_VERSION = "EXPLAIN_TARGET_V1";

export type ExplainKind = "METRIC" | "CASE" | "EXPERIMENT" | "COHORT";
export const EXPLAIN_KINDS: readonly ExplainKind[] = Object.freeze(["METRIC", "CASE", "EXPERIMENT", "COHORT"]);

export interface ExplainRequest {
  kind: ExplainKind;
  /** The stable identifier. A metric key, an opportunity case id, an experiment id. */
  id: string;
  /**
   * Which population the metric belongs to, when the target is a METRIC.
   *
   * Load-bearing: "profit factor 1.22" is a different claim in the baseline arm, the
   * shadow arm and the whole owner lane, and the three genuinely disagree. A metric
   * explained without its population is explained wrongly.
   */
  population?: string | null;
}

/** One labelled fact the explanation may rest on. Values are never re-derived. */
export interface ExplainFact {
  label: string;
  value: number | string | null;
  unit?: string | null;
  note?: string | null;
}

export interface ExplainTarget {
  version: typeof EXPLAIN_TARGET_VERSION;
  kind: ExplainKind;
  id: string;
  resolved: boolean;
  /** Why an unresolved target could not be resolved. Never a guess at what was meant. */
  unresolvedReason: string | null;

  title: string;
  /** The one-sentence glossary definition, when the target has one. */
  definition: MetricInfo | null;
  population: string | null;
  sampleSize: number | null;
  independentSessions: number | null;
  dateRange: { from: string | null; to: string | null } | null;
  evidenceState: string | null;

  facts: ExplainFact[];
  limitations: string[];
  /** Always false for everything this module can describe. Rendered, not footnoted. */
  hasLiveAuthority: false;
  /** What a reader must not conclude. Carried with the target, not bolted on later. */
  mustNotBeReadAs: string[];
}

export interface ExplainDb {
  prepare(sql: string): { get?: (...a: any[]) => any; all?: (...a: any[]) => any[] };
}

const NO_LIVE_AUTHORITY =
  "Nothing described here has any live authority. It does not admit, reject, rank, "
  + "size, time or annotate a callout, and no experiment can become live automatically.";

const NOT_SUBSCRIBER =
  "OWNER VALIDATION / PAPER-TRACKED. No subscriber received these trades and this is "
  + "not subscriber performance.";

function unresolved(kind: ExplainKind, id: string, reason: string): ExplainTarget {
  return {
    version: EXPLAIN_TARGET_VERSION,
    kind, id, resolved: false, unresolvedReason: reason,
    title: `${kind} ${id}`,
    definition: null, population: null, sampleSize: null,
    independentSessions: null, dateRange: null, evidenceState: null,
    facts: [], limitations: [],
    hasLiveAuthority: false,
    mustNotBeReadAs: [NO_LIVE_AUTHORITY],
  };
}

// ── METRIC ───────────────────────────────────────────────────────────────────

/**
 * A metric, explained in the population the owner clicked it in.
 *
 * The definition comes from `lib/metric-glossary.ts` and is NOT restated here. One
 * wording in one place is the only way the tooltip on a card and the explanation
 * behind it cannot drift into saying different things about the same number.
 */
function explainMetric(id: string, population: string | null, ctx: ExplainContext): ExplainTarget {
  const info = metricInfo(id);
  if (!info) {
    return unresolved("METRIC", id,
      `"${id}" is not a key in the metric glossary. Metrics are explained by key, never by `
      + "the label printed on a card, so a renamed heading cannot silently resolve to the "
      + "wrong definition.");
  }

  const facts: ExplainFact[] = [];
  const limitations: string[] = [];
  const mustNot: string[] = [NO_LIVE_AUTHORITY];

  const edge = ctx.currentEdge ?? null;
  const shadow = (ctx.shadowExperiments ?? [])[0] ?? null;

  const isShadowMetric = /^shadow/i.test(id) || population === "SHADOW_ARM";
  const isBaselineMetric = /^baseline/i.test(id) || population === "BASELINE_ARM";

  if ((isShadowMetric || isBaselineMetric) && shadow) {
    const arm = isShadowMetric ? shadow.shadow : shadow.baseline;
    facts.push(
      { label: "Experiment", value: `${shadow.experimentId} v${shadow.experimentVersion}` },
      { label: "Mode", value: shadow.mode, note: "shadow only — it decides nothing" },
      { label: "Status", value: shadow.status, note: shadow.statusReason },
      { label: "Arm sample size", value: arm.sampleSize, unit: "closed outcomes" },
      { label: "Arm profit factor", value: arm.profitFactor },
      { label: "Arm expectancy", value: arm.expectancyPct, unit: "%" },
      { label: "Arm median return", value: arm.medianReturnPct, unit: "%" },
      { label: "Arm win rate", value: arm.winRate },
      { label: "Baseline profit factor", value: shadow.baseline.profitFactor, note: "the comparator, restricted to the same rows the rule can decide" },
      { label: "Shadow profit factor", value: shadow.shadow.profitFactor },
      { label: "Profit factor without the best winner", value: shadow.profitFactorExBest, note: shadow.tailRobustness },
      { label: "Prospective closed outcomes", value: shadow.prospectiveClosedOutcomes, unit: `of ${shadow.requiredClosedOutcomes} required` },
      { label: "Independent sessions", value: shadow.independentSessions, unit: `of ${shadow.requiredIndependentSessions} required` },
      { label: "Prospective start", value: shadow.prospectiveStartDate },
      { label: "Definition hash", value: shadow.definitionHash, note: shadow.definitionFrozen ? "unchanged since freeze" : "CHANGED — the sample is invalid" },
    );
    limitations.push(...shadow.limitations);
    mustNot.push(
      "SHADOW DOES NOT AFFECT LIVE CALLOUTS. Not one callout was rejected, delayed, "
      + "reordered or annotated by this rule.",
      "A shadow arm that beats its baseline is not a validated rule. Promotion is a human "
      + "act taken elsewhere and no status on this page is an approval.",
    );
    if (shadow.status === "INSUFFICIENT_EVIDENCE") {
      mustNot.push(
        `The evidence floors are not met (${shadow.prospectiveClosedOutcomes}/`
        + `${shadow.requiredClosedOutcomes} outcomes, ${shadow.independentSessions}/`
        + `${shadow.requiredIndependentSessions} sessions). Every arm figure above is a `
        + "reading, not a finding.",
      );
    }
  } else if (edge) {
    facts.push(
      { label: "Population", value: edge.population },
      { label: "Sample size", value: edge.sampleSize, unit: "closed outcomes" },
      { label: "Independent sessions", value: edge.independentSessions },
      { label: "Date range", value: `${edge.dateRange.from ?? "?"} to ${edge.dateRange.to ?? "?"}` },
      { label: "Evidence state", value: edge.evidenceState },
      { label: "Profit factor", value: edge.profitFactor },
      { label: "Profit factor without the best winner", value: edge.profitFactorExBest, note: "the tail-dependence check: how much of the result is one trade" },
      { label: "Expectancy", value: edge.expectancyPct, unit: "%" },
      { label: "Median return", value: edge.medianReturnPct, unit: "%" },
      { label: "Win rate", value: edge.winRate },
    );
    for (const [k, v] of Object.entries(edge.probabilities ?? {})) {
      facts.push({
        label: k, value: v.rate, unit: `${v.reached}/${v.of}`,
        note: v.rate == null ? "raw counts only — the excursion sample has not cleared its floors" : null,
      });
    }
    limitations.push(...edge.limitations);
    mustNot.push(NOT_SUBSCRIBER);
  }

  return {
    version: EXPLAIN_TARGET_VERSION,
    kind: "METRIC", id, resolved: true, unresolvedReason: null,
    title: info.label,
    definition: info,
    population: population ?? edge?.population ?? null,
    sampleSize: isShadowMetric && shadow ? shadow.shadow.sampleSize
      : isBaselineMetric && shadow ? shadow.baseline.sampleSize
        : edge?.sampleSize ?? null,
    independentSessions: isShadowMetric || isBaselineMetric
      ? shadow?.independentSessions ?? null
      : edge?.independentSessions ?? null,
    dateRange: edge?.dateRange ?? null,
    evidenceState: isShadowMetric || isBaselineMetric ? shadow?.status ?? null : edge?.evidenceState ?? null,
    facts, limitations,
    hasLiveAuthority: false,
    mustNotBeReadAs: mustNot,
  };
}

// ── CASE ─────────────────────────────────────────────────────────────────────

/**
 * One callout, explained by its EXACT case identity.
 *
 * Resolution is exact-match on the opportunity case id, and both identities of a
 * callout are accepted — the claim case that owns the delivery and the pending audit
 * case that owns the pre-move evidence — because a surface may legitimately hold
 * either one. Nothing is matched on symbol, strike or message text.
 */
function explainCase(id: string, ctx: ExplainContext): ExplainTarget {
  const row = (ctx.ownerRows ?? []).find(
    (r) => r.opportunityCaseId === id || r.preMoveCaseId === id,
  );
  if (!row) {
    return unresolved("CASE", id,
      `No owner callout resolves to case id "${id}". A callout is named by its case id, `
      + "never by ticker text: a symbol seen twice in one session has two answers and the "
      + "wrong one is indistinguishable from the right one.");
  }

  const facts: ExplainFact[] = [
    { label: "Case id (claim)", value: row.opportunityCaseId },
    { label: "Case id (pre-move audit)", value: row.preMoveCaseId, note: "a different row for the same callout" },
    { label: "Symbol", value: row.symbol },
    { label: "Side", value: row.side },
    { label: "Strategy", value: row.strategyKey ?? row.setupFamily },
    { label: "Exact OCC", value: row.optionSymbol },
    { label: "Contract the case froze", value: row.frozenOptionSymbol },
    { label: "Mirror is on the exact contract", value: row.occExact ? "yes" : "NO — censored, never priced" },
    { label: "Session", value: row.sessionDate },
    { label: "Entry", value: row.entryFill },
    { label: "Target 1", value: row.targetT1 },
    { label: "Target 2", value: row.targetT2 },
    { label: "Stop", value: row.stop },
    { label: "Status", value: row.status },
    { label: "Exit reason", value: row.exitReason },
    { label: "Realized return", value: row.realizedReturnPct, unit: "%", note: "what the trade actually closed at" },
    { label: "Realized evidence", value: row.realizedEvidence },
    { label: "MFE (peak)", value: row.mfePct, unit: "%", note: "the best the contract printed — NOT the result" },
    { label: "MAE (worst)", value: row.maePct, unit: "%" },
    { label: "Excursion evidence", value: row.excursionState },
    { label: "Marks on the frozen contract", value: row.marksOnContract },
    { label: "Path label", value: row.pathLabel },
    { label: "Flags", value: (row.flags ?? []).join(", ") || "none" },
    { label: "Selection strength", value: row.selection?.selectionStrength, note: "the SELECTED strategy's 0-100 score, frozen at callout" },
    { label: "Delivery quality", value: row.selection?.deliveryQualityScore, note: "a DIFFERENT quantity from selection strength" },
    { label: "Signal verdict", value: row.selection?.signalVerdict },
    { label: "Discovery stage (V1)", value: row.selection?.discoveryStage, note: "V1 measures a ~1.6s window; read V2 instead once it has evidence" },
    { label: "Reward remaining band", value: row.selection?.rewardRemainingBand },
    { label: "Stop slippage", value: row.stopEvidence?.stopSlippagePct, unit: "%" },
    { label: "Overnight gap", value: row.stopEvidence?.overnightGapPct, unit: "%" },
    { label: "Crossed a session boundary", value: row.stopEvidence?.crossedSessionBoundary ? "yes" : "no" },
  ];
  for (const [ms, v] of Object.entries(row.msToMilestone ?? {})) {
    facts.push({
      label: `Time to +${ms}%`, value: v == null ? null : Math.round((v as number) / 60_000), unit: "min",
      note: v == null ? "never reached — null, not zero" : "measured from entry on the frozen contract",
    });
  }

  return {
    version: EXPLAIN_TARGET_VERSION,
    kind: "CASE", id, resolved: true, unresolvedReason: null,
    title: `${row.symbol ?? "?"} ${row.side ?? ""} ${row.optionSymbol ?? ""}`.trim(),
    definition: null,
    population: "OWNER_VALIDATION_PAPER",
    sampleSize: 1,
    independentSessions: 1,
    dateRange: { from: row.sessionDate, to: row.exitSessionDate ?? row.sessionDate },
    evidenceState: row.realizedEvidence,
    facts,
    limitations: row.limitations ?? [],
    hasLiveAuthority: false,
    mustNotBeReadAs: [
      NO_LIVE_AUTHORITY,
      NOT_SUBSCRIBER,
      "The MFE is the best price the contract printed, not the result. Quoting it as the "
      + "outcome is the most flattering possible way to be wrong about this trade.",
      "One trade is an anecdote. It establishes nothing about the lane.",
    ],
  };
}

// ── EXPERIMENT ───────────────────────────────────────────────────────────────

function explainExperiment(id: string, ctx: ExplainContext): ExplainTarget {
  const e = (ctx.shadowExperiments ?? []).find((x) => x.experimentId === id);
  if (!e) {
    return unresolved("EXPERIMENT", id, `No registered experiment has id "${id}".`);
  }
  const frozenNote = e.definitionFrozen
    ? "unchanged since freeze"
    : "CHANGED SINCE FREEZE — every outcome collected before and after this change describes a different rule, and the sample is invalid";
  return {
    version: EXPLAIN_TARGET_VERSION,
    kind: "EXPERIMENT", id, resolved: true, unresolvedReason: null,
    title: `${e.experimentId} v${e.experimentVersion}`,
    definition: null,
    population: "OWNER_VALIDATION_PAPER, restricted to rows the rule can decide",
    sampleSize: e.prospectiveClosedOutcomes,
    independentSessions: e.independentSessions,
    dateRange: { from: e.prospectiveStartDate, to: null },
    evidenceState: e.status,
    facts: [
      { label: "Mode", value: e.mode, note: "shadow only" },
      { label: "Status", value: e.status, note: e.statusReason },
      { label: "Definition hash", value: e.definitionHash, note: frozenNote },
      { label: "Prospective start", value: e.prospectiveStartDate },
      { label: "Prospective closed outcomes", value: e.prospectiveClosedOutcomes, unit: `of ${e.requiredClosedOutcomes} required` },
      { label: "Independent sessions", value: e.independentSessions, unit: `of ${e.requiredIndependentSessions} required` },
      { label: "Baseline profit factor", value: e.baseline.profitFactor, note: `over ${e.baseline.sampleSize} outcomes` },
      { label: "Baseline expectancy", value: e.baseline.expectancyPct, unit: "%" },
      { label: "Baseline median return", value: e.baseline.medianReturnPct, unit: "%" },
      { label: "Baseline win rate", value: e.baseline.winRate },
      { label: "Shadow profit factor", value: e.shadow.profitFactor, note: `over ${e.shadow.sampleSize} outcomes` },
      { label: "Shadow expectancy", value: e.shadow.expectancyPct, unit: "%" },
      { label: "Shadow median return", value: e.shadow.medianReturnPct, unit: "%" },
      { label: "Shadow win rate", value: e.shadow.winRate },
      { label: "Winner retention", value: e.winnerRetention, note: "the share of winners the rule would have KEPT" },
      { label: "Loss rejection", value: e.lossRejection, note: "the share of losses the rule would have dropped" },
      { label: "Winners rejected", value: e.winnersRejected, note: "a filter's winners are its true cost, and this is reported first" },
      { label: "Profit factor without the best winner", value: e.profitFactorExBest, note: e.tailRobustness },
      { label: "Has live authority", value: "NO" },
    ],
    limitations: [...e.limitations],
    mustNotBeReadAs: [
      NO_LIVE_AUTHORITY,
      "SHADOW DOES NOT AFFECT LIVE CALLOUTS.",
      "The verdict is derived from PROSPECTIVE outcomes only. In-sample figures describe "
      + "the window the rule was read from and cannot test it.",
      "The best reachable status is READY_FOR_HUMAN_REVIEW. That is a request for "
      + "attention, not an approval, and no status promotes anything.",
    ],
    hasLiveAuthority: false,
  };
}

// ── COHORT ───────────────────────────────────────────────────────────────────

function explainCohort(id: string, ctx: ExplainContext): ExplainTarget {
  const edge = ctx.currentEdge;
  if (!edge || (id !== edge.population && id !== "CURRENT_EDGE")) {
    return unresolved("COHORT", id,
      `No population resolves to "${id}". Populations are named by their lane key so two `
      + "lanes can never be pooled into a cohort that has never existed.");
  }
  const facts: ExplainFact[] = [
    { label: "Population", value: edge.population },
    { label: "Sample size", value: edge.sampleSize, unit: "closed outcomes" },
    { label: "Independent sessions", value: edge.independentSessions },
    { label: "Date range", value: `${edge.dateRange.from ?? "?"} to ${edge.dateRange.to ?? "?"}` },
    { label: "Realized evidence state", value: edge.evidenceState },
    { label: "Excursion evidence state", value: edge.excursionEvidenceState, note: "gated separately and more strictly than the realized figures" },
    { label: "Profit factor", value: edge.profitFactor },
    { label: "Profit factor without the best winner", value: edge.profitFactorExBest },
    { label: "Expectancy", value: edge.expectancyPct, unit: "%" },
    { label: "Median return", value: edge.medianReturnPct, unit: "%" },
    { label: "Win rate", value: edge.winRate },
  ];
  for (const [k, v] of Object.entries(edge.probabilities ?? {})) {
    facts.push({ label: k, value: v.rate, unit: `${v.reached}/${v.of}` });
  }
  return {
    version: EXPLAIN_TARGET_VERSION,
    kind: "COHORT", id, resolved: true, unresolvedReason: null,
    title: edge.population,
    definition: metricInfo("sampleSize"),
    population: edge.population,
    sampleSize: edge.sampleSize,
    independentSessions: edge.independentSessions,
    dateRange: edge.dateRange,
    evidenceState: edge.evidenceState,
    facts,
    limitations: edge.limitations,
    hasLiveAuthority: false,
    mustNotBeReadAs: [NO_LIVE_AUTHORITY, NOT_SUBSCRIBER],
  };
}

// ── entry point ──────────────────────────────────────────────────────────────

/** The already-built research context an explanation reads from. Never re-queried. */
export interface ExplainContext {
  currentEdge?: {
    population: string; sampleSize: number; independentSessions: number;
    dateRange: { from: string | null; to: string | null };
    evidenceState: string; excursionEvidenceState: string;
    profitFactor: number | null; expectancyPct: number | null;
    medianReturnPct: number | null; winRate: number | null;
    profitFactorExBest: number | null;
    probabilities: Record<string, { rate: number | null; reached: number; of: number }>;
    limitations: string[];
  } | null;
  shadowExperiments?: Array<{
    experimentId: string; experimentVersion: number; mode: string;
    definitionHash: string; definitionFrozen: boolean; prospectiveStartDate: string;
    status: string; statusReason: string;
    prospectiveClosedOutcomes: number; requiredClosedOutcomes: number;
    independentSessions: number; requiredIndependentSessions: number;
    baseline: { profitFactor: number | null; expectancyPct: number | null; medianReturnPct: number | null; winRate: number | null; sampleSize: number };
    shadow: { profitFactor: number | null; expectancyPct: number | null; medianReturnPct: number | null; winRate: number | null; sampleSize: number };
    winnerRetention: number | null; lossRejection: number | null; winnersRejected: number | null;
    profitFactorExBest: number | null; tailRobustness: string;
    limitations: readonly string[];
  }>;
  ownerRows?: any[];
}

/**
 * Resolve one explain target deterministically.
 *
 * NEVER throws and never returns null: an unresolvable target is an ExplainTarget with
 * `resolved: false` and a reason, so the panel renders the refusal instead of blanking.
 */
export function buildExplainTarget(req: ExplainRequest, ctx: ExplainContext): ExplainTarget {
  const kind = String(req?.kind ?? "").toUpperCase() as ExplainKind;
  const id = String(req?.id ?? "").trim();
  if (!EXPLAIN_KINDS.includes(kind)) {
    return unresolved("METRIC", id, `"${req?.kind}" is not an explainable kind.`);
  }
  if (!id) return unresolved(kind, "", "No identifier was supplied. Targets are named by a stable id, never by text.");
  try {
    if (kind === "METRIC") return explainMetric(id, req.population ?? null, ctx);
    if (kind === "CASE") return explainCase(id, ctx);
    if (kind === "EXPERIMENT") return explainExperiment(id, ctx);
    return explainCohort(id, ctx);
  } catch (err: any) {
    return unresolved(kind, id, `resolution failed: ${String(err?.message ?? err).slice(0, 160)}`);
  }
}

/**
 * The question put to Ask OptiScan for a resolved target.
 *
 * Deterministic and bounded. The model is asked to EXPLAIN what the evidence already
 * says — it is never asked what the number means for a decision, because that question
 * has no answer the evidence can support and every answer to it reads as advice.
 */
export function explainQuestionFor(target: ExplainTarget): string {
  if (!target.resolved) {
    return `Explain why "${target.id}" could not be resolved: ${target.unresolvedReason}`;
  }
  if (target.kind === "METRIC") {
    return `Explain the metric "${target.title}" for the ${target.population ?? "current"} population: `
      + "what it measures, what its current value rests on, how large the sample and how many "
      + "independent sessions, whether removing the single best winner changes the picture, and "
      + "what it does NOT establish. Do not recommend an action.";
  }
  if (target.kind === "CASE") {
    return `Explain callout ${target.id} (${target.title}): why the setup qualified, the strategy `
      + "and its selection strength, the contract, entry, targets and stop, how the trade actually "
      + "travelled, what it realized, and how that differs from its peak. Do not recommend an action.";
  }
  if (target.kind === "EXPERIMENT") {
    return `Explain experiment ${target.id}: its hypothesis, what the baseline and shadow arms are, `
      + "why it exists, its sample and session counts against the required floors, its winner "
      + "retention and loss rejection, whether it survives removing its best winner, its "
      + "limitations, and whether it has any live authority. Do not recommend promoting it.";
  }
  return `Explain the ${target.title} population: what it contains, over what dates and how many `
    + "independent sessions, what its evidence state means, and what it does NOT establish. "
    + "Do not recommend an action.";
}

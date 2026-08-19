/**
 * advisory-chat-evidence.ts — PURE evidence packet + numeric validation for the
 * advisory chatbot.
 *
 * The chatbot is allowed to explain, compare, and suggest investigations. It is NOT
 * allowed to introduce a number. Every figure in an answer must trace back to a
 * canonical MetricEvidence entry built from the deterministic findings report, and
 * an answer that fails validation is discarded rather than shown.
 *
 * NOTHING here performs I/O, calls a model, or touches production state. Two
 * deliberate design choices:
 *  - Missing stays missing. A metric with a null value is never rendered as 0, and
 *    a null sample size is never treated as "no sample" — the difference matters.
 *  - Windows and pipelines never merge. Two metrics from different lanes or
 *    windows cannot be combined into one claim, because the combined number would
 *    describe a cohort that never existed.
 */
import type { CanonicalFindingsReport, MetricEvidence } from "./findings-report.ts";

export const ADVISORY_CHAT_AUTHORITY = "ADVISORY_ONLY" as const;

export type ChatMode = "EXPLAIN" | "INVESTIGATE" | "COMPARE" | "BUILD_FIX_PROMPT";
export const CHAT_MODES: ChatMode[] = ["EXPLAIN", "INVESTIGATE", "COMPARE", "BUILD_FIX_PROMPT"];

/** One citable fact the model may use. Values are pre-formatted for exactness. */
export interface EvidenceItem {
  id: string;
  label: string;
  value: number | string | null;
  unit: string | null;
  pipeline: string;
  lane: string;
  timeWindow: string;
  sampleSize: number | null;
  confidence: string;
  qualityStatus: string;
  freshness: string;
  sourceRef: string;
  meaning: string;
  safeForTopLine: boolean;
  /** Every numeric string form this value may legitimately appear as. */
  numericForms: string[];
}

export interface EvidencePacket {
  reportId: string;
  generatedAtMs: number;
  tradingDay: string | null;
  overallState: string;
  activeProductionPipeline: string;
  items: EvidenceItem[];
  dataGaps: string[];
  /** Constraints the answer MUST respect, restated to the model verbatim. */
  mandatoryCaveats: string[];
  safety: {
    aiAuthority: typeof ADVISORY_CHAT_AUTHORITY;
    productionBehaviorChanged: false;
  };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** All string spellings of a number a model might reasonably emit. */
function numericForms(value: number): string[] {
  const forms = new Set<string>();
  const abs = Math.abs(value);
  for (const digits of [0, 1, 2, 3, 4]) forms.add(abs.toFixed(digits));
  forms.add(String(abs));
  // Trailing-zero-trimmed variants ("20.0" -> "20").
  for (const f of [...forms]) {
    if (f.includes(".")) forms.add(f.replace(/\.?0+$/, ""));
  }
  // Thousands separators ("6242" -> "6,242").
  for (const f of [...forms]) {
    const [int, frac] = f.split(".");
    if (int.length > 3) {
      const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      forms.add(frac ? `${grouped}.${frac}` : grouped);
    }
  }
  forms.delete("");
  return [...forms];
}

function itemFromMetric(m: MetricEvidence): EvidenceItem {
  const forms = isNum(m.value) ? numericForms(m.value) : [];
  return {
    id: m.id,
    label: m.label,
    value: m.value,
    unit: m.unit ?? null,
    pipeline: String(m.pipeline),
    lane: m.lane,
    timeWindow: m.timeWindow,
    sampleSize: m.sampleSize,
    confidence: m.confidence,
    qualityStatus: m.qualityStatus,
    freshness: m.freshness,
    sourceRef: `${m.source?.table ?? "n/a"}/${m.source?.function ?? "n/a"}/${m.source?.field ?? "n/a"}`,
    meaning: m.meaning,
    safeForTopLine: m.safeForTopLine,
    numericForms: forms,
  };
}

/**
 * Extra evidence the chat may cite that lives outside the findings report: the
 * shadow exit-policy result and the Watchlist evidence gate. Both are optional;
 * when absent the chatbot simply cannot make claims about them.
 */
export interface SupplementalEvidence {
  exitPolicy?: {
    minimumSupportedSample: number;
    bestSupportedPolicy: string | null;
    profitableThenLostCount: number;
    profitableTradeCount: number;
    policies: Array<{
      policy: string; sampleSize: number; winRatePct: number | null;
      averageReturnPct: number | null; totalPnlUsd: number; supported: boolean;
    }>;
  } | null;
  watchlist?: {
    publishedCount: number;
    candidatesConsidered: number;
    vwapUsable: number;
    vwapUnavailable: number;
    marketContextAvailable: boolean;
    blockers: string[];
  } | null;
  /**
   * The owner validation lane and its pre-move discovery evidence.
   *
   * Without these the chat could describe exit policies and watchlists in detail and
   * could not answer the questions the owner actually asks — "did you find this before
   * it ran", "how early", "how much reward was left". It had no evidence item carrying
   * a discovery stage or a lead time, and the validator correctly refuses any number it
   * cannot cite, so those questions were unanswerable rather than wrong.
   *
   * The two mirror rates are carried SEPARATELY and deliberately: `mirrorRate` judges
   * whether the mirror fix holds, `postInstrumentationMirrorRate` judges whether a
   * failure can explain itself. They cover different populations and merging them would
   * let three permanently undiagnosable failures describe an instrumented period.
   */
  ownerLane?: {
    openings: number;
    mirroredExact: number;
    mirrorRate: number | null;
    postInstrumentationOpenings: number;
    postInstrumentationMirrorRate: number | null;
    postInstrumentationVerdict: string;
    realizedVerified: number;
    realizedStillOpen: number;
    excursionVerified: number;
  } | null;
  /**
   * The historical lane: what the durable store holds, what the replay record found,
   * and what the shadow model makes of it.
   *
   * Carried separately from every live figure above, and every item says so in its
   * `pipeline`. A replay-derived statistic and a live measurement answer different
   * questions, and a chat that can cite a number WILL cite it — so if the two ever
   * shared a label, "we have seen 40 setups like this" would silently mean
   * "we reconstructed 40 from a backfill whose coverage we did not state".
   */
  historical?: {
    /** Possession, not entitlement. Zero rows here means no historical claim is supported. */
    barRows: number;
    barSymbols: number;
    optionQuoteRows: number;
    optionQuoteContracts: number;
    optionTradeRows: number;
    contractReferenceRows: number;
    earliestIngestedMs: number | null;
    latestIngestedMs: number | null;
    /** Winner-event extraction over real cases. */
    eventsExamined: number;
    events: number;
    /** No stored quote at the entry instant: a COVERAGE gap, not a flat trade. */
    refusedNoEntry: number;
    reached25: number;
    reached50: number;
    reached100: number;
    /** Cohort V2. */
    cohortId: string | null;
    cohortLane: string | null;
    cohortEvents: number;
    cohortSessions: number;
    cohortVerdict: string;
    pReached25: number | null;
    pReached50: number | null;
    expectedReturnPct: number | null;
    profitFactor: number | null;
    profitFactorExBest: number | null;
    survivesBestExcluded: boolean | null;
    /** Shadow model. */
    shadowState: string;
    shadowScore: number | null;
    shadowComponentsScored: number;
    shadowComponentsDefined: number;
    replayVersion: string | null;
    warnings: string[];
  } | null;
  /**
   * ONE resolved "Explain this" target, when the owner clicked something.
   *
   * Carried as supplemental evidence rather than as a second chatbot: the same
   * validator judges the answer, the same budget meters the call, and the same
   * ADVISORY_ONLY authority applies. Its facts enter the registry so the model may
   * quote them — and, because the registry IS what the validator checks against,
   * "the model may say it" and "the model may not invent it" cannot drift apart.
   */
  explainTarget?: {
    kind: string;
    id: string;
    resolved: boolean;
    title: string;
    population: string | null;
    sampleSize: number | null;
    independentSessions: number | null;
    evidenceState: string | null;
    facts: Array<{ label: string; value: number | string | null; unit?: string | null; note?: string | null }>;
    limitations: string[];
    mustNotBeReadAs: string[];
  } | null;
  preMove?: {
    examined: number;
    withOwnerAlert: number;
    earlyRate: number | null;
    tooLateRate: number | null;
    preTrigger: number;
    tooLate: number;
    ungradable: number;
    medianPremiumConsumedBeforeAlertPct: number | null;
    medianRewardRemainingFraction: number | null;
    milestone25Reached: number;
    milestone25Of: number;
  } | null;
}

function supplementalItems(supp: SupplementalEvidence | undefined): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const push = (
    id: string, label: string, value: number | string | null, unit: string | null,
    lane: string, sampleSize: number | null, meaning: string, quality = "VALID",
  ) => {
    items.push({
      id, label, value, unit,
      pipeline: "options_delivered_paper",
      lane, timeWindow: "all_verified_history", sampleSize,
      confidence: sampleSize == null ? "LOW" : sampleSize >= 30 ? "HIGH" : sampleSize >= 10 ? "MEDIUM" : "LOW",
      qualityStatus: quality, freshness: "current",
      sourceRef: "options_paper_marks/analyzeExitPolicies/returnPct",
      meaning, safeForTopLine: true,
      numericForms: isNum(value) ? numericForms(value) : [],
    });
  };

  const ep = supp?.exitPolicy;
  if (ep) {
    push("exit.minimumSupportedSample", "Minimum sample before a policy counts as supported",
      ep.minimumSupportedSample, "trades", "exit_policy_shadow", null,
      "A shadow policy is never recommended below this many trades.");
    push("exit.profitableThenLostCount", "Trades that were profitable and still closed at a loss",
      ep.profitableThenLostCount, "trades", "exit_policy_shadow", ep.profitableTradeCount,
      "How often a real gain was given back by the current exit.");
    push("exit.profitableTradeCount", "Trades that reached any gain",
      ep.profitableTradeCount, "trades", "exit_policy_shadow", ep.profitableTradeCount,
      "The denominator for profit giveback.");
    for (const p of ep.policies) {
      const slug = p.policy.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
      push(`exit.policy.${slug}.avgReturnPct`, `${p.policy} — average return`,
        p.averageReturnPct, "%", "exit_policy_shadow", p.sampleSize,
        `Average shadow result for ${p.policy}. Shadow only; never applied to live exits.`,
        p.supported ? "VALID" : "MISSING_DATA");
      push(`exit.policy.${slug}.totalPnlUsd`, `${p.policy} — total shadow P&L`,
        p.totalPnlUsd, "USD", "exit_policy_shadow", p.sampleSize,
        `Total shadow dollars for ${p.policy}.`, p.supported ? "VALID" : "MISSING_DATA");
      push(`exit.policy.${slug}.winRatePct`, `${p.policy} — win rate`,
        p.winRatePct, "%", "exit_policy_shadow", p.sampleSize,
        `Share of shadow trades closing positive under ${p.policy}.`,
        p.supported ? "VALID" : "MISSING_DATA");
      push(`exit.policy.${slug}.sampleSize`, `${p.policy} — sample size`,
        p.sampleSize, "trades", "exit_policy_shadow", p.sampleSize,
        `Trades evaluated under ${p.policy}.`);
    }
  }

  const wl = supp?.watchlist;
  if (wl) {
    const w = (id: string, label: string, value: number | string | null, unit: string | null, meaning: string) => {
      items.push({
        id, label, value, unit,
        pipeline: "watchlist_next_session", lane: "watchlist_evidence_gate",
        timeWindow: "current_planning_day", sampleSize: wl.candidatesConsidered,
        confidence: "HIGH", qualityStatus: "VALID", freshness: "current",
        sourceRef: "overnight_plan_snapshots/buildNextSessionPlan/evidenceCompleteness",
        meaning, safeForTopLine: true,
        numericForms: isNum(value) ? numericForms(value) : [],
      });
    };
    w("watchlist.publishedCount", "Qualified Watchlist plans published", wl.publishedCount, "rows",
      "How many next-session plans passed the evidence gate.");
    w("watchlist.candidatesConsidered", "Candidates considered", wl.candidatesConsidered, "rows",
      "Prior-session alerts evaluated for the Watchlist.");
    w("watchlist.vwapUsable", "Candidates with a usable VWAP reference", wl.vwapUsable, "rows",
      "A plan needs a real prior-session VWAP; this is how many have one.");
    w("watchlist.vwapUnavailable", "Candidates with no usable VWAP", wl.vwapUnavailable, "rows",
      "These cannot produce a plan until VWAP evidence exists.");
    w("watchlist.marketContextAvailable", "Persisted SPY/QQQ context usable",
      wl.marketContextAvailable ? "yes" : "no", null,
      "A qualified plan also requires usable persisted market context.");
  }

  const ol = supp?.ownerLane;
  if (ol) {
    const o = (id: string, label: string, value: number | string | null, unit: string | null, sample: number | null, meaning: string) => {
      items.push({
        id, label, value, unit,
        pipeline: "owner_validation_paper", lane: "owner_validation",
        timeWindow: "prospective_since_mirror_fix", sampleSize: sample,
        confidence: sample == null ? "LOW" : sample >= 30 ? "HIGH" : sample >= 10 ? "MEDIUM" : "LOW",
        qualityStatus: value == null ? "MISSING_DATA" : "VALID", freshness: "current",
        sourceRef: "discord_deliveries/auditOwnerMirrorsOnDb",
        meaning, safeForTopLine: true,
        numericForms: isNum(value) ? numericForms(value) : [],
      });
    };
    o("owner.openings", "Owner openings delivered", ol.openings, "alerts", ol.openings,
      "Private owner alerts actually sent. Never a subscriber figure.");
    o("owner.mirroredExact", "Owner openings mirrored on the exact contract", ol.mirroredExact, "alerts", ol.openings,
      "An opening without a same-OCC mirror produces no forward evidence at all.");
    o("owner.mirrorRate", "Owner mirror rate since the mirror fix", ol.mirrorRate, "ratio", ol.openings,
      "Judges whether the mirror FIX holds. Includes failures that predate reason capture.");
    o("owner.postInstrumentation.openings", "Owner openings since reason capture shipped",
      ol.postInstrumentationOpenings, "alerts", ol.postInstrumentationOpenings,
      "Only these can name WHY a mirror was missing. A different population from the rate above.");
    o("owner.postInstrumentation.mirrorRate", "Mirror rate since reason capture shipped",
      ol.postInstrumentationMirrorRate, "ratio", ol.postInstrumentationOpenings,
      "Judges DIAGNOSABILITY, not the fix. A small clean sample is not evidence the fix holds.");
    o("owner.postInstrumentation.verdict", "Post-instrumentation verdict",
      ol.postInstrumentationVerdict, null, ol.postInstrumentationOpenings,
      "NO_NEW_FAILURE_OBSERVED means exactly that and nothing more.");
    o("owner.realizedVerified", "Owner mirrors with a verified realized return", ol.realizedVerified, "trades", ol.openings,
      "Closed on the frozen contract and priced against the frozen entry.");
    o("owner.realizedStillOpen", "Owner mirrors still open", ol.realizedStillOpen, "trades", ol.openings,
      "Not a zero return — an outcome that has not happened yet.");
    o("owner.excursionVerified", "Owner mirrors with a VERIFIED excursion", ol.excursionVerified, "trades", ol.openings,
      "Enough same-contract marks to state the observed extremes. A realized win does not imply this.");
  }

  // ── the "Explain this" target ───────────────────────────────────────────────
  //
  // Emitted LAST and under its own pipeline so it can never be mistaken for a lane
  // statistic. Every fact keeps the label the deterministic resolver gave it: a value
  // the model quotes must be traceable to the exact row the panel rendered, not to a
  // paraphrase of it.
  const et = supp?.explainTarget;
  if (et && et.resolved) {
    for (const [i, f] of et.facts.entries()) {
      const numeric = isNum(f.value);
      items.push({
        id: `explain.${et.kind.toLowerCase()}.${i}`,
        label: f.label,
        value: f.value,
        unit: f.unit ?? null,
        pipeline: `explain_${et.kind.toLowerCase()}`,
        lane: et.population ?? "unspecified",
        timeWindow: "as_rendered",
        sampleSize: et.sampleSize,
        confidence: et.sampleSize == null ? "LOW" : et.sampleSize >= 30 ? "HIGH" : et.sampleSize >= 10 ? "MEDIUM" : "LOW",
        qualityStatus: f.value == null ? "MISSING_DATA" : "VALID",
        freshness: "current",
        sourceRef: `explain-target/${et.kind}/${et.id}`,
        meaning: f.note ?? `${f.label} for ${et.title}.`,
        // A single trade's figure is true and is NOT a headline: one callout establishes
        // nothing about the lane, and a top-line claim built from it would be an anecdote
        // wearing a statistic's clothes.
        safeForTopLine: et.kind !== "CASE",
        numericForms: numeric ? numericForms(f.value as number) : [],
      });
    }
  }

  const pm = supp?.preMove;
  if (pm) {
    const p = (id: string, label: string, value: number | string | null, unit: string | null, sample: number | null, meaning: string) => {
      items.push({
        id, label, value, unit,
        pipeline: "pre_move_discovery_v1", lane: "owner_validation",
        timeWindow: "since_capture_shipped", sampleSize: sample,
        confidence: sample == null ? "LOW" : sample >= 30 ? "HIGH" : sample >= 10 ? "MEDIUM" : "LOW",
        qualityStatus: value == null ? "MISSING_DATA" : "VALID", freshness: "current",
        sourceRef: "opportunity_pre_move_discovery/classifyDiscovery",
        meaning, safeForTopLine: true,
        numericForms: isNum(value) ? numericForms(value) : [],
      });
    };
    p("premove.examined", "Owner-lane discovery rows captured", pm.examined, "rows", pm.examined,
      "Prospective only. Historical cases have no capture and none was invented.");
    p("premove.earlyRate", "Share found PRE_TRIGGER or EARLY", pm.earlyRate, "ratio", pm.examined,
      "Computed over GRADABLE rows only, so missing inputs cannot read as late discoveries.");
    p("premove.tooLateRate", "Share found TOO_LATE", pm.tooLateRate, "ratio", pm.examined,
      "The move was effectively complete when we alerted.");
    p("premove.preTrigger", "Discoveries before the trigger was taken", pm.preTrigger, "rows", pm.examined,
      "A statement about structure: the favourable move had not begun.");
    p("premove.tooLate", "Discoveries after the move was spent", pm.tooLate, "rows", pm.examined,
      "Buying here is buying what already happened.");
    p("premove.ungradable", "Discoveries with insufficient inputs", pm.ungradable, "rows", pm.examined,
      "An admission, not a stage. Excluded from every rate above.");
    p("premove.medianPremiumConsumedBeforeAlertPct", "Median premium already paid for before the alert",
      pm.medianPremiumConsumedBeforeAlertPct, "%", pm.withOwnerAlert,
      "Large means the alert was late however good the realized return looked.");
    p("premove.medianRewardRemainingFraction", "Median share of the session's favourable move still unspent",
      pm.medianRewardRemainingFraction, "ratio", pm.withOwnerAlert,
      "Advisory. Says how much of what the day already offered remained — never that the move will continue.");
    p("premove.milestone25Reached", "Alerts reaching +25% AFTER the alert", pm.milestone25Reached, "trades", pm.milestone25Of,
      "Measured from the alert. A milestone reached before it is never counted here.");
    p("premove.milestone25Of", "Alerts with same-contract marks to measure", pm.milestone25Of, "trades", pm.milestone25Of,
      "The denominator. An unmarked alert is unmeasured, not a failure to reach +25%.");
  }

  const h = supp?.historical;
  if (h) {
    const hi = (id: string, label: string, value: number | string | boolean | null, unit: string | null, sample: number | null, meaning: string) => {
      items.push({
        id, label, value: typeof value === "boolean" ? (value ? "yes" : "no") : value, unit,
        pipeline: "historical_replay", lane: h.cohortLane ?? "REPLAY_HISTORICAL",
        timeWindow: "durable historical store", sampleSize: sample,
        confidence: sample == null ? "LOW" : sample >= 100 ? "HIGH" : sample >= 20 ? "MEDIUM" : "LOW",
        qualityStatus: value == null ? "MISSING_DATA" : "VALID", freshness: "historical",
        sourceRef: "historical_option_quotes/forwardExcursionOnDb/HISTORICAL_COHORT_V2",
        meaning, safeForTopLine: true,
        numericForms: isNum(value) ? numericForms(value) : [],
      });
    };

    // Possession first. Every figure below is meaningless if these are zero, and a
    // reader must be able to see that before reading anything else.
    hi("hist.barRows", "Historical underlying bars stored", h.barRows, "rows", h.barRows,
      "POSSESSION, not entitlement. Zero means no historical reconstruction is possible at all.");
    hi("hist.barSymbols", "Symbols with stored bars", h.barSymbols, "symbols", h.barRows, "Breadth of the reconstructable universe.");
    hi("hist.optionQuoteRows", "Historical NBBO rows stored", h.optionQuoteRows, "rows", h.optionQuoteRows,
      "Executable quotes. The ONLY store that can answer what could have been paid.");
    hi("hist.optionQuoteContracts", "Exact contracts with stored NBBO", h.optionQuoteContracts, "contracts", h.optionQuoteRows, "Distinct OCCs.");
    hi("hist.optionTradeRows", "Historical trade prints stored", h.optionTradeRows, "rows", h.optionTradeRows,
      "Where the contract traded. NEVER substituted for an executable quote.");
    hi("hist.contractReferenceRows", "Expired-inclusive contracts resolved", h.contractReferenceRows, "contracts", h.contractReferenceRows,
      "Without these an expired OCC cannot be described at all.");

    hi("hist.eventsExamined", "Historical candidates examined", h.eventsExamined, "candidates", h.eventsExamined,
      "Real opportunity cases with a frozen OCC.");
    hi("hist.events", "Historical events extracted", h.events, "events", h.eventsExamined,
      "Candidates that had an executable entry quote. A contract that went nowhere IS an event.");
    hi("hist.refusedNoEntry", "Candidates with no stored entry quote", h.refusedNoEntry, "candidates", h.eventsExamined,
      "A COVERAGE gap, not evidence of no move. Never pooled with events that went nowhere.");
    hi("hist.reached25", "Historical events reaching +25%", h.reached25, "events", h.events, "Measured from the ask at entry.");
    hi("hist.reached50", "Historical events reaching +50%", h.reached50, "events", h.events, "Measured from the ask at entry.");
    hi("hist.reached100", "Historical events reaching +100%", h.reached100, "events", h.events, "Measured from the ask at entry.");

    hi("hist.cohortEvents", "Cohort sample size", h.cohortEvents, "events", h.cohortEvents, "Events in the comparable cohort.");
    hi("hist.cohortSessions", "Cohort independent sessions", h.cohortSessions, "sessions", h.cohortEvents,
      "Twenty events from one morning are ONE observation of one market.");
    hi("hist.cohortVerdict", "Cohort evidence verdict", h.cohortVerdict, null, h.cohortEvents,
      "INSUFFICIENT_EVIDENCE means the floors were not met — it does not mean no edge.");
    hi("hist.pReached25", "P(+25%) from history", h.pReached25, "ratio", h.cohortEvents,
      "Null unless BOTH floors are met. A null is not a low probability.");
    hi("hist.pReached50", "P(+50%) from history", h.pReached50, "ratio", h.cohortEvents,
      "Null unless BOTH floors are met.");
    hi("hist.expectedReturnPct", "Historical expected return", h.expectedReturnPct, "%", h.cohortEvents,
      "Last observed value per event, never the peak.");
    hi("hist.profitFactor", "Historical profit factor", h.profitFactor, "ratio", h.cohortEvents, "Gross win over gross loss.");
    hi("hist.profitFactorExBest", "Profit factor without the best event", h.profitFactorExBest, "ratio", h.cohortEvents,
      "The tail-dependence check. A large gap between this and the headline means one trade carried it.");
    hi("hist.survivesBestExcluded", "Edge survives removing the best event", h.survivesBestExcluded, null, h.cohortEvents,
      "A cohort driven by one giant winner is a tail, not an edge.");

    hi("hist.shadowState", "Historical Edge Shadow state", h.shadowState, null, h.cohortEvents,
      "SHADOW ONLY. Never affects live ranking. INSUFFICIENT_HISTORICAL_EVIDENCE yields a NULL score, not a low one.");
    hi("hist.shadowScore", "Historical Edge Shadow score", h.shadowScore, "0..1", h.cohortEvents,
      "Advisory. Null when evidence is insufficient — absence must never read as a favourable zero.");
    hi("hist.shadowComponentsScored", "Shadow components with evidence", h.shadowComponentsScored, "components", h.shadowComponentsDefined,
      "How much of the model actually had inputs. A score from 2 components and one from 10 are different claims.");
  }

  return items;
}

/** Caveats the answer must respect. These are asserted, not left to the model. */
function mandatoryCaveats(supp: SupplementalEvidence | undefined): string[] {
  const out = [
    "AI authority is ADVISORY ONLY. Nothing in this answer changes production behaviour.",
    "No exit rule, threshold, or scanner formula is ever changed automatically; a human reviews and deploys code.",
  ];
  const ep = supp?.exitPolicy;
  if (ep?.bestSupportedPolicy) {
    const best = ep.policies.find((p) => p.policy === ep.bestSupportedPolicy);
    const current = ep.policies.find((p) => p.policy === "Current policy");
    if (best && isNum(best.averageReturnPct) && best.averageReturnPct < 0) {
      out.push(
        `${ep.bestSupportedPolicy} is only LESS BAD than the current policy, not profitable: its average shadow return is ${best.averageReturnPct}%${
          current && isNum(current.averageReturnPct) ? ` versus ${current.averageReturnPct}% for the current policy` : ""
        }. It must never be described as a winning or profitable policy.`,
      );
    }
  }
  for (const p of ep?.policies ?? []) {
    if (p.sampleSize === 0) {
      out.push(`${p.policy} has no evaluable trades (sample size 0) because the required timestamped observations are not stored. It cannot be compared or recommended.`);
    } else if (!p.supported) {
      out.push(`${p.policy} is below the minimum supported sample (${p.sampleSize} of ${ep?.minimumSupportedSample ?? "?"}) and cannot be recommended.`);
    }
  }
  // The explain target's own "must not be read as" list is a CAVEAT, not a note. It is
  // restated to the model verbatim, so an answer that violates it is violating an
  // instruction rather than merely omitting a footnote.
  const et = supp?.explainTarget;
  if (et) {
    for (const m of et.mustNotBeReadAs ?? []) out.push(m);
    if (!et.resolved) {
      out.push(
        `The requested target "${et.id}" could not be resolved. Do not describe any trade, `
        + "experiment or metric as though it had been: say what could not be resolved and stop.",
      );
    }
    if (et.kind === "CASE") {
      out.push(
        "This is ONE callout. It is an anecdote and establishes nothing about the lane. "
        + "Do not generalise from it, and do not present its realized return as typical.",
      );
    }
  }
  const wl = supp?.watchlist;
  if (wl && wl.publishedCount === 0) {
    out.push(
      `The Watchlist currently publishes 0 qualified rows. This is the evidence gate working, not a bug. Blockers: ${
        wl.blockers.length ? wl.blockers.join(" ") : "required evidence is incomplete."
      }`,
    );
  }
  return out;
}

/** Build the packet the model is allowed to reason over. Pure. */
export function buildAdvisoryEvidencePacket(
  report: CanonicalFindingsReport,
  supplemental?: SupplementalEvidence,
): EvidencePacket {
  return {
    reportId: report.reportId,
    generatedAtMs: report.generatedAtMs,
    tradingDay: report.tradingDay,
    overallState: report.overallState,
    activeProductionPipeline: String(report.activeProductionPipeline),
    items: [...report.metrics.map(itemFromMetric), ...supplementalItems(supplemental)],
    dataGaps: report.dataGaps ?? [],
    mandatoryCaveats: mandatoryCaveats(supplemental),
    safety: { aiAuthority: ADVISORY_CHAT_AUTHORITY, productionBehaviorChanged: false },
  };
}

// ------------------------------------------------------------------ validation

export type ValidationFailureKind =
  | "UNSUPPORTED_NUMBER"
  | "UNKNOWN_EVIDENCE_ID"
  | "NO_CITATION"
  | "PIPELINE_WINDOW_MIXED"
  | "MISSING_TREATED_AS_ZERO"
  | "PROFIT_CLAIM_ON_LOSING_POLICY"
  | "PRODUCTION_CHANGE_CLAIM";

export interface ValidationFailure {
  kind: ValidationFailureKind;
  detail: string;
  token?: string;
}

export interface ChatValidationResult {
  ok: boolean;
  failures: ValidationFailure[];
  citedEvidenceIds: string[];
  numbersChecked: string[];
}

/** Years, list markers, and similar are not quantitative claims. */
const IGNORED_NUMBER_CONTEXT = /^(19|20)\d{2}$/;

/**
 * Pull candidate numeric tokens out of prose.
 *
 * Structural digits are not quantitative claims and must not be validated as if
 * they were: list markers ("2." / "3)" at the start of a line), parenthesised
 * enumerators ("(1)"), and years. Treating these as claims made the validator
 * reject almost every real multi-point answer.
 */
export function extractNumericClaims(text: string): string[] {
  const prose = String(text ?? "")
    // Dates and clock times are identifiers, not quantities. Left in, the month and
    // day of "2026-07-29" become spurious figures that also fake cohort conflicts.
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:a\.m\.|p\.m\.|am|pm|ET|UTC)?/gi, " ")
    // Leading list markers: "1. ", "2) ", "- 3. "
    .replace(/(^|\n)[ \t]*[-*]?[ \t]*\d{1,2}[.)][ \t]+/g, "$1")
    // Parenthesised enumerators: "(1)"
    .replace(/\((\d{1,2})\)/g, " ");
  const out: string[] = [];
  // Matches 1, 1.5, 1,234, 1,234.5 — with optional $ / % handled by the caller.
  const re = /-?\d[\d,]*(?:\.\d+)?/g;
  for (const m of prose.match(re) ?? []) {
    const cleaned = m.replace(/^-/, "");
    if (!cleaned) continue;
    if (IGNORED_NUMBER_CONTEXT.test(cleaned.replace(/,/g, ""))) continue;
    out.push(cleaned);
  }
  return out;
}

/**
 * Numbers that are part of a canonical ENTITY NAME the answer quotes verbatim —
 * "Trail 10%", "Break-even +15%", "Time stop 30m". These name a real thing in the
 * packet, so quoting them is not inventing a figure.
 */
function entityNameNumbers(items: EvidenceItem[], answer: string): Set<string> {
  const out = new Set<string>();
  const lower = answer.toLowerCase();
  for (const item of items) {
    const name = item.label.split("—")[0].trim();
    if (name.length < 3 || !lower.includes(name.toLowerCase())) continue;
    for (const m of name.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
      out.add(m);
      out.add(m.replace(/,/g, ""));
    }
  }
  return out;
}

/** Split prose into sentences for per-claim checks. */
function sentences(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Numbers baked into the TEXT of a CITED metric are themselves canonical — citing
 * "Losses already down 20% by five minutes" makes 20 part of that evidence.
 *
 * Restricted to cited items on purpose: scanning every metric's text would let an
 * unrelated label (say "0DTE protection") license an arbitrary number elsewhere.
 */
function textNumbers(items: EvidenceItem[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    for (const field of [item.label, item.meaning, item.timeWindow, item.unit ?? ""]) {
      for (const m of String(field).match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
        out.add(m);
        out.add(m.replace(/,/g, ""));
      }
    }
  }
  return out;
}

function isSupportedNumber(token: string, items: EvidenceItem[], fromText: Set<string>): boolean {
  const bare = token.replace(/,/g, "");
  if (fromText.has(token) || fromText.has(bare)) return true;
  for (const item of items) {
    for (const form of item.numericForms) {
      if (form === token || form === bare || form.replace(/,/g, "") === bare) return true;
    }
    // A sample size may be quoted directly even when the value is a percentage.
    if (item.sampleSize != null && String(item.sampleSize) === bare) return true;
  }
  return false;
}

const PRODUCTION_CHANGE_CLAIMS = [
  /\bI (?:have |just )?(?:changed|updated|fixed|applied|deployed|modified|adjusted)\b/i,
  /\b(?:I|we) (?:have )?(?:enabled|disabled|turned (?:on|off))\b/i,
  /\bhas been (?:changed|applied|deployed|fixed) (?:automatically|for you)\b/i,
  /\bproduction (?:has been|was) (?:changed|updated)\b/i,
];

/**
 * A claim of profitability. Negated forms ("not profitable", "never a winner",
 * "less bad rather than profitable") are accurate descriptions of a losing policy
 * and must NOT be flagged.
 */
const PROFIT_WORDS = /\b(profitable|winning|makes money|net positive|a winner)\b/i;

/** Negation and disclaimer cues that make a following claim a denial, not an assertion. */
const NEGATION_CUE = /\b(?:not|never|no|none|neither|cannot|can't|isn't|aren't|won't|must not|should not|rather than|instead of|far from|nowhere near|short of|less bad|least bad|unprofitable|losing|loss-making|negative|avoid|without)\b/i;

/**
 * True when `text` ASSERTS a claim matched by `claimRe`, rather than denying it.
 *
 * A fixed-distance lookbehind cannot see the negation in "must never be described
 * as a winning policy" — and that phrasing matters, because it is close to the
 * mandatory caveat the model is REQUIRED to restate. Restating the caveat was
 * tripping the very guard the caveat exists to enforce. Instead: locate the claim,
 * then treat it as denied when a negation cue appears anywhere before it in the
 * same sentence.
 */
function assertsClaim(text: string, claimRe: RegExp): boolean {
  const re = new RegExp(claimRe.source, claimRe.flags.includes("g") ? claimRe.flags : `${claimRe.flags}g`);
  for (const match of text.matchAll(re)) {
    const prefix = text.slice(0, match.index ?? 0);
    if (!NEGATION_CUE.test(prefix)) return true;
  }
  return false;
}

/**
 * Validate one assistant answer against the packet.
 *
 * `requireCitation` is true for answers that assert numbers; a purely qualitative
 * reply (for example an explanation of a term) legitimately cites nothing.
 */
export function validateAdvisoryAnswer(input: {
  answer: string;
  citedEvidenceIds: string[];
  packet: EvidencePacket;
  supplemental?: SupplementalEvidence;
}): ChatValidationResult {
  const failures: ValidationFailure[] = [];
  const items = input.packet.items;
  const byId = new Map(items.map((i) => [i.id, i]));

  // 1. Every citation must resolve to a real evidence id.
  for (const id of input.citedEvidenceIds) {
    if (!byId.has(id)) {
      failures.push({ kind: "UNKNOWN_EVIDENCE_ID", detail: `Cited evidence id does not exist: ${id}`, token: id });
    }
  }

  // 2. Every number must exist in the packet.
  const numbers = extractNumericClaims(input.answer);
  const citedItems = input.citedEvidenceIds.map((id) => byId.get(id)).filter(Boolean) as EvidenceItem[];
  const fromText = new Set<string>([
    ...textNumbers(citedItems),
    ...entityNameNumbers(items, input.answer),
  ]);
  for (const token of numbers) {
    if (!isSupportedNumber(token, items, fromText)) {
      failures.push({
        kind: "UNSUPPORTED_NUMBER",
        detail: `The number ${token} does not appear in the canonical evidence packet.`,
        token,
      });
    }
  }
  if (numbers.length > 0 && input.citedEvidenceIds.length === 0) {
    failures.push({ kind: "NO_CITATION", detail: "The answer states numbers but cites no evidence." });
  }

  // 3. No SINGLE claim may silently combine pipelines or windows.
  //
  //    Checked per sentence, not per answer: a multi-topic reply legitimately
  //    discusses entries and delivery in separate sentences, and only a single
  //    sentence carrying numbers from two cohorts is describing a cohort that
  //    never existed.
  //    A number only implicates a cohort when the attribution is UNAMBIGUOUS. A
  //    common value like 0 or 21 matches metrics in several pipelines at once, and
  //    treating that as proof of mixing flagged correct single-cohort prose such as
  //    "0 of 58 candidates published a plan".
  const cited = citedItems;
  if (cited.length > 1) {
    for (const sentence of sentences(input.answer)) {
      const numbersHere = extractNumericClaims(sentence);
      if (numbersHere.length < 2) continue;
      const cohorts = new Set<string>();
      for (const n of numbersHere) {
        const matching = cited.filter((c) =>
          c.numericForms.some((f) => f === n || f.replace(/,/g, "") === n.replace(/,/g, "")));
        const cohortsForNumber = new Set(matching.map((c) => `${c.pipeline}|${c.timeWindow}`));
        if (cohortsForNumber.size === 1) cohorts.add([...cohortsForNumber][0]);
      }
      if (cohorts.size > 1) {
        failures.push({
          kind: "PIPELINE_WINDOW_MIXED",
          detail: `One claim cannot combine cohorts (${[...cohorts].join(" vs ")}): "${sentence.slice(0, 120)}"`,
        });
      }
    }
  }

  // 4. A null metric must not be presented as zero.
  for (const c of cited) {
    // Direction-agnostic: "0 for X" and "X is 0" are both presenting missing as zero.
    const label = escapeRegex(shortLabel(c.label));
    const zeroNearLabel = new RegExp(
      `(?:\\b0\\b[^.]{0,60}${label})|(?:${label}[^.]{0,60}\\b(?:is|was|=|:|at)\\s*0\\b)`,
      "i",
    );
    if (c.value == null && zeroNearLabel.test(input.answer)) {
      failures.push({
        kind: "MISSING_TREATED_AS_ZERO",
        detail: `${c.id} has no value; it must stay "unavailable" rather than 0.`,
        token: c.id,
      });
    }
    // A zero-sample metric cannot support a PERFORMANCE claim. Scoped two ways:
    //  - only performance figures, never a ".sampleSize" metric, whose value of 0
    //    is the correct thing to report (and which the caveats require reporting);
    //  - only the sentence naming it, so an unrelated positive remark elsewhere in
    //    a long answer cannot implicate it.
    const isPerformanceMetric = /\.(avgReturnPct|winRatePct|totalPnlUsd|captureEfficiencyPct)$/.test(c.id);
    if (c.sampleSize === 0 && isPerformanceMetric) {
      const name = c.label.split("—")[0].trim();
      const naming = sentences(input.answer).filter((s) => s.includes(name));
      if (naming.some((s) => assertsClaim(s, PROFIT_WORDS))) {
        failures.push({
          kind: "MISSING_TREATED_AS_ZERO",
          detail: `${c.id} has a sample size of 0 and cannot support a performance claim.`,
          token: c.id,
        });
      }
    }
  }

  // 5. A losing "best" policy must never be called profitable.
  const ep = input.supplemental?.exitPolicy;
  if (ep?.bestSupportedPolicy) {
    const best = ep.policies.find((p) => p.policy === ep.bestSupportedPolicy);
    if (best && isNum(best.averageReturnPct) && best.averageReturnPct < 0) {
      // Scoped to the sentence naming the policy: a fixed character window spilled
      // into later sentences, so an unrelated "what is working" remark tripped it.
      const name = ep.bestSupportedPolicy;
      const naming = sentences(input.answer)
        .filter((s) => s.toLowerCase().includes(name.toLowerCase()));
      if (naming.some((s) => assertsClaim(s, PROFIT_WORDS))) {
        failures.push({
          kind: "PROFIT_CLAIM_ON_LOSING_POLICY",
          detail: `${name} averages ${best.averageReturnPct}% and must not be described as profitable or winning.`,
          token: name,
        });
      }
    }
  }

  // 6. The assistant must never claim it altered production.
  // Sentence-scoped and negation-aware for the same reason as the profit guard: the
  // answer is REQUIRED to say no production change was made, and denying a change
  // must not read as claiming one.
  const answerSentences = sentences(input.answer);
  const claimsChange = PRODUCTION_CHANGE_CLAIMS.some((re) =>
    answerSentences.some((s) => assertsClaim(s, re)));
  if (claimsChange) {
    failures.push({
      kind: "PRODUCTION_CHANGE_CLAIM",
      detail: "The answer claims a production change was made. AI authority is advisory only.",
    });
  }

  return {
    ok: failures.length === 0,
    failures,
    citedEvidenceIds: input.citedEvidenceIds,
    numbersChecked: numbers,
  };
}

function shortLabel(label: string): string {
  return label.split(/[—(]/)[0].trim().slice(0, 40);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The message shown when an AI answer cannot be trusted. */
export const AI_UNAVAILABLE_MESSAGE =
  "AI explanation unavailable. Deterministic findings remain available.";

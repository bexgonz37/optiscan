/**
 * Canonical SetupEpisodeV2 for live options evidence.
 *
 * Zone A is immutable decision-time state only. Zone B labels and Zone C/D
 * actions are separate append-only rows keyed to the episode. This module never
 * opens a paper trade, sends Discord, fetches data, or reads a future outcome.
 */
import { createHash } from "node:crypto";
import { OPTIONS_STRATEGIES } from "../options/strategy-catalog.ts";
import type { OptionsCandidateInput } from "../options/discovery.ts";
import type { OptionsEvalResult } from "../options/loop.ts";
import { tradingDay } from "../../trading-session.ts";
import {
  CANONICAL_QUOTE_AGE,
  LEGACY_QUOTE_AGE_CONSUMERS,
  decisionClockEvidence,
  newSignedMsHistogram,
  newTimestampRelationCounts,
  recordSignedMs,
  signedQuoteAgeAt,
  snapshotSignedMsHistogram,
  type DecisionClockEvidence,
  type DecisionClocks,
  type SignedMsHistogram,
  type TimestampRelation,
} from "./clocks.ts";

export const SETUP_EPISODE_V2_VERSION = 2;
export const SETUP_EPISODE_V2_FEATURE_VERSION = "options-features@2";
export const SETUP_EPISODE_V2_STRATEGY_VERSION = "options-strategy-catalog@1";

export type EpisodePopulation = "ACTIONABLE" | "WATCH" | "REJECTED";
export type EpisodeActionKind =
  | "OBSERVATION"
  | "COUNTERFACTUAL"
  | "PAPER_TRADE"
  | "OWNER_PAPER"
  | "DELIVERED_SUBSCRIBER_TRADE";
export type OutcomeLabelKind = "UNDERLYING_LABEL" | "EXACT_OPTION_EXECUTABLE_LABEL";
export type OutcomeHorizonV2 = "5m" | "15m" | "30m" | "60m" | "session";
export type EvidenceCoverage = "COMPLETE" | "CENSORED" | "INSUFFICIENT";
export type CompetingEventOrder =
  | "FIRST_EVENT"
  | "SECOND_EVENT"
  | "NEITHER"
  | "AMBIGUOUS"
  | "AMBIGUOUS_INTRABAR"
  | "UNKNOWN"
  | "NOT_APPLICABLE";

export interface EvidenceValue<T> {
  value: T | null;
  source: string;
  asOfMs: number;
  quality: "EXACT" | "DERIVED" | "PROXY" | "MISSING";
  missingReason: string | null;
  featureVersion: string;
}

export interface SetupEpisodeV2 {
  episodeKey: string;
  episodeVersion: 2;
  source: "live_scanner" | "live_supervisor" | "replay";
  sourceLane: string;
  symbol: string;
  t0Ms: number;
  tradingDay: string;
  session: OptionsCandidateInput["session"];
  direction: "bullish" | "bearish" | null;
  population: EpisodePopulation;
  disposition: string;
  rejectionReason: string | null;
  selectedStrategy: string | null;
  selectionStrength: number | null;
  selectedOcc: string | null;
  entryConvention: "BUY_AT_ASK_EXIT_AT_FUTURE_BID" | null;
  candidateId: number | null;
  opportunityCaseId: string | null;
  thesisFingerprint: string | null;
  productionSha: string | null;
  configDigest: string;
  strategyVersion: string;
  featureVersion: string;
  /** Zone A only. No future-outcome keys are permitted by validateZoneA. */
  zoneA: {
    underlying: Record<string, EvidenceValue<unknown>>;
    option: Record<string, EvidenceValue<unknown>> | null;
    optiscan: Record<string, EvidenceValue<unknown>>;
    marketContext: Record<string, EvidenceValue<unknown>>;
  };
  maxFeatureAsOfMs: number;
  /**
   * Phase 2A four-clock instrumentation. ADDITIVE and DIAGNOSTIC ONLY.
   *
   * `t0Ms` above keeps its existing meaning (the monitor's observation-start
   * `n0`) and Zone-A validation still runs against it unchanged, so acceptance
   * behaviour is identical to the prior build. These clocks exist so the next
   * live session can answer whether the ZONE_A_FUTURE_TIMESTAMP rejections are
   * quotes that arrived DURING the evaluation window (legitimate, and currently
   * discarded) or genuinely after the decision was fixed (real leakage).
   *
   * It lives outside `zoneA` on purpose: `decisionAtMs` is by construction
   * >= t0Ms, so an EvidenceValue carrying it would be a Zone-A violation. It is
   * decision provenance, not a decision-time market feature.
   */
  decisionClocks: DecisionClockEvidence;
}

const DECISION_ENV_KEYS = [
  "OPTIONS_CHAIN_STRIKE_WINDOW_PCT",
  "OPTIONS_CHAIN_PARTITION_MAX_PAGES",
  "OPTIONS_CHAIN_MAX_STRATEGY_PARTITIONS",
  "OPTIONS_CHAIN_STRUCTURAL_EMPTY_CACHE_TTL_MS",
  "OPT_T2_MIN_PRICE",
  "OPT_T2_MIN_DOLLAR_VOL",
  "OPT_T2_MAX_STALE_MS",
  "OPT_T2_MAX_SPREAD_PCT",
  "OPT_T2_MIN_VOL_OI",
  "OPTIONS_PORTFOLIO_DELIVERY_ENABLED",
  "EARLY_OPTIONS_CALLOUTS_ENABLED",
  "INDEX_STRATEGY_ACTIONABLE_ENABLED",
  "OPTIONS_TIER0_DIA",
  "OPTIONS_TIER1_EXTRA",
  "OPTIONS_QUALITY_DELIVER_BAR",
  "OPTIONS_QUALITY_OPENING_BUMP",
  "OPTIONS_QUALITY_EXCELLENT_BAR",
  "OPTIONS_QUALITY_RESEARCH_FLOOR",
  "OPTIONS_MAX_DELIVER_PER_FLUSH",
  "OPTIONS_CORRELATION_WINDOW_MS",
  "OPTIONS_HISTORICAL_EVIDENCE_ENABLED",
  "OPTIONS_EVIDENCE_MIN_FORWARD",
  "OPTIONS_EVIDENCE_MIN_HISTORICAL",
  "BEARISH_OWNER_ALERTS_ENABLED",
  "ENTRY_QUALITY_GATE",
  "ENTRY_REQUIRE_HH_HL_FOR_CALL",
  "OPTIONS_0DTE_LATEST_ENTRY_ET",
  "OPTIONS_0DTE_FRIDAY_LATEST_ENTRY_ET",
  "OPTIONS_0DTE_EARLY_CLOSE_LATEST_ENTRY_ET",
  "MARKET_EARLY_CLOSE_DAYS",
  "MARKET_SESSION_GUARD",
] as const;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

export function decisionConfigDigest(env: NodeJS.ProcessEnv = process.env): string {
  const config = Object.fromEntries(DECISION_ENV_KEYS.map((k) => [k, env[k] ?? null]));
  const catalog = OPTIONS_STRATEGIES.map((s) => ({
    key: s.key,
    side: s.side,
    earlySignals: s.earlySignals,
    preferredDte: s.preferredDte,
    preferredDelta: s.preferredDelta,
    moneyness: s.moneyness,
    freshnessMaxMs: s.freshnessMaxMs,
    chaseLimitPct: s.chaseLimitPct,
    sessions: s.sessions,
  }));
  const payload = stable({
    config,
    catalog,
    featureVersion: SETUP_EPISODE_V2_FEATURE_VERSION,
    strategyVersion: SETUP_EPISODE_V2_STRATEGY_VERSION,
    entryConvention: "BUY_AT_ASK_EXIT_AT_FUTURE_BID",
  });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function setupEpisodeV2Key(input: {
  source: string; symbol: string; t0Ms: number; candidateId?: number | null;
  selectedOcc?: string | null; configDigest: string;
}): string {
  const material = [
    input.source,
    input.symbol.toUpperCase(),
    input.t0Ms,
    input.candidateId ?? "-",
    input.selectedOcc ?? "-",
    input.configDigest,
  ].join("|");
  return `ep2_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

function ev<T>(
  value: T | null | undefined,
  source: string,
  asOfMs: number,
  quality: EvidenceValue<T>["quality"] = "EXACT",
  missingReason = "NOT_AVAILABLE_AT_T0",
): EvidenceValue<T> {
  const missing = value == null;
  return {
    value: missing ? null : value,
    source,
    asOfMs,
    quality: missing ? "MISSING" : quality,
    missingReason: missing ? missingReason : null,
    featureVersion: SETUP_EPISODE_V2_FEATURE_VERSION,
  };
}

const FORWARD_KEY = /(^|_)(outcome|mfe|mae|forward|terminal_return|realized_return|time_to_|hit_)/i;

export function validateZoneA(zoneA: SetupEpisodeV2["zoneA"], t0Ms: number): string[] {
  const violations: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (FORWARD_KEY.test(path)) violations.push(`future outcome key in Zone A: ${path}`);
    if (!value || typeof value !== "object") return;
    if ("asOfMs" in (value as Record<string, unknown>)) {
      const asOf = Number((value as Record<string, unknown>).asOfMs);
      if (!Number.isFinite(asOf) || asOf > t0Ms) violations.push(`${path}.asOfMs ${asOf} > t0Ms ${t0Ms}`);
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(zoneA, "zoneA");
  return violations;
}

export function buildSetupEpisodeV2(input: {
  candidate: OptionsCandidateInput;
  result: OptionsEvalResult;
  candidateId?: number | null;
  opportunityCaseId?: string | null;
  thesisFingerprint?: string | null;
  featureSnapshot?: unknown;
  env?: NodeJS.ProcessEnv;
  /**
   * Phase 2A four-clock evidence from the live path. Optional so every existing
   * caller and fixture keeps working; when absent the relation is honestly
   * reported as INSUFFICIENT_TIMESTAMP_EVIDENCE rather than inferred.
   *
   * `quoteEventAtMs` is NOT accepted here — it is always read from the selected
   * contract's provider timestamp below, so no caller can substitute a local
   * clock for the exchange one.
   */
  clocks?: Partial<Omit<DecisionClocks, "quoteEventAtMs">>;
}): SetupEpisodeV2 {
  const buildAtMs = Number.isFinite(input?.candidate?.nowMs) ? Number(input.candidate.nowMs) : Date.now();
  // The four clocks are assembled BEFORE the try so a Zone-A rejection is still
  // classified. The rejected population is the whole point of this gate: an
  // episode that throws never persists, so the in-process counters are the only
  // place its timestamp relation can ever be observed.
  const clocks: DecisionClocks = {
    observationStartedAtMs: input?.clocks?.observationStartedAtMs
      ?? (Number.isFinite(input?.candidate?.nowMs) ? Number(input.candidate.nowMs) : null),
    decisionAtMs: input?.clocks?.decisionAtMs ?? null,
    quoteEventAtMs: input?.result?.contract?.providerTimestamp ?? null,
    quoteReceivedAtMs: input?.clocks?.quoteReceivedAtMs ?? null,
  };
  const clockEvidence = decisionClockEvidence(clocks);
  buildAttempted(buildAtMs, clockEvidence);
  try {
  const c = input.candidate;
  const r = input.result;
  const env = input.env ?? process.env;
  const digest = decisionConfigDigest(env);
  const selected = r.selection.selected;
  // LEGACY, DELIBERATELY UNCHANGED IN PHASE 2A. Two things are wrong with it and
  // both stay wrong until the repair pass, so acceptance behaviour cannot move:
  //   1. the reference clock is t0/observation-start, not the decision instant;
  //   2. Math.max(0, ...) clamps a negative age to 0, which makes a quote that
  //      post-dates t0 look maximally fresh to the executability gate below.
  // Written through the canonical signed helper so the clamp is visible rather
  // than implied. The value is identical to the previous expression.
  const signedQuoteAgeAtT0 = signedQuoteAgeAt(c.nowMs, r.contract?.providerTimestamp ?? null);
  const quoteAge = signedQuoteAgeAtT0 == null ? null : Math.max(0, signedQuoteAgeAtT0);
  const executable = r.contract != null
    && (r.contract.bid ?? 0) > 0
    && (r.contract.ask ?? 0) > (r.contract.bid ?? 0)
    && quoteAge != null
    && quoteAge <= 60_000;
  const population: EpisodePopulation = r.state === "READY"
    ? selected?.researchOnly ? "WATCH" : "ACTIONABLE"
    : r.state === "REJECTED" ? "REJECTED" : "WATCH";
  const candidateId = input.candidateId ?? null;
  const selectedOcc = r.contract?.optionSymbol ?? null;
  const episodeKey = setupEpisodeV2Key({
    source: "live_scanner", symbol: c.symbol, t0Ms: c.nowMs, candidateId, selectedOcc, configDigest: digest,
  });
  const underlying = Object.fromEntries(Object.entries(c.underlying).map(([k, value]) => [
    k,
    ev(value, "options_underlying_snapshot", c.nowMs,
      k === "volumeSurgeProxy" ? "PROXY" : ["relVolume", "volumeAccel", "dollarVolumeAccel"].includes(k) ? "DERIVED" : "EXACT"),
  ]));
  const option = r.contract ? {
    occ: ev(r.contract.optionSymbol, "shared_chain_evidence", c.nowMs),
    side: ev(r.contract.side, "shared_chain_evidence", c.nowMs),
    expiration: ev(r.contract.expiration, "shared_chain_evidence", c.nowMs),
    strike: ev(r.contract.strike, "shared_chain_evidence", c.nowMs),
    moneynessPct: ev(
      c.underlying.price && c.underlying.price > 0
        ? ((r.contract.strike / c.underlying.price) - 1) * 100
        : null,
      "shared_chain_evidence+options_underlying_snapshot", c.nowMs, "DERIVED",
    ),
    dte: ev(r.contract.dte, "shared_chain_evidence", c.nowMs, "DERIVED"),
    bid: ev(r.contract.bid, "provider_nbbo", r.contract.providerTimestamp ?? c.nowMs),
    ask: ev(r.contract.ask, "provider_nbbo", r.contract.providerTimestamp ?? c.nowMs),
    spreadPct: ev(r.contract.spreadPct, "provider_nbbo", r.contract.providerTimestamp ?? c.nowMs, "DERIVED"),
    quoteTimestamp: ev(r.contract.providerTimestamp, "provider_nbbo", c.nowMs),
    quoteAgeMs: ev(quoteAge, "provider_nbbo", c.nowMs, "DERIVED"),
    delta: ev(r.contract.delta, "provider_chain_snapshot", r.contract.providerTimestamp ?? c.nowMs),
    gamma: ev(r.contract.gamma, "provider_chain_snapshot", r.contract.providerTimestamp ?? c.nowMs),
    theta: ev(r.contract.theta ?? null, "provider_chain_snapshot", r.contract.providerTimestamp ?? c.nowMs),
    vega: ev(r.contract.vega ?? null, "provider_chain_snapshot", r.contract.providerTimestamp ?? c.nowMs),
    iv: ev(r.contract.iv, "provider_chain_snapshot", r.contract.providerTimestamp ?? c.nowMs),
    openInterest: ev(r.contract.openInterest, "provider_chain_snapshot", r.contract.providerTimestamp ?? c.nowMs),
    optionVolume: ev(r.contract.volume, "provider_chain_snapshot", r.contract.providerTimestamp ?? c.nowMs),
    executableAtT0: ev(executable, "research_executability_classifier", c.nowMs, "DERIVED"),
  } : null;
  const optiscan = {
    state: ev(r.state, "options_evaluator", c.nowMs),
    selectedStrategy: ev(selected?.key ?? null, "strategy_selector", c.nowMs),
    selectionStrength: ev(selected?.score ?? null, "strategy_selector", c.nowMs, "DERIVED"),
    strategyEvaluations: ev(r.selection.considered, "strategy_selector", c.nowMs, "DERIVED"),
    signalsMatched: ev(selected ? r.selection.considered.find((x) => x.key === selected.key)?.matched ?? [] : [], "strategy_selector", c.nowMs, "DERIVED"),
    contractFunnel: ev(r.contractFunnel ?? null, "contract_funnel", c.nowMs, "DERIVED"),
    disposition: ev(population, "episode_population_classifier", c.nowMs, "DERIVED"),
    rejectionReason: ev(r.state === "READY" ? null : r.callout?.reason ?? r.selection.reason, "options_evaluator", c.nowMs),
    sharedFeatureSnapshot: ev(input.featureSnapshot ?? null, "options_monitor", c.nowMs, "DERIVED"),
    portfolioRank: ev(null, "portfolio_decision_not_yet_available", c.nowMs, "MISSING", "RANK_NOT_AVAILABLE_AT_T0"),
    deliveryQuality: ev(null, "portfolio_decision_not_yet_available", c.nowMs, "MISSING", "DELIVERY_QUALITY_NOT_AVAILABLE_AT_T0"),
    discoveryStage: ev(null, "pre_move_discovery_v2", c.nowMs, "MISSING", "VALID_V2_STAGE_NOT_AVAILABLE_ON_CANDIDATE"),
    rewardRemaining: ev(null, "not_computed", c.nowMs, "MISSING", "REWARD_REMAINING_NOT_AVAILABLE_AT_T0"),
    moveConsumed: ev(null, "not_computed", c.nowMs, "MISSING", "MOVE_CONSUMED_NOT_AVAILABLE_AT_T0"),
  };
  const marketContext = {
    spyContext: ev(null, "not_collected", c.nowMs, "MISSING", "SPY_CONTEXT_NOT_AVAILABLE_AT_T0"),
    sectorContext: ev(null, "not_collected", c.nowMs, "MISSING", "SECTOR_CONTEXT_NOT_AVAILABLE_AT_T0"),
    peerStrength: ev(null, "not_collected", c.nowMs, "MISSING", "PEER_CONTEXT_NOT_AVAILABLE_AT_T0"),
    marketRegime: ev(null, "not_collected", c.nowMs, "MISSING", "REGIME_NOT_AVAILABLE_AT_T0"),
  };
  const zoneA = { underlying, option, optiscan, marketContext };
  const violations = validateZoneA(zoneA, c.nowMs);
  if (violations.length) throw new Error(`SetupEpisodeV2 Zone-A leakage: ${violations.join("; ")}`);
  const episode: SetupEpisodeV2 = {
    episodeKey,
    episodeVersion: 2,
    source: "live_scanner",
    sourceLane: selected?.researchOnly ? "RESEARCH" : "OPTIONS_MONITOR",
    symbol: c.symbol.toUpperCase(),
    t0Ms: c.nowMs,
    tradingDay: tradingDay(c.nowMs),
    session: c.session,
    direction: r.selection.direction,
    population,
    disposition: population === "ACTIONABLE" ? "ACTIONABLE_CANDIDATE" : population === "WATCH" ? "RESEARCH_WATCH" : "REJECTED",
    rejectionReason: r.state === "READY" ? null : r.callout?.reason ?? r.selection.reason,
    selectedStrategy: selected?.key ?? null,
    selectionStrength: selected?.score ?? null,
    selectedOcc,
    entryConvention: executable ? "BUY_AT_ASK_EXIT_AT_FUTURE_BID" : null,
    candidateId,
    opportunityCaseId: input.opportunityCaseId ?? null,
    thesisFingerprint: input.thesisFingerprint ?? null,
    productionSha: env.RAILWAY_GIT_COMMIT_SHA ?? env.GIT_COMMIT_SHA ?? null,
    configDigest: digest,
    strategyVersion: SETUP_EPISODE_V2_STRATEGY_VERSION,
    featureVersion: SETUP_EPISODE_V2_FEATURE_VERSION,
    zoneA,
    maxFeatureAsOfMs: c.nowMs,
    decisionClocks: clockEvidence,
  };
  buildSucceeded(buildAtMs);
  return episode;
  } catch (error) {
    buildRejected(error, buildAtMs, clockEvidence);
    throw error;
  }
}

interface EpisodeDb {
  prepare(sql: string): {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes: number; lastInsertRowid?: number | bigint };
  };
}

export type EpisodeBuildRejectionClass =
  | "ZONE_A_FUTURE_TIMESTAMP"
  | "OTHER_VALIDATION_REJECTION"
  | "OTHER_BUILD_ERROR";

export type EpisodeV2EvidenceState =
  | "NEVER_ATTEMPTED"
  | "ATTEMPTED_WITH_SUCCESS"
  | "ATTEMPTED_WITH_REJECTIONS"
  | "PERSISTENCE_FAILURE";

interface EpisodeHealthState {
  buildAttempts: number;
  buildSuccesses: number;
  buildRejectionsTotal: number;
  buildRejectionsByClass: Record<EpisodeBuildRejectionClass, number>;
  persistenceAttempts: number;
  persistenceSuccesses: number;
  persistenceFailures: number;
  /** Inserts that fell back to the pre-clock column list (schema lag, not a failure). */
  clockColumnFallbackInserts: number;
  observationActionFailures: number;
  counterfactualActionFailures: number;
  paperActionFailures: number;
  subscriberActionFailures: number;
  /**
   * First build attempt of THIS process. Every counter here is process-lifetime,
   * so a restart resets them; without an explicit start instant a reader cannot
   * tell a quiet hour from a process that came up sixty seconds ago.
   */
  firstBuildAttemptAtMs: number | null;
  lastBuildAttemptAtMs: number | null;
  lastBuildSuccessAtMs: number | null;
  lastBuildRejectionAtMs: number | null;
  lastBuildRejectionClass: EpisodeBuildRejectionClass | null;
  lastPersistenceSuccessAtMs: number | null;
  lastPersistenceFailureAtMs: number | null;
  lastPersistenceError: string | null;
  lastActionFailureAtMs: number | null;
  lastActionFailureKind: EpisodeActionKind | null;
  /** Phase 2A. Every build ATTEMPT, classified against the four-clock window. */
  timestampRelationByClass: Record<TimestampRelation, number>;
  /**
   * The measurement this gate exists for: of the attempts the CURRENT Zone-A rule
   * rejected as ZONE_A_FUTURE_TIMESTAMP, where did the quote event actually fall?
   * A large BETWEEN_OBSERVATION_AND_DECISION count means the rule is discarding
   * quotes that arrived legitimately during evaluation.
   */
  zoneAFutureTimestampRelationByClass: Record<TimestampRelation, number>;
  /** Signed quoteEventAtMs - observationStartedAtMs over all attempts. */
  quoteEventAfterObservationStartMsHistogram: SignedMsHistogram;
  /** Signed decisionAtMs - quoteEventAtMs over all attempts. */
  quoteAgeAtDecisionMsHistogram: SignedMsHistogram;
  /** The same two, restricted to ZONE_A_FUTURE_TIMESTAMP rejections. */
  zoneAFutureQuoteEventAfterObservationStartMsHistogram: SignedMsHistogram;
  zoneAFutureQuoteAgeAtDecisionMsHistogram: SignedMsHistogram;
}

type EpisodeHealthGlobal = typeof globalThis & {
  __setupEpisodeV2Health?: EpisodeHealthState;
};

function newEpisodeHealthState(): EpisodeHealthState {
  return {
    buildAttempts: 0,
    buildSuccesses: 0,
    buildRejectionsTotal: 0,
    buildRejectionsByClass: {
      ZONE_A_FUTURE_TIMESTAMP: 0,
      OTHER_VALIDATION_REJECTION: 0,
      OTHER_BUILD_ERROR: 0,
    },
    persistenceAttempts: 0,
    persistenceSuccesses: 0,
    persistenceFailures: 0,
    clockColumnFallbackInserts: 0,
    observationActionFailures: 0,
    counterfactualActionFailures: 0,
    paperActionFailures: 0,
    subscriberActionFailures: 0,
    firstBuildAttemptAtMs: null,
    lastBuildAttemptAtMs: null,
    lastBuildSuccessAtMs: null,
    lastBuildRejectionAtMs: null,
    lastBuildRejectionClass: null,
    lastPersistenceSuccessAtMs: null,
    lastPersistenceFailureAtMs: null,
    lastPersistenceError: null,
    lastActionFailureAtMs: null,
    lastActionFailureKind: null,
    timestampRelationByClass: newTimestampRelationCounts(),
    zoneAFutureTimestampRelationByClass: newTimestampRelationCounts(),
    quoteEventAfterObservationStartMsHistogram: newSignedMsHistogram(),
    quoteAgeAtDecisionMsHistogram: newSignedMsHistogram(),
    zoneAFutureQuoteEventAfterObservationStartMsHistogram: newSignedMsHistogram(),
    zoneAFutureQuoteAgeAtDecisionMsHistogram: newSignedMsHistogram(),
  };
}

function episodeHealthState(): EpisodeHealthState {
  const g = globalThis as EpisodeHealthGlobal;
  return (g.__setupEpisodeV2Health ??= newEpisodeHealthState());
}

/** Test-only reset for deterministic counter assertions. It never runs in production code. */
export function resetSetupEpisodeV2HealthForTests(): void {
  (globalThis as EpisodeHealthGlobal).__setupEpisodeV2Health = newEpisodeHealthState();
}

export function classifyEpisodeBuildRejection(reason: unknown): EpisodeBuildRejectionClass {
  const message = String((reason as Error)?.message ?? reason);
  if (/SetupEpisodeV2 Zone-A leakage:.*\.asOfMs\s+\d+\s*>\s*t0Ms\s+\d+/s.test(message)) {
    return "ZONE_A_FUTURE_TIMESTAMP";
  }
  if (/SetupEpisodeV2 Zone-A leakage:/i.test(message)) return "OTHER_VALIDATION_REJECTION";
  return "OTHER_BUILD_ERROR";
}

function buildAttempted(nowMs: number, clocks?: DecisionClockEvidence): void {
  const s = episodeHealthState();
  s.buildAttempts += 1;
  s.firstBuildAttemptAtMs ??= nowMs;
  s.lastBuildAttemptAtMs = nowMs;
  if (!clocks) return;
  s.timestampRelationByClass[clocks.timestampRelation] += 1;
  recordSignedMs(s.quoteEventAfterObservationStartMsHistogram, clocks.relations.quoteEventAfterObservationStartMs);
  recordSignedMs(s.quoteAgeAtDecisionMsHistogram, clocks.relations.quoteAgeAtDecisionMs);
}

function buildSucceeded(nowMs: number): void {
  const s = episodeHealthState();
  s.buildSuccesses += 1;
  s.lastBuildSuccessAtMs = nowMs;
}

function buildRejected(reason: unknown, nowMs: number, clocks?: DecisionClockEvidence): void {
  const rejectionClass = classifyEpisodeBuildRejection(reason);
  const s = episodeHealthState();
  s.buildRejectionsTotal += 1;
  s.buildRejectionsByClass[rejectionClass] += 1;
  s.lastBuildRejectionAtMs = nowMs;
  s.lastBuildRejectionClass = rejectionClass;
  // The comparison that decides the next phase: the population the CURRENT rule
  // throws away, split by where the quote event genuinely fell. Recorded only
  // for the future-timestamp class so the other rejection classes cannot dilute it.
  if (!clocks || rejectionClass !== "ZONE_A_FUTURE_TIMESTAMP") return;
  s.zoneAFutureTimestampRelationByClass[clocks.timestampRelation] += 1;
  recordSignedMs(
    s.zoneAFutureQuoteEventAfterObservationStartMsHistogram,
    clocks.relations.quoteEventAfterObservationStartMs,
  );
  recordSignedMs(s.zoneAFutureQuoteAgeAtDecisionMsHistogram, clocks.relations.quoteAgeAtDecisionMs);
}

function boundedErrorMessage(reason: unknown): string {
  return String((reason as Error)?.message ?? reason).slice(0, 240);
}

/** How many inserts had to drop the clock columns because the DB lacked them. */
function episodeClockColumnFallback(): void {
  episodeHealthState().clockColumnFallbackInserts += 1;
}

function episodePersistenceAttempted(): void {
  episodeHealthState().persistenceAttempts += 1;
}

function episodePersistenceOk(nowMs: number): void {
  const s = episodeHealthState();
  s.persistenceSuccesses += 1;
  s.lastPersistenceSuccessAtMs = nowMs;
}

function episodePersistenceFailed(reason: unknown, nowMs: number): string {
  const message = boundedErrorMessage(reason);
  const s = episodeHealthState();
  s.persistenceFailures += 1;
  s.lastPersistenceFailureAtMs = nowMs;
  s.lastPersistenceError = message;
  return message;
}

function actionFailed(kind: EpisodeActionKind, reason: unknown, nowMs: number): string {
  const s = episodeHealthState();
  if (kind === "OBSERVATION") s.observationActionFailures += 1;
  else if (kind === "COUNTERFACTUAL") s.counterfactualActionFailures += 1;
  else if (kind === "PAPER_TRADE" || kind === "OWNER_PAPER") s.paperActionFailures += 1;
  else if (kind === "DELIVERED_SUBSCRIBER_TRADE") s.subscriberActionFailures += 1;
  s.lastActionFailureAtMs = nowMs;
  s.lastActionFailureKind = kind;
  return boundedErrorMessage(reason);
}

interface TimestampBucketSummary {
  key: string;
  totalRows: number;
  quoteNewerThanObserved: number;
  quoteEqualToObserved: number;
  quoteOlderThanObserved: number;
  newerThanObservationPct: number | null;
}

export interface SetupEpisodeV2TimestampDiagnostic {
  status: "OK" | "ERROR";
  scope: {
    candidateState: "CONTRACT_SELECTED";
    quoteTimestampRequired: true;
    groupLimit: number;
  };
  totalRows: number | null;
  quoteNewerThanObserved: number | null;
  quoteEqualToObserved: number | null;
  quoteOlderThanObserved: number | null;
  newerThanObservationPct: number | null;
  reconciles: boolean | null;
  breakdowns: {
    bySessionDate: TimestampBucketSummary[];
    bySide: TimestampBucketSummary[];
    byStrategy: TimestampBucketSummary[];
    bySymbol: TimestampBucketSummary[];
  };
  readOnly: true;
  providerCalls: 0;
  bounded: true;
  error?: string;
}

const TIMESTAMP_DIAGNOSTIC_DEFAULT_GROUP_LIMIT = 20;
const TIMESTAMP_DIAGNOSTIC_MAX_GROUP_LIMIT = 50;
const TIMESTAMP_SCOPE_SQL = "candidate_state='CONTRACT_SELECTED' AND quote_timestamp_ms IS NOT NULL";

function timestampBucket(row: Record<string, unknown>, key = "ALL"): TimestampBucketSummary {
  const totalRows = Number(row.totalRows ?? 0);
  const newer = Number(row.quoteNewerThanObserved ?? 0);
  const equal = Number(row.quoteEqualToObserved ?? 0);
  const older = Number(row.quoteOlderThanObserved ?? 0);
  return {
    key: String(row.key ?? key),
    totalRows,
    quoteNewerThanObserved: newer,
    quoteEqualToObserved: equal,
    quoteOlderThanObserved: older,
    newerThanObservationPct: totalRows > 0 ? +((newer / totalRows) * 100).toFixed(2) : null,
  };
}

/**
 * Historical magnitude of the Zone-A timestamp condition. SQL aggregates only:
 * no provider import, no HTTP, no writes, and every returned breakdown is capped.
 */
export function setupEpisodeV2TimestampDiagnosticOnDb(
  db: EpisodeDb,
  opts: { groupLimit?: number } = {},
): SetupEpisodeV2TimestampDiagnostic {
  const groupLimit = Math.max(1, Math.min(
    TIMESTAMP_DIAGNOSTIC_MAX_GROUP_LIMIT,
    Math.trunc(opts.groupLimit ?? TIMESTAMP_DIAGNOSTIC_DEFAULT_GROUP_LIMIT),
  ));
  const emptyBreakdowns = { bySessionDate: [], bySide: [], byStrategy: [], bySymbol: [] };
  const aggregateColumns = `COUNT(*) AS totalRows,
    COALESCE(SUM(CASE WHEN quote_timestamp_ms > observed_at_ms THEN 1 ELSE 0 END),0) AS quoteNewerThanObserved,
    COALESCE(SUM(CASE WHEN quote_timestamp_ms = observed_at_ms THEN 1 ELSE 0 END),0) AS quoteEqualToObserved,
    COALESCE(SUM(CASE WHEN quote_timestamp_ms < observed_at_ms THEN 1 ELSE 0 END),0) AS quoteOlderThanObserved`;
  const grouped = (expression: string, orderBy: string): TimestampBucketSummary[] =>
    (db.prepare(
      `SELECT ${expression} AS key, ${aggregateColumns}
         FROM options_research_observations
        WHERE ${TIMESTAMP_SCOPE_SQL}
        GROUP BY ${expression}
        ORDER BY ${orderBy}
        LIMIT ?`,
    ).all(groupLimit) as Record<string, unknown>[]).map((row) => timestampBucket(row));
  try {
    const total = timestampBucket(db.prepare(
      `SELECT ${aggregateColumns} FROM options_research_observations WHERE ${TIMESTAMP_SCOPE_SQL}`,
    ).get() as Record<string, unknown> | undefined ?? {});
    return {
      status: "OK",
      scope: { candidateState: "CONTRACT_SELECTED", quoteTimestampRequired: true, groupLimit },
      totalRows: total.totalRows,
      quoteNewerThanObserved: total.quoteNewerThanObserved,
      quoteEqualToObserved: total.quoteEqualToObserved,
      quoteOlderThanObserved: total.quoteOlderThanObserved,
      newerThanObservationPct: total.newerThanObservationPct,
      reconciles: total.totalRows === total.quoteNewerThanObserved + total.quoteEqualToObserved + total.quoteOlderThanObserved,
      breakdowns: {
        bySessionDate: grouped("session_date", "key DESC"),
        bySide: grouped("UPPER(COALESCE(option_type,'UNKNOWN'))", "totalRows DESC, key ASC"),
        byStrategy: grouped("COALESCE(strategy_family,'UNKNOWN')", "totalRows DESC, key ASC"),
        bySymbol: grouped("UPPER(symbol)", "totalRows DESC, key ASC"),
      },
      readOnly: true,
      providerCalls: 0,
      bounded: true,
    };
  } catch (error) {
    return {
      status: "ERROR",
      scope: { candidateState: "CONTRACT_SELECTED", quoteTimestampRequired: true, groupLimit },
      totalRows: null,
      quoteNewerThanObserved: null,
      quoteEqualToObserved: null,
      quoteOlderThanObserved: null,
      newerThanObservationPct: null,
      reconciles: null,
      breakdowns: emptyBreakdowns,
      readOnly: true,
      providerCalls: 0,
      bounded: true,
      error: boundedErrorMessage(error),
    };
  }
}

export function setupEpisodeV2HealthOnDb(db: EpisodeDb): Record<string, unknown> {
  const state = episodeHealthState();
  // Deep-copy every mutable sub-object. A health response that aliased the live
  // counters would keep changing under a caller that is still serializing it.
  const runtime = {
    ...state,
    buildRejectionsByClass: { ...state.buildRejectionsByClass },
    timestampRelationByClass: { ...state.timestampRelationByClass },
    zoneAFutureTimestampRelationByClass: { ...state.zoneAFutureTimestampRelationByClass },
    quoteEventAfterObservationStartMsHistogram:
      snapshotSignedMsHistogram(state.quoteEventAfterObservationStartMsHistogram),
    quoteAgeAtDecisionMsHistogram: snapshotSignedMsHistogram(state.quoteAgeAtDecisionMsHistogram),
    zoneAFutureQuoteEventAfterObservationStartMsHistogram:
      snapshotSignedMsHistogram(state.zoneAFutureQuoteEventAfterObservationStartMsHistogram),
    zoneAFutureQuoteAgeAtDecisionMsHistogram:
      snapshotSignedMsHistogram(state.zoneAFutureQuoteAgeAtDecisionMsHistogram),
  };
  const episodeCount = Number((db.prepare("SELECT COUNT(*) n FROM setup_episodes WHERE episode_version=2").get() as any)?.n ?? 0);
  const actionCount = Number((db.prepare("SELECT COUNT(*) n FROM episode_actions").get() as any)?.n ?? 0);
  const labelCount = Number((db.prepare("SELECT COUNT(*) n FROM episode_outcome_labels_v2").get() as any)?.n ?? 0);
  const timestampDiagnostic = setupEpisodeV2TimestampDiagnosticOnDb(db);
  const actionFailures = runtime.observationActionFailures + runtime.counterfactualActionFailures
    + runtime.paperActionFailures + runtime.subscriberActionFailures;
  const evidenceState: EpisodeV2EvidenceState = runtime.buildAttempts === 0
    ? "NEVER_ATTEMPTED"
    : runtime.persistenceFailures > 0 && runtime.persistenceSuccesses === 0
      ? "PERSISTENCE_FAILURE"
      : runtime.buildSuccesses > 0
        ? "ATTEMPTED_WITH_SUCCESS"
        : "ATTEMPTED_WITH_REJECTIONS";
  const status = timestampDiagnostic.status === "ERROR"
    || evidenceState === "PERSISTENCE_FAILURE"
    || evidenceState === "ATTEMPTED_WITH_REJECTIONS"
    ? "ERROR"
    : evidenceState === "NEVER_ATTEMPTED"
      ? "NO_RUNTIME_EVIDENCE"
      : runtime.buildRejectionsTotal > 0 || runtime.persistenceFailures > 0 || actionFailures > 0
        ? "DEGRADED"
        : "OK";
  return {
    status,
    evidenceState,
    episodeCount,
    actionCount,
    labelCount,
    labelWriterAuthority: "PHASE_2_SUBSTRATE_ONLY",
    runtime,
    timestampDiagnostic,
    timestampSemantics: setupEpisodeV2TimestampSemanticsHealth(runtime),
  };
}

/**
 * Phase 2A four-clock evidence, shaped for a reader who has to decide whether
 * the Zone-A rule is discarding legitimate quotes.
 *
 * Everything here is process-lifetime and bounded: four relation counters, a
 * four-way split of the rejected population, and four fixed-width histograms.
 * No event rows, no unbounded arrays, no provider calls, no writes.
 */
export function setupEpisodeV2TimestampSemanticsHealth(runtime: {
  buildAttempts: number;
  firstBuildAttemptAtMs: number | null;
  buildRejectionsByClass: Record<EpisodeBuildRejectionClass, number>;
  timestampRelationByClass: Record<TimestampRelation, number>;
  zoneAFutureTimestampRelationByClass: Record<TimestampRelation, number>;
  quoteEventAfterObservationStartMsHistogram: SignedMsHistogram;
  quoteAgeAtDecisionMsHistogram: SignedMsHistogram;
  zoneAFutureQuoteEventAfterObservationStartMsHistogram: SignedMsHistogram;
  zoneAFutureQuoteAgeAtDecisionMsHistogram: SignedMsHistogram;
}): Record<string, unknown> {
  const rejected = runtime.zoneAFutureTimestampRelationByClass;
  const classified = Object.values(runtime.timestampRelationByClass).reduce((a, b) => a + b, 0);
  const rejectedClassified = Object.values(rejected).reduce((a, b) => a + b, 0);
  const zoneAFutureRejections = runtime.buildRejectionsByClass.ZONE_A_FUTURE_TIMESTAMP;
  return {
    model: "FOUR_CLOCK_V1",
    authority: "DIAGNOSTIC_ONLY",
    validatorChanged: false,
    scope: "PROCESS_LIFETIME",
    bounded: true,
    providerCalls: 0,
    firstBuildAttemptAtMs: runtime.firstBuildAttemptAtMs,
    buildAttempts: runtime.buildAttempts,
    // Every attempt is classified exactly once, so this must equal buildAttempts.
    // If it ever does not, a build path is bypassing the instrumentation.
    attemptsClassified: classified,
    reconcilesWithBuildAttempts: classified === runtime.buildAttempts,
    timestampRelation: { ...runtime.timestampRelationByClass },
    zoneAFutureTimestampRejections: {
      total: zoneAFutureRejections,
      classified: rejectedClassified,
      // Non-strict: a rejection whose clocks were never supplied is still counted
      // in `total` but lands in INSUFFICIENT_TIMESTAMP_EVIDENCE, so the two agree.
      reconciles: rejectedClassified === zoneAFutureRejections,
      beforeOrAtObservationStartCount: rejected.BEFORE_OR_AT_OBSERVATION_START,
      betweenObservationAndDecisionCount: rejected.BETWEEN_OBSERVATION_AND_DECISION,
      afterDecisionCount: rejected.AFTER_DECISION,
      insufficientCount: rejected.INSUFFICIENT_TIMESTAMP_EVIDENCE,
    },
    // Surfaced live, not just written in a document: these are the gates that
    // still measure quote age against the wrong clock and destroy the sign.
    // None may change before the validator repair is proven.
    legacyQuoteAgeSemantics: {
      unified: CANONICAL_QUOTE_AGE.unifiedInPhase2A,
      canonical: CANONICAL_QUOTE_AGE,
      stillDivergent: LEGACY_QUOTE_AGE_CONSUMERS,
    },
    histograms: {
      note: "Signed milliseconds. Negative values are preserved evidence, never clamped.",
      allAttempts: {
        quoteEventAfterObservationStartMs: runtime.quoteEventAfterObservationStartMsHistogram,
        quoteAgeAtDecisionMs: runtime.quoteAgeAtDecisionMsHistogram,
      },
      zoneAFutureTimestampRejections: {
        quoteEventAfterObservationStartMs:
          runtime.zoneAFutureQuoteEventAfterObservationStartMsHistogram,
        quoteAgeAtDecisionMs: runtime.zoneAFutureQuoteAgeAtDecisionMsHistogram,
      },
    },
  };
}

export function persistSetupEpisodeV2OnDb(db: EpisodeDb, episode: SetupEpisodeV2, nowMs = Date.now()) {
  episodePersistenceAttempted();
  const violations = validateZoneA(episode.zoneA, episode.t0Ms);
  if (violations.length) {
    episodePersistenceFailed(violations.join("; "), nowMs);
    return { ok: false, inserted: false, episodeKey: episode.episodeKey, violations };
  }
  try {
    const existing = db.prepare("SELECT zone_a_json, config_digest FROM setup_episodes WHERE episode_key=?").get(episode.episodeKey) as any;
    const zoneJson = JSON.stringify(episode.zoneA);
    if (existing) {
      const same = existing.zone_a_json === zoneJson && existing.config_digest === episode.configDigest;
      if (same) episodePersistenceOk(nowMs);
      else episodePersistenceFailed("immutable episode identity conflict", nowMs);
      return { ok: same, inserted: false, episodeKey: episode.episodeKey, violations: same ? [] : ["immutable episode identity conflict"] };
    }
    // The four clocks are written TWICE on purpose, both at INSERT only:
    //   - provenance_json carries the full evidence block (relations, clock
    //     domains, classification). It is durable on any schema, including a
    //     production DB that has not yet received the additive columns.
    //   - four dedicated columns make the relation SQL-aggregable, which the
    //     existing timestamp diagnostic requires: it is deliberately aggregate-
    //     only, and forcing it to parse a JSON blob per row would turn a bounded
    //     read into a full scan.
    // The V2 immutability triggers already forbid UPDATE and DELETE, so writing
    // at INSERT is what preserves immutability here.
    const clocks = episode.decisionClocks;
    const provenanceJson = JSON.stringify({ sourceLane: episode.sourceLane, decisionClocks: clocks });
    const legacyColumns = `episode_key,source,symbol,t0_ms,trading_day,session,tod_bucket,asset_class,direction,
         missing_json,gate_results_json,feature_schema_version,max_feature_as_of_ms,provenance_json,created_at_ms,
         episode_version,population,zone_a_json,config_digest,production_sha,strategy_version,feature_version,
         selected_strategy,selection_strength,disposition,rejection_reason,candidate_id,opportunity_case_id,
         thesis_fingerprint,selected_occ,source_lane,entry_convention`;
    const legacyValues = [
      episode.episodeKey, episode.source, episode.symbol, episode.t0Ms, episode.tradingDay, episode.session, null, "option", episode.direction,
      JSON.stringify([]), JSON.stringify({}), 2, episode.maxFeatureAsOfMs,
      provenanceJson, nowMs,
      2, episode.population, zoneJson, episode.configDigest, episode.productionSha,
      episode.strategyVersion, episode.featureVersion, episode.selectedStrategy, episode.selectionStrength,
      episode.disposition, episode.rejectionReason, episode.candidateId, episode.opportunityCaseId,
      episode.thesisFingerprint, episode.selectedOcc, episode.sourceLane, episode.entryConvention,
    ];
    const clockColumns = `observation_started_at_ms,decision_at_ms,quote_event_at_ms,quote_received_at_ms,timestamp_relation`;
    const clockValues = [
      clocks.observationStartedAtMs, clocks.decisionAtMs, clocks.quoteEventAtMs,
      clocks.quoteReceivedAtMs, clocks.timestampRelation,
    ];
    const insert = (columns: string, values: unknown[]) => db.prepare(
      `INSERT INTO setup_episodes (${columns}) VALUES (${values.map(() => "?").join(",")})`,
    ).run(...values);
    let info: { changes: number };
    try {
      info = insert(`${legacyColumns},${clockColumns}`, [...legacyValues, ...clockValues]);
    } catch (columnError) {
      // A production DB mid-upgrade may not have the clock columns yet. Falling
      // back keeps episode capture alive (provenance_json still carries every
      // clock) instead of turning a schema lag into a persistence outage. Any
      // other failure re-throws below on the second attempt and is reported.
      if (!/no column named|has no column/i.test(String((columnError as Error)?.message ?? columnError))) throw columnError;
      episodeClockColumnFallback();
      info = insert(legacyColumns, legacyValues);
    }
    episodePersistenceOk(nowMs);
    return { ok: true, inserted: info.changes > 0, episodeKey: episode.episodeKey, violations: [] };
  } catch (error) {
    return { ok: false, inserted: false, episodeKey: episode.episodeKey, violations: [episodePersistenceFailed(error, nowMs)] };
  }
}

export function appendEpisodeActionOnDb(db: EpisodeDb, input: {
  episodeKey: string;
  kind: EpisodeActionKind;
  actionRef: string;
  occurredAtMs: number;
  exactOcc?: string | null;
  entryConvention?: string | null;
  defensibleEntry?: boolean;
  metadata?: unknown;
}, nowMs = Date.now()) {
  if (input.kind === "COUNTERFACTUAL" && (!input.defensibleEntry || !input.exactOcc || !input.entryConvention)) {
    actionFailed(input.kind, "counterfactual requires exact OCC, defensible entry, and explicit convention", nowMs);
    return { ok: false, inserted: false, reason: "counterfactual requires exact OCC, defensible entry, and explicit convention" };
  }
  try {
    const r = db.prepare(
      `INSERT OR IGNORE INTO episode_actions
        (episode_key,action_kind,action_ref,occurred_at_ms,exact_occ,entry_convention,defensible_entry,metadata_json,created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(input.episodeKey, input.kind, input.actionRef, input.occurredAtMs, input.exactOcc ?? null,
      input.entryConvention ?? null, input.defensibleEntry ? 1 : 0,
      input.metadata == null ? null : JSON.stringify(input.metadata), nowMs);
    return { ok: true, inserted: r.changes > 0, reason: null };
  } catch (error) {
    return { ok: false, inserted: false, reason: actionFailed(input.kind, error, nowMs) };
  }
}

export interface OutcomeLabelV2 {
  labelId: string;
  episodeKey: string;
  labelKind: OutcomeLabelKind;
  horizon: OutcomeHorizonV2;
  exactOcc: string | null;
  entryConvention: string | null;
  terminalReturnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  hit10: boolean | null; hit25: boolean | null; hit50: boolean | null; hit100: boolean | null; hit200: boolean | null;
  hitNeg10: boolean | null; hitNeg20: boolean | null; hitStop: boolean | null;
  timeTo10Ms: number | null; timeTo25Ms: number | null; timeTo50Ms: number | null; timeTo100Ms: number | null; timeTo200Ms: number | null;
  timeToNeg10Ms: number | null; timeToNeg20Ms: number | null; timeToStopMs: number | null;
  timeToMfeMs: number | null; timeToMaeMs: number | null;
  plus10BeforeNeg10: boolean | null; plus25BeforeNeg20: boolean | null;
  plus50BeforeStop: boolean | null; stopBeforePlus25: boolean | null; plus100BeforeStop: boolean | null;
  plus10VsNeg10Order: CompetingEventOrder;
  plus25VsNeg20Order: CompetingEventOrder;
  plus50VsStopOrder: CompetingEventOrder;
  stopVsPlus25Order: CompetingEventOrder;
  plus100VsStopOrder: CompetingEventOrder;
  coverage: EvidenceCoverage;
  censored: boolean;
  missingReason: string | null;
  quoteCount: number | null;
  firstEvidenceAtMs: number | null;
  lastEvidenceAtMs: number | null;
  requestedEndAtMs: number;
  evidenceCoverageMs: number | null;
  largestGapMs: number | null;
  entryPrice: number | null;
  entryQuoteAtMs: number | null;
  entryQuoteAgeMs: number | null;
  entrySpreadPct: number | null;
  exitPrice: number | null;
  evidenceSource: string;
  evidenceVersion: string;
  productionSha: string | null;
  evidenceQuality: string;
  intrabarStatus: "ORDERED" | "AMBIGUOUS_INTRABAR" | "NOT_APPLICABLE";
  labelVersion: string;
  labelAsOfMs: number;
  configDigest: string;
}

export function appendOutcomeLabelV2OnDb(db: EpisodeDb, t0Ms: number, label: OutcomeLabelV2, nowMs = Date.now()) {
  const requestedEndAtMs = label.requestedEndAtMs ?? label.labelAsOfMs;
  const labelVersion = label.labelVersion ?? "FORWARD_LABEL_V1";
  if (!(label.labelAsOfMs > t0Ms)) {
    return { ok: false, inserted: false, reason: "label must be strictly after t0" };
  }
  if (label.labelKind === "EXACT_OPTION_EXECUTABLE_LABEL" && (!label.exactOcc || !label.entryConvention)) {
    return { ok: false, inserted: false, reason: "exact-option label requires OCC and entry convention" };
  }
  if (label.labelKind === "UNDERLYING_LABEL" && (label.exactOcc != null || label.entryConvention != null)) {
    return { ok: false, inserted: false, reason: "underlying label cannot carry option identity" };
  }
  if (requestedEndAtMs <= t0Ms || label.labelAsOfMs < requestedEndAtMs) {
    return { ok: false, inserted: false, reason: "label horizon end must be after t0 and no later than label as-of" };
  }
  if (label.coverage === "INSUFFICIENT" && [label.terminalReturnPct, label.mfePct, label.maePct].some((x) => x != null)) {
    return { ok: false, inserted: false, reason: "insufficient evidence cannot carry return/MFE/MAE" };
  }
  try {
    const episode = db.prepare(
      "SELECT selected_occ, entry_convention, config_digest FROM setup_episodes WHERE episode_key=? AND episode_version=2",
    ).get(label.episodeKey) as any;
    if (!episode) return { ok: false, inserted: false, reason: boundedErrorMessage("SetupEpisodeV2 not found") };
    if (String(episode.config_digest ?? "") !== label.configDigest) {
      return { ok: false, inserted: false, reason: boundedErrorMessage("label config digest does not match frozen episode") };
    }
    if (label.labelKind === "EXACT_OPTION_EXECUTABLE_LABEL") {
      if (String(episode.selected_occ ?? "").toUpperCase() !== String(label.exactOcc ?? "").toUpperCase()) {
        return { ok: false, inserted: false, reason: boundedErrorMessage("exact OCC does not match frozen episode") };
      }
      if (String(episode.entry_convention ?? "") !== String(label.entryConvention ?? "")) {
        return { ok: false, inserted: false, reason: boundedErrorMessage("entry convention does not match frozen episode") };
      }
    }
    const bool = (v: boolean | null) => v == null ? null : v ? 1 : 0;
    const columns = [
      "label_id","episode_key","label_kind","horizon","exact_occ","entry_convention",
      "terminal_return_pct","mfe_pct","mae_pct",
      "hit_10","hit_25","hit_50","hit_100","hit_200","hit_neg_10","hit_neg_20","hit_stop",
      "time_to_10_ms","time_to_25_ms","time_to_50_ms","time_to_100_ms","time_to_200_ms",
      "time_to_neg_10_ms","time_to_neg_20_ms","time_to_stop_ms","time_to_mfe_ms","time_to_mae_ms",
      "plus_10_before_neg_10","plus_25_before_neg_20","plus_50_before_stop","stop_before_plus_25","plus_100_before_stop",
      "plus_10_vs_neg_10_order","plus_25_vs_neg_20_order","plus_50_vs_stop_order","stop_vs_plus_25_order","plus_100_vs_stop_order",
      "coverage","censored","missing_reason","quote_count","first_evidence_at_ms","last_evidence_at_ms",
      "requested_end_at_ms","evidence_coverage_ms","largest_gap_ms",
      "entry_price","entry_quote_at_ms","entry_quote_age_ms","entry_spread_pct","exit_price",
      "evidence_source","evidence_version","production_sha","evidence_quality","intrabar_status","label_version",
      "label_as_of_ms","config_digest","computed_at_ms",
    ];
    const values = [
      label.labelId,label.episodeKey,label.labelKind,label.horizon,label.exactOcc,label.entryConvention,
      label.terminalReturnPct,label.mfePct,label.maePct,
      bool(label.hit10),bool(label.hit25),bool(label.hit50),bool(label.hit100),bool(label.hit200 ?? null),
      bool(label.hitNeg10),bool(label.hitNeg20),bool(label.hitStop),
      label.timeTo10Ms,label.timeTo25Ms,label.timeTo50Ms,label.timeTo100Ms,label.timeTo200Ms ?? null,
      label.timeToNeg10Ms,label.timeToNeg20Ms,label.timeToStopMs,label.timeToMfeMs ?? null,label.timeToMaeMs ?? null,
      bool(label.plus10BeforeNeg10),bool(label.plus25BeforeNeg20),bool(label.plus50BeforeStop),
      bool(label.stopBeforePlus25),bool(label.plus100BeforeStop ?? null),
      label.plus10VsNeg10Order ?? "UNKNOWN",label.plus25VsNeg20Order ?? "UNKNOWN",label.plus50VsStopOrder ?? "NOT_APPLICABLE",
      label.stopVsPlus25Order ?? "NOT_APPLICABLE",label.plus100VsStopOrder ?? "NOT_APPLICABLE",
      label.coverage,label.censored ? 1 : 0,label.missingReason,label.quoteCount,
      label.firstEvidenceAtMs,label.lastEvidenceAtMs,requestedEndAtMs,label.evidenceCoverageMs ?? null,label.largestGapMs ?? null,
      label.entryPrice ?? null,label.entryQuoteAtMs ?? null,label.entryQuoteAgeMs ?? null,label.entrySpreadPct ?? null,label.exitPrice ?? null,
      label.evidenceSource ?? "UNKNOWN",label.evidenceVersion ?? "UNKNOWN",label.productionSha ?? null,label.evidenceQuality,label.intrabarStatus,labelVersion,
      label.labelAsOfMs,label.configDigest,nowMs,
    ];
    const r = db.prepare(
      `INSERT OR IGNORE INTO episode_outcome_labels_v2 (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    ).run(...values);
    return { ok: true, inserted: r.changes > 0, reason: null };
  } catch (error) {
    return { ok: false, inserted: false, reason: boundedErrorMessage(error) };
  }
}

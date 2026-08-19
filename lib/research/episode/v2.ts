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

export const SETUP_EPISODE_V2_VERSION = 2;
export const SETUP_EPISODE_V2_FEATURE_VERSION = "options-features@2";
export const SETUP_EPISODE_V2_STRATEGY_VERSION = "options-strategy-catalog@1";

export type EpisodePopulation = "ACTIONABLE" | "WATCH" | "REJECTED";
export type EpisodeActionKind =
  | "OBSERVATION"
  | "COUNTERFACTUAL"
  | "PAPER_TRADE"
  | "DELIVERED_SUBSCRIBER_TRADE";
export type OutcomeLabelKind = "UNDERLYING_LABEL" | "EXACT_OPTION_EXECUTABLE_LABEL";
export type OutcomeHorizonV2 = "5m" | "15m" | "30m" | "60m" | "session";
export type EvidenceCoverage = "COMPLETE" | "CENSORED" | "INSUFFICIENT";

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
}): SetupEpisodeV2 {
  const c = input.candidate;
  const r = input.result;
  const env = input.env ?? process.env;
  const digest = decisionConfigDigest(env);
  const selected = r.selection.selected;
  const quoteAge = r.contract?.providerTimestamp == null ? null : Math.max(0, c.nowMs - r.contract.providerTimestamp);
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
  return {
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
  };
}

interface EpisodeDb {
  prepare(sql: string): {
    get: (...a: unknown[]) => unknown;
    run: (...a: unknown[]) => { changes: number; lastInsertRowid?: number | bigint };
  };
}

type EpisodeHealthGlobal = typeof globalThis & {
  __setupEpisodeV2Health?: {
    writes: number; failures: number; lastSuccessAtMs: number | null;
    lastErrorAtMs: number | null; lastError: string | null;
  };
};

function episodeHealthState() {
  const g = globalThis as EpisodeHealthGlobal;
  return (g.__setupEpisodeV2Health ??= {
    writes: 0, failures: 0, lastSuccessAtMs: null, lastErrorAtMs: null, lastError: null,
  });
}

function persistenceOk(nowMs: number) {
  const s = episodeHealthState();
  s.writes += 1;
  s.lastSuccessAtMs = nowMs;
}

function persistenceFailed(reason: unknown, nowMs: number): string {
  const message = String((reason as Error)?.message ?? reason).slice(0, 240);
  const s = episodeHealthState();
  s.failures += 1;
  s.lastErrorAtMs = nowMs;
  s.lastError = message;
  return message;
}

export function setupEpisodeV2HealthOnDb(db: EpisodeDb): Record<string, unknown> {
  const runtime = episodeHealthState();
  const episodeCount = Number((db.prepare("SELECT COUNT(*) n FROM setup_episodes WHERE episode_version=2").get() as any)?.n ?? 0);
  const actionCount = Number((db.prepare("SELECT COUNT(*) n FROM episode_actions").get() as any)?.n ?? 0);
  const labelCount = Number((db.prepare("SELECT COUNT(*) n FROM episode_outcome_labels_v2").get() as any)?.n ?? 0);
  const errorActive = runtime.lastErrorAtMs != null
    && (runtime.lastSuccessAtMs == null || runtime.lastErrorAtMs >= runtime.lastSuccessAtMs);
  return {
    status: errorActive ? "ERROR" : "OK",
    episodeCount,
    actionCount,
    labelCount,
    labelWriterAuthority: "PHASE_2_SUBSTRATE_ONLY",
    runtime,
  };
}

export function persistSetupEpisodeV2OnDb(db: EpisodeDb, episode: SetupEpisodeV2, nowMs = Date.now()) {
  const violations = validateZoneA(episode.zoneA, episode.t0Ms);
  if (violations.length) {
    persistenceFailed(violations.join("; "), nowMs);
    return { ok: false, inserted: false, episodeKey: episode.episodeKey, violations };
  }
  try {
    const existing = db.prepare("SELECT zone_a_json, config_digest FROM setup_episodes WHERE episode_key=?").get(episode.episodeKey) as any;
    const zoneJson = JSON.stringify(episode.zoneA);
    if (existing) {
      const same = existing.zone_a_json === zoneJson && existing.config_digest === episode.configDigest;
      if (same) persistenceOk(nowMs);
      else persistenceFailed("immutable episode identity conflict", nowMs);
      return { ok: same, inserted: false, episodeKey: episode.episodeKey, violations: same ? [] : ["immutable episode identity conflict"] };
    }
    const info = db.prepare(
      `INSERT INTO setup_episodes
        (episode_key,source,symbol,t0_ms,trading_day,session,tod_bucket,asset_class,direction,
         missing_json,gate_results_json,feature_schema_version,max_feature_as_of_ms,provenance_json,created_at_ms,
         episode_version,population,zone_a_json,config_digest,production_sha,strategy_version,feature_version,
         selected_strategy,selection_strength,disposition,rejection_reason,candidate_id,opportunity_case_id,
         thesis_fingerprint,selected_occ,source_lane,entry_convention)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      episode.episodeKey, episode.source, episode.symbol, episode.t0Ms, episode.tradingDay, episode.session, null, "option", episode.direction,
      JSON.stringify([]), JSON.stringify({}), 2, episode.maxFeatureAsOfMs,
      JSON.stringify({ sourceLane: episode.sourceLane }), nowMs,
      2, episode.population, zoneJson, episode.configDigest, episode.productionSha,
      episode.strategyVersion, episode.featureVersion, episode.selectedStrategy, episode.selectionStrength,
      episode.disposition, episode.rejectionReason, episode.candidateId, episode.opportunityCaseId,
      episode.thesisFingerprint, episode.selectedOcc, episode.sourceLane, episode.entryConvention,
    );
    persistenceOk(nowMs);
    return { ok: true, inserted: info.changes > 0, episodeKey: episode.episodeKey, violations: [] };
  } catch (error) {
    return { ok: false, inserted: false, episodeKey: episode.episodeKey, violations: [persistenceFailed(error, nowMs)] };
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
    persistenceFailed("counterfactual requires exact OCC, defensible entry, and explicit convention", nowMs);
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
    persistenceOk(nowMs);
    return { ok: true, inserted: r.changes > 0, reason: null };
  } catch (error) {
    return { ok: false, inserted: false, reason: persistenceFailed(error, nowMs) };
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
  hit10: boolean | null; hit25: boolean | null; hit50: boolean | null; hit100: boolean | null;
  hitNeg10: boolean | null; hitNeg20: boolean | null; hitStop: boolean | null;
  timeTo10Ms: number | null; timeTo25Ms: number | null; timeTo50Ms: number | null; timeTo100Ms: number | null;
  timeToNeg10Ms: number | null; timeToNeg20Ms: number | null; timeToStopMs: number | null;
  plus10BeforeNeg10: boolean | null; plus25BeforeNeg20: boolean | null;
  plus50BeforeStop: boolean | null; stopBeforePlus25: boolean | null;
  coverage: EvidenceCoverage;
  censored: boolean;
  missingReason: string | null;
  quoteCount: number | null;
  firstEvidenceAtMs: number | null;
  lastEvidenceAtMs: number | null;
  evidenceQuality: string;
  intrabarStatus: "ORDERED" | "AMBIGUOUS_INTRABAR" | "NOT_APPLICABLE";
  labelAsOfMs: number;
  configDigest: string;
}

export function appendOutcomeLabelV2OnDb(db: EpisodeDb, t0Ms: number, label: OutcomeLabelV2, nowMs = Date.now()) {
  if (!(label.labelAsOfMs > t0Ms)) {
    persistenceFailed("label must be strictly after t0", nowMs);
    return { ok: false, inserted: false, reason: "label must be strictly after t0" };
  }
  if (label.labelKind === "EXACT_OPTION_EXECUTABLE_LABEL" && (!label.exactOcc || !label.entryConvention)) {
    persistenceFailed("exact-option label requires OCC and entry convention", nowMs);
    return { ok: false, inserted: false, reason: "exact-option label requires OCC and entry convention" };
  }
  if (label.coverage === "INSUFFICIENT" && [label.terminalReturnPct, label.mfePct, label.maePct].some((x) => x != null)) {
    persistenceFailed("insufficient evidence cannot carry return/MFE/MAE", nowMs);
    return { ok: false, inserted: false, reason: "insufficient evidence cannot carry return/MFE/MAE" };
  }
  try {
    const bool = (v: boolean | null) => v == null ? null : v ? 1 : 0;
    const r = db.prepare(
      `INSERT OR IGNORE INTO episode_outcome_labels_v2
        (label_id,episode_key,label_kind,horizon,exact_occ,entry_convention,terminal_return_pct,mfe_pct,mae_pct,
         hit_10,hit_25,hit_50,hit_100,hit_neg_10,hit_neg_20,hit_stop,
         time_to_10_ms,time_to_25_ms,time_to_50_ms,time_to_100_ms,time_to_neg_10_ms,time_to_neg_20_ms,time_to_stop_ms,
         plus_10_before_neg_10,plus_25_before_neg_20,plus_50_before_stop,stop_before_plus_25,
         coverage,censored,missing_reason,quote_count,first_evidence_at_ms,last_evidence_at_ms,evidence_quality,
         intrabar_status,label_as_of_ms,config_digest,computed_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      label.labelId,label.episodeKey,label.labelKind,label.horizon,label.exactOcc,label.entryConvention,
      label.terminalReturnPct,label.mfePct,label.maePct,bool(label.hit10),bool(label.hit25),bool(label.hit50),bool(label.hit100),
      bool(label.hitNeg10),bool(label.hitNeg20),bool(label.hitStop),label.timeTo10Ms,label.timeTo25Ms,label.timeTo50Ms,
      label.timeTo100Ms,label.timeToNeg10Ms,label.timeToNeg20Ms,label.timeToStopMs,bool(label.plus10BeforeNeg10),
      bool(label.plus25BeforeNeg20),bool(label.plus50BeforeStop),bool(label.stopBeforePlus25),label.coverage,
      label.censored ? 1 : 0,label.missingReason,label.quoteCount,label.firstEvidenceAtMs,label.lastEvidenceAtMs,
      label.evidenceQuality,label.intrabarStatus,label.labelAsOfMs,label.configDigest,nowMs,
    );
    persistenceOk(nowMs);
    return { ok: true, inserted: r.changes > 0, reason: null };
  } catch (error) {
    return { ok: false, inserted: false, reason: persistenceFailed(error, nowMs) };
  }
}

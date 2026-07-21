/**
 * lib/research/flags.ts — feature flags for the multi-lane research rebuild.
 *
 * PURE resolver over env. EVERY flag defaults OFF so production behavior is
 * unchanged until an owner explicitly enables a lane. No flag here loosens an
 * existing production safety gate; they only opt-in to NEW, additive capability.
 * Existing production flags (PAPER_*, OPTIONS_*, BEARISH_ACTIONABLE,
 * AGENT_CALLOUT_DISCORD, …) are intentionally NOT re-defined here.
 */

const on = (v: string | undefined): boolean => v === "1";

export interface ResearchFlags {
  /** Phase 1: capture normalized SetupCandidate rows (read-only shadow). */
  setupCandidateCapture: boolean;
  /** Phase 2: lane router active (production path unchanged when off). */
  laneRouter: boolean;
  /** Phase 3/5: research paper generation + experiment ledger. */
  researchLane: boolean;
  /** Phase 3: independent Challenge consumer (falls back to legacy mirror when off). */
  challengeIndependent: boolean;
  /** Phase 4: new strategy-agent framework. */
  strategyAgentsV2: boolean;
  /** Phase 6: AI research pipeline jobs. */
  aiResearchPipeline: boolean;
  /** Phase 7: historical replay jobs. */
  historicalReplay: boolean;
  /** Analog Engine Phase A: capture Setup Episodes into the memory (read-only shadow). */
  episodeCapture: boolean;
  /** Phase F: prospective (forward) recommendation capture for live validation. */
  forwardCapture: boolean;
  /** Phase F: two-speed EARLY_WATCH → CONFIRMED/CANCELED/TOO_LATE/EXPIRED alert pipeline. */
  twoSpeedAlerts: boolean;
  /** Broad Discovery Bridge: shadow-mode broad candidate discovery (records only; no alerts). */
  broadDiscoveryShadow: boolean;
  /** Analog Shadow Bridge: shadow-mode analog lookup on live candidates (ANALOG_SHADOW_ONLY). */
  analogLiveShadow: boolean;
  /** Prospective market-context feature capture (regime/sector/breadth/…), no backfill. */
  marketContextCapture: boolean;
  /** AI_SHADOW_ONLY enrichment (advisory classification for shadow comparison only). */
  aiShadow: boolean;
  /** Earnings discovery source (shadow): needs a real earnings-calendar provider entitlement. */
  earningsDiscovery: boolean;
  /** Abnormal options-activity discovery source (shadow): uses the present-time chain. */
  optionsActivityDiscovery: boolean;
  /** Early options detection: strategy-appropriate early signals (does NOT require the +10% rule). */
  earlyOptionsDetection: boolean;
  /** Real-option paper trades (OCC contract + real bid/ask), graded separately from equity paper. */
  realOptionPaper: boolean;
  /** Strategy Improvement Lab: AI proposals gated through backtest/walk-forward/shadow/forward. */
  strategyImprovementLab: boolean;
  /** Independent Options discovery loop (does NOT depend on the stock-radar shouldTrigger). */
  independentOptionsDiscovery: boolean;
  /** Early options single-callout pipeline (message built; public delivery still gated + manual). */
  earlyOptionsCallouts: boolean;
}

export function researchFlags(env: NodeJS.ProcessEnv = process.env): ResearchFlags {
  return {
    setupCandidateCapture: on(env.SETUP_CANDIDATE_CAPTURE_ENABLED),
    laneRouter: on(env.LANE_ROUTER_ENABLED),
    researchLane: on(env.RESEARCH_LANE_ENABLED),
    challengeIndependent: on(env.CHALLENGE_INDEPENDENT_ENABLED),
    strategyAgentsV2: on(env.STRATEGY_AGENTS_V2_ENABLED),
    aiResearchPipeline: on(env.AI_RESEARCH_PIPELINE_ENABLED),
    historicalReplay: on(env.HISTORICAL_REPLAY_ENABLED),
    episodeCapture: on(env.EPISODE_CAPTURE_ENABLED),
    forwardCapture: on(env.FORWARD_CAPTURE_ENABLED),
    twoSpeedAlerts: on(env.TWO_SPEED_ALERTS_ENABLED),
    broadDiscoveryShadow: on(env.BROAD_DISCOVERY_SHADOW_ENABLED),
    analogLiveShadow: on(env.ANALOG_LIVE_SHADOW_ENABLED),
    marketContextCapture: on(env.MARKET_CONTEXT_CAPTURE_ENABLED),
    aiShadow: on(env.AI_SHADOW_ENABLED),
    earningsDiscovery: on(env.EARNINGS_DISCOVERY_ENABLED),
    optionsActivityDiscovery: on(env.OPTIONS_ACTIVITY_DISCOVERY_ENABLED),
    earlyOptionsDetection: on(env.EARLY_OPTIONS_DETECTION_ENABLED),
    realOptionPaper: on(env.REAL_OPTION_PAPER_ENABLED),
    strategyImprovementLab: on(env.STRATEGY_IMPROVEMENT_LAB_ENABLED),
    independentOptionsDiscovery: on(env.INDEPENDENT_OPTIONS_DISCOVERY_ENABLED),
    earlyOptionsCallouts: on(env.EARLY_OPTIONS_CALLOUTS_ENABLED),
  };
}

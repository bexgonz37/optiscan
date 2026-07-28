/**

 * entry-quality-gate.ts — shared deterministic entry-quality evaluation for subscriber opens.

 * Used immediately before Discord delivery (independent path) and in shadow/replay mode.

 */

import type { FrozenEntry } from "./research/options/callout.ts";

import { evaluateMarketSessionGuard, isEarlyCloseDay } from "./market-session-guard.ts";

import { tradingDay } from "./trading-session.ts";



export type EntryQualityVerdict =

  | "ALLOW"

  | "EARLY"

  | "TIMELY"

  | "LATE"

  | "CHASED"

  | "STALE"

  | "INSUFFICIENT_UPSIDE_REMAINING"

  | "WRONG_DIRECTIONAL_STRUCTURE"

  | "QUOTE_STALE"

  | "SPREAD_TOO_WIDE"

  | "SESSION_TOO_LATE";



export type DimensionVerdict = "PASS" | "WARN" | "FAIL";



export interface EntryQualityDimension {

  score: number;

  verdict: DimensionVerdict;

  reasons: string[];

}



export interface EntryQualityDimensions {

  setupQuality: EntryQualityDimension;

  entryEarliness: EntryQualityDimension;

  contractQuality: EntryQualityDimension;

  remainingOpportunity: EntryQualityDimension;

  sessionRisk: EntryQualityDimension;

  marketAlignment: EntryQualityDimension;

}



export interface EntryQualityInput {

  side: "call" | "put";

  dte: number | null;

  nowMs: number;

  /** First detection timestamps/prices (null if unknown — gate is conservative). */

  firstDetectedAtMs?: number | null;

  underlyingAtFirstDetection?: number | null;

  optionAtFirstDetection?: number | null;

  underlyingNow: number;

  optionNow: number;

  /** Recent window moves (%). */

  underlyingMove5m?: number | null;

  underlyingMove15m?: number | null;

  underlyingMove30m?: number | null;

  underlyingMove60m?: number | null;

  optionMove5m?: number | null;

  optionMove15m?: number | null;

  optionMove30m?: number | null;

  quoteAgeMs?: number | null;

  spreadPct?: number | null;

  vwapDistPct?: number | null;

  vwapSlope?: number | null;

  aboveVwap?: boolean | null;

  higherHighs?: boolean | null;

  higherLows?: boolean | null;

  lowerHighs?: boolean | null;

  lowerLows?: boolean | null;

  momentumAccel?: number | null;

  marketAligned?: boolean | null;

  sectorAligned?: boolean | null;

  minutesToSessionClose?: number | null;

  targets?: FrozenEntry | null;

  sessionState?: string | null;

}



export interface EntryQualityResult {

  verdict: EntryQualityVerdict;

  subscriberAction: "SEND" | "BLOCK" | "SHADOW_ONLY";

  reasons: string[];

  metrics: Record<string, number | string | boolean | null>;

  dimensions: EntryQualityDimensions;

  composite: {

    subscriberAction: "SEND" | "BLOCK" | "SHADOW_ONLY";

    primaryVerdict: EntryQualityVerdict;

    reasons: string[];

  };

}



function num(env: NodeJS.ProcessEnv, key: string, d: number): number {

  const x = Number(env[key]);

  return Number.isFinite(x) ? x : d;

}



function parseEtMinutes(hhmm: string): number | null {

  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());

  if (!m) return null;

  return Number(m[1]) * 60 + Number(m[2]);

}



const etClockFmt = new Intl.DateTimeFormat("en-US", {

  timeZone: "America/New_York",

  weekday: "short",

  hour: "2-digit",

  minute: "2-digit",

  hour12: false,

});



function etMinutes(nowMs: number): { weekday: string; minutes: number } {

  const parts = etClockFmt.formatToParts(new Date(nowMs));

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";

  const hour = Number(get("hour")) % 24;

  return { weekday: get("weekday"), minutes: hour * 60 + Number(get("minute")) };

}



export function entryQualityConfig(env: NodeJS.ProcessEnv = process.env) {

  return {

    maxUnderlyingPre60m: num(env, "ENTRY_MAX_UNDERLYING_PREMOVE_60M_PCT", 0.75),

    lateUnderlyingPre60m: num(env, "ENTRY_MAX_UNDERLYING_PREMOVE_LATE_PCT", 0.4),

    timelyUnderlyingPre60m: num(env, "ENTRY_MAX_UNDERLYING_PREMOVE_TIMELY_PCT", 0.15),

    maxOptionPre30m: num(env, "ENTRY_MAX_OPTION_PREMOVE_30M_PCT", 25),

    lateOptionPre30m: num(env, "ENTRY_MAX_OPTION_PREMOVE_LATE_PCT", 15),

    timelyOptionPre30m: num(env, "ENTRY_MAX_OPTION_PREMOVE_TIMELY_PCT", 5),

    maxSpreadPct: num(env, "ENTRY_MAX_SPREAD_PCT", 10),

    maxQuoteAgeMs: num(env, "ENTRY_MAX_QUOTE_AGE_MS", 15_000),

    minUpsideToT1Pct: num(env, "ENTRY_MIN_UPSIDE_TO_T1_PCT", 8),

    dte0CutoffMinutes: num(env, "OPTIONS_0DTE_DELIVERY_CUTOFF_MINUTES", 60),

    dte0LatestEntryEt: env.OPTIONS_0DTE_LATEST_ENTRY_ET ?? "13:30",

    dte0MinMinutesToClose: num(env, "OPTIONS_0DTE_MIN_MINUTES_TO_CLOSE", 120),

    dte0EarlyCloseLatestEntryEt: env.OPTIONS_0DTE_EARLY_CLOSE_LATEST_ENTRY_ET ?? "11:30",

    dte0FridayLatestEntryEt: env.OPTIONS_0DTE_FRIDAY_LATEST_ENTRY_ET ?? "13:00",

    dte0ChaseLimitPct: num(env, "OPTIONS_0DTE_CHASE_LIMIT_PCT", 0.4),

    requireHhHlForCall: env.ENTRY_REQUIRE_HH_HL_FOR_CALL !== "0",

  };

}



/** 0DTE late-session rule: stricter of wall-clock ET cutoff and minutes-to-close wins. */

export function evaluate0DteSessionCutoff(input: EntryQualityInput, env: NodeJS.ProcessEnv = process.env): {

  blocked: boolean;

  reason: string | null;

  wallClockCutoffEt: string | null;

  minMinutesToClose: number | null;

} {

  const cfg = entryQualityConfig(env);

  if (input.dte == null || input.dte > 0) {

    return { blocked: false, reason: null, wallClockCutoffEt: null, minMinutesToClose: null };

  }

  const day = tradingDay(input.nowMs);

  const { weekday, minutes } = etMinutes(input.nowMs);

  const isFriday = weekday === "Fri";

  const isEarlyClose = isEarlyCloseDay(day, env);

  const wallClockCutoffEt = isEarlyClose

    ? cfg.dte0EarlyCloseLatestEntryEt

    : isFriday

      ? cfg.dte0FridayLatestEntryEt

      : cfg.dte0LatestEntryEt;

  const wallClockCutoffMin = parseEtMinutes(wallClockCutoffEt);

  const wallClockBlocked = wallClockCutoffMin != null && minutes >= wallClockCutoffMin;

  const minutesBlocked = input.minutesToSessionClose != null && input.minutesToSessionClose <= cfg.dte0MinMinutesToClose;

  const legacyBlocked = input.minutesToSessionClose != null && input.minutesToSessionClose <= cfg.dte0CutoffMinutes;

  const blocked = wallClockBlocked || minutesBlocked || legacyBlocked;

  let reason: string | null = null;

  if (blocked) {

    const parts: string[] = [];

    if (wallClockBlocked) parts.push(`ET cutoff ${wallClockCutoffEt}`);

    if (minutesBlocked) parts.push(`minutes-to-close ${input.minutesToSessionClose} <= ${cfg.dte0MinMinutesToClose}`);

    if (legacyBlocked && !minutesBlocked) parts.push(`legacy cutoff ${cfg.dte0CutoffMinutes}m`);

    reason = parts.join("; ");

  }

  return {

    blocked,

    reason,

    wallClockCutoffEt,

    minMinutesToClose: cfg.dte0MinMinutesToClose,

  };

}



function movePct(from: number | null | undefined, to: number): number | null {

  if (from == null || !Number.isFinite(from) || from === 0) return null;

  return ((to / from) - 1) * 100;

}



function upsideToTargetPct(current: number, target: number | null | undefined, side: "call" | "put"): number | null {

  if (target == null || !Number.isFinite(target) || current <= 0) return null;

  if (side === "call") return ((target - current) / current) * 100;

  return ((current - target) / current) * 100;

}



function classifyEarliness(

  uPre: number | null,

  oPre: number | null,

  cfg: ReturnType<typeof entryQualityConfig>,

): EntryQualityVerdict {

  const u = Math.abs(uPre ?? 0);

  const o = Math.abs(oPre ?? 0);

  if (u >= cfg.maxUnderlyingPre60m || o >= cfg.maxOptionPre30m) return "CHASED";

  if (u >= cfg.lateUnderlyingPre60m || o >= cfg.lateOptionPre30m) return "LATE";

  if (u >= cfg.timelyUnderlyingPre60m || o >= cfg.timelyOptionPre30m) return "TIMELY";

  if (uPre == null && oPre == null) return "TIMELY";

  return "EARLY";

}



function dim(score: number, verdict: DimensionVerdict, reasons: string[] = []): EntryQualityDimension {

  return { score: +Math.max(0, Math.min(100, score)).toFixed(1), verdict, reasons };

}



function gateMode(env: NodeJS.ProcessEnv): "off" | "shadow" | "enforce" {

  const m = String(env.ENTRY_QUALITY_GATE ?? "shadow").toLowerCase();

  if (m === "0" || m === "off") return "off";

  if (m === "enforce" || m === "1") return "enforce";

  return "shadow";

}



function buildComposite(

  dimensions: EntryQualityDimensions,

  hardVerdict: EntryQualityVerdict | null,

  hardAction: "SEND" | "BLOCK" | "SHADOW_ONLY" | null,

  env: NodeJS.ProcessEnv,

): EntryQualityResult["composite"] {

  const mode = gateMode(env);

  const fails = Object.values(dimensions).filter((d) => d.verdict === "FAIL");

  const warns = Object.values(dimensions).filter((d) => d.verdict === "WARN");

  const reasons = [...fails.flatMap((d) => d.reasons), ...warns.flatMap((d) => d.reasons)];



  if (hardVerdict && hardAction) {

    return { subscriberAction: hardAction, primaryVerdict: hardVerdict, reasons: reasons.length ? reasons : [hardVerdict] };

  }



  const sessionFail = dimensions.sessionRisk.verdict === "FAIL";

  const contractFail = dimensions.contractQuality.verdict === "FAIL";

  const setupFail = dimensions.setupQuality.verdict === "FAIL";

  const remainingFail = dimensions.remainingOpportunity.verdict === "FAIL";

  const alignmentFail = dimensions.marketAlignment.verdict === "FAIL";

  const earlinessFail = dimensions.entryEarliness.verdict === "FAIL";



  const shouldBlock =

    sessionFail

    || contractFail

    || setupFail

    || remainingFail

    || alignmentFail

    || (earlinessFail && (remainingFail || setupFail || dimensions.remainingOpportunity.verdict === "WARN"));



  let primaryVerdict: EntryQualityVerdict = "ALLOW";

  if (sessionFail) primaryVerdict = "SESSION_TOO_LATE";

  else if (contractFail) primaryVerdict = dimensions.contractQuality.reasons.some((r) => r.includes("spread")) ? "SPREAD_TOO_WIDE" : "QUOTE_STALE";

  else if (alignmentFail) primaryVerdict = "WRONG_DIRECTIONAL_STRUCTURE";

  else if (remainingFail) primaryVerdict = "INSUFFICIENT_UPSIDE_REMAINING";

  else if (earlinessFail) primaryVerdict = dimensions.entryEarliness.reasons.some((r) => r.includes("CHASED")) ? "CHASED" : "LATE";

  else if (dimensions.entryEarliness.verdict === "WARN") primaryVerdict = "TIMELY";

  else if (dimensions.entryEarliness.score >= 85) primaryVerdict = "EARLY";



  let subscriberAction: "SEND" | "BLOCK" | "SHADOW_ONLY" = shouldBlock ? "BLOCK" : "SEND";

  if (mode === "off") subscriberAction = "SEND";

  else if (mode === "shadow" && shouldBlock) subscriberAction = "SHADOW_ONLY";



  return { subscriberAction, primaryVerdict, reasons: reasons.length ? reasons : [`entry quality ${primaryVerdict}`] };

}



/** Evaluate whether a subscriber opening is actionable at delivery time. */

export function evaluateEntryQuality(input: EntryQualityInput, env: NodeJS.ProcessEnv = process.env): EntryQualityResult {

  const cfg = entryQualityConfig(env);

  const metrics: Record<string, number | string | boolean | null> = {};



  const uPre60 = movePct(input.underlyingAtFirstDetection, input.underlyingNow) ?? input.underlyingMove60m ?? null;

  const oPre30 = movePct(input.optionAtFirstDetection, input.optionNow) ?? input.optionMove30m ?? null;

  metrics.underlying_pre_move_60m_pct = uPre60;

  metrics.option_pre_move_30m_pct = oPre30;

  metrics.quote_age_ms = input.quoteAgeMs ?? null;

  metrics.spread_pct = input.spreadPct ?? null;



  const dte0 = evaluate0DteSessionCutoff(input, env);

  metrics.dte0_wall_clock_cutoff_et = dte0.wallClockCutoffEt;

  metrics.dte0_min_minutes_to_close = dte0.minMinutesToClose;



  // Contract quality

  let contractQuality = dim(100, "PASS");

  if (input.spreadPct != null && input.spreadPct > cfg.maxSpreadPct) {

    contractQuality = dim(0, "FAIL", [`spread ${input.spreadPct.toFixed(1)}% > max ${cfg.maxSpreadPct}%`]);

    const dimensions: EntryQualityDimensions = {

      setupQuality: dim(50, "WARN"),

      entryEarliness: dim(50, "WARN"),

      contractQuality,

      remainingOpportunity: dim(50, "WARN"),

      sessionRisk: dim(100, "PASS"),

      marketAlignment: dim(50, "WARN"),

    };

    const composite = buildComposite(dimensions, "SPREAD_TOO_WIDE", "BLOCK", env);

    return { verdict: composite.primaryVerdict, subscriberAction: composite.subscriberAction, reasons: composite.reasons, metrics, dimensions, composite };

  }

  if (input.quoteAgeMs != null && input.quoteAgeMs > cfg.maxQuoteAgeMs) {

    contractQuality = dim(0, "FAIL", [`quote age ${input.quoteAgeMs}ms > max ${cfg.maxQuoteAgeMs}ms`]);

    const dimensions: EntryQualityDimensions = {

      setupQuality: dim(50, "WARN"),

      entryEarliness: dim(50, "WARN"),

      contractQuality,

      remainingOpportunity: dim(50, "WARN"),

      sessionRisk: dim(100, "PASS"),

      marketAlignment: dim(50, "WARN"),

    };

    const composite = buildComposite(dimensions, "QUOTE_STALE", "BLOCK", env);

    return { verdict: composite.primaryVerdict, subscriberAction: composite.subscriberAction, reasons: composite.reasons, metrics, dimensions, composite };

  }



  // Session risk (0DTE)

  let sessionRisk = dim(100, "PASS");

  if (input.dte != null && input.dte <= 0 && dte0.blocked) {

    sessionRisk = dim(0, "FAIL", [`0DTE session cutoff: ${dte0.reason}`]);

    const dimensions: EntryQualityDimensions = {

      setupQuality: dim(50, "WARN"),

      entryEarliness: dim(50, "WARN"),

      contractQuality,

      remainingOpportunity: dim(50, "WARN"),

      sessionRisk,

      marketAlignment: dim(50, "WARN"),

    };

    const composite = buildComposite(dimensions, "SESSION_TOO_LATE", "BLOCK", env);

    return { verdict: composite.primaryVerdict, subscriberAction: composite.subscriberAction, reasons: composite.reasons, metrics, dimensions, composite };

  }



  // Market alignment + setup quality

  let marketAlignment = dim(80, "PASS");

  let setupQuality = dim(75, "PASS");

  if (input.side === "put") {
    if (input.higherHighs === true && input.higherLows === true) {
      marketAlignment = dim(0, "FAIL", ["higher highs and higher lows - bullish structure"]);
      setupQuality = dim(20, "FAIL", ["bullish structure on PUT"]);
    } else if (input.aboveVwap === true && (input.vwapDistPct ?? 0) > 0.05) {
      marketAlignment = dim(20, "FAIL", ["PUT while materially above VWAP"]);
      setupQuality = dim(30, "FAIL", ["above VWAP on PUT"]);
    } else if (input.momentumAccel != null && input.momentumAccel > 0 && (input.underlyingMove5m ?? 0) > 0) {
      marketAlignment = dim(35, "FAIL", ["accelerating bullish momentum on PUT"]);
      setupQuality = dim(40, "WARN", ["bullish momentum acceleration"]);
    } else {
      let setupScore = 70;
      if (input.lowerHighs === true && input.lowerLows === true) setupScore += 15;
      if (input.aboveVwap === false) setupScore += 10;
      if (input.momentumAccel != null && input.momentumAccel < 0) setupScore += 5;
      if (input.marketAligned === true) { setupScore += 5; marketAlignment = dim(90, "PASS", ["market aligned"]); }
      setupQuality = dim(setupScore, setupScore >= 70 ? "PASS" : "WARN");
    }

  }



  if (input.side === "call") {

    if (input.lowerHighs === true && input.lowerLows === true) {

      marketAlignment = dim(0, "FAIL", ["lower highs and lower lows — bearish structure"]);

      setupQuality = dim(20, "FAIL", ["bearish structure on CALL"]);

    } else if (cfg.requireHhHlForCall && input.higherHighs === false && input.higherLows === false) {

      setupQuality = dim(25, "FAIL", ["CALL without higher-high/higher-low confirmation"]);

      marketAlignment = dim(30, "FAIL", ["missing bullish structure confirmation"]);

    } else if (input.aboveVwap === false && (input.vwapDistPct ?? 0) < -0.05) {

      marketAlignment = dim(20, "FAIL", ["CALL while materially below VWAP"]);

      setupQuality = dim(30, "FAIL", ["below VWAP on CALL"]);

    } else if (input.momentumAccel != null && input.momentumAccel < 0 && (input.underlyingMove5m ?? 0) < 0) {

      marketAlignment = dim(35, "FAIL", ["decelerating bearish momentum on CALL"]);

      setupQuality = dim(40, "WARN", ["momentum deceleration"]);

    } else {

      let setupScore = 70;

      if (input.higherHighs === true && input.higherLows === true) setupScore += 15;

      if (input.aboveVwap === true) setupScore += 10;

      if (input.marketAligned === true) { setupScore += 5; marketAlignment = dim(90, "PASS", ["market aligned"]); }

      setupQuality = dim(setupScore, setupScore >= 70 ? "PASS" : "WARN");

    }

  }



  // Remaining opportunity — T1/T2 in FrozenEntry are option premium targets, not underlying levels.
  const upsideT1 = input.targets?.t1 != null
    ? upsideToTargetPct(input.optionNow, input.targets.t1, "call")
    : upsideToTargetPct(input.underlyingNow, input.targets?.t1 ?? null, input.side);
  const upsideT2 = input.targets?.t2 != null
    ? upsideToTargetPct(input.optionNow, input.targets.t2, "call")
    : null;
  metrics.upside_to_t1_pct = upsideT1;
  metrics.upside_to_t2_pct = upsideT2;

  let remainingOpportunity = dim(80, "PASS");

  if (upsideT1 != null && upsideT1 < cfg.minUpsideToT1Pct) {

    remainingOpportunity = dim(Math.max(0, upsideT1 * 5), "FAIL", [`insufficient upside to T1 (${upsideT1.toFixed(2)}% < ${cfg.minUpsideToT1Pct}%)`]);

  } else if (upsideT1 != null) {

    remainingOpportunity = dim(Math.min(100, 60 + upsideT1 * 2), "PASS");

  }



  // Entry earliness

  const earlinessLabel = classifyEarliness(uPre60, oPre30, cfg);

  metrics.earliness = earlinessLabel;

  const is0dte = input.dte != null && input.dte <= 0;

  const chaseLimit = is0dte ? cfg.dte0ChaseLimitPct : num(env, "OPTIONS_CHASE_LIMIT_PCT", 0.6);

  const favMove = uPre60 ?? input.underlyingMove30m ?? 0;

  let entryEarliness = dim(85, "PASS");

  if (favMove > chaseLimit) {

    entryEarliness = dim(0, "FAIL", [`underlying favorable move ${favMove.toFixed(2)}% > chase ${chaseLimit.toFixed(2)}%`]);

  } else if (earlinessLabel === "CHASED") {

    entryEarliness = dim(10, "FAIL", [`earliness CHASED (u60=${(uPre60 ?? 0).toFixed(2)}%, o30=${(oPre30 ?? 0).toFixed(2)}%)`]);

  } else if (earlinessLabel === "LATE") {

    entryEarliness = dim(35, "FAIL", [`earliness LATE (u60=${(uPre60 ?? 0).toFixed(2)}%, o30=${(oPre30 ?? 0).toFixed(2)}%)`]);

  } else if (earlinessLabel === "TIMELY") {

    entryEarliness = dim(65, "WARN", ["timely entry — some pre-move already occurred"]);

  } else if (earlinessLabel === "EARLY") {

    entryEarliness = dim(90, "PASS", ["early entry"]);

  }



  const dimensions: EntryQualityDimensions = {

    setupQuality,

    entryEarliness,

    contractQuality,

    remainingOpportunity,

    sessionRisk,

    marketAlignment,

  };



  const composite = buildComposite(dimensions, null, null, env);

  if (gateMode(env) === "off") {

    return {

      verdict: "ALLOW",

      subscriberAction: "SEND",

      reasons: ["gate disabled"],

      metrics,

      dimensions,

      composite: { subscriberAction: "SEND", primaryVerdict: "ALLOW", reasons: ["gate disabled"] },

    };

  }



  return {

    verdict: composite.primaryVerdict,

    subscriberAction: composite.subscriberAction,

    reasons: composite.reasons,

    metrics,

    dimensions,

    composite,

  };

}



/** Build input from delivery payload + instrumentation fields. */

export function entryQualityFromDelivery(

  input: {

    side: "call" | "put";

    dte?: number | null;

    underlyingNow: number;

    optionNow: number;

    observedUnderlyingPrice: number;

    contract: { spreadPct?: number | null; quoteAgeMs?: number | null };

    entry?: FrozenEntry | null;

    firstDetectedAtMs?: number | null;

    underlyingAtFirstDetection?: number | null;

    optionAtFirstDetection?: number | null;

    featureSnapshot?: Record<string, unknown> | null;

    minutesToSessionClose?: number | null;

    sessionState?: string | null;

    nowMs?: number;

  },

  nowMs: number,

  env: NodeJS.ProcessEnv = process.env,

): EntryQualityInput {

  const snap = input.featureSnapshot ?? {};

  const feature = (snap.underlying && typeof snap.underlying === "object") ? snap.underlying as Record<string, unknown> : snap as Record<string, unknown>;

  const effectiveNow = input.nowMs ?? nowMs;

  const minutesToSessionClose = input.minutesToSessionClose ?? (() => {

    const guard = evaluateMarketSessionGuard(effectiveNow, env);

    return Math.round((guard.regularCloseMs - effectiveNow) / 60000);

  })();

  return {

    side: input.side,

    dte: input.dte ?? null,

    nowMs: effectiveNow,

    firstDetectedAtMs: input.firstDetectedAtMs,

    underlyingAtFirstDetection: input.underlyingAtFirstDetection ?? input.observedUnderlyingPrice,

    optionAtFirstDetection: input.optionAtFirstDetection ?? input.optionNow,

    underlyingNow: input.underlyingNow,

    optionNow: input.optionNow,

    quoteAgeMs: input.contract.quoteAgeMs,

    spreadPct: input.contract.spreadPct,

    vwapDistPct: typeof feature.vwapDistPct === "number" ? feature.vwapDistPct : null,

    aboveVwap: typeof feature.aboveVwap === "boolean" ? feature.aboveVwap : null,

    momentumAccel: typeof feature.accel === "number" ? feature.accel : (typeof feature.accelPct === "number" ? feature.accelPct : (typeof snap.accel === "number" ? snap.accel : null)),

    higherHighs: typeof feature.higherHighs === "boolean" ? feature.higherHighs : null,

    higherLows: typeof feature.higherLows === "boolean" ? feature.higherLows : null,

    lowerHighs: typeof feature.lowerHighs === "boolean" ? feature.lowerHighs : null,

    lowerLows: typeof feature.lowerLows === "boolean" ? feature.lowerLows : null,

    minutesToSessionClose,

    targets: input.entry ?? null,

    sessionState: input.sessionState ?? null,

  };

}



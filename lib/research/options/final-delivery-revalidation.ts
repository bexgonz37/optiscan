/**
 * final-delivery-revalidation.ts — deterministic last gate immediately before Discord send.
 * Runs after batch ranking so opportunities that became late while waiting are blocked.
 */
import { evaluateEntryQuality, entryQualityFromDelivery, type EntryQualityResult } from "../../entry-quality-gate.ts";
import { isSameTradingSession } from "../../market-session-guard.ts";
import { tradingDay } from "../../trading-session.ts";
import { isReadyCandidateExpired, readyTtlMs } from "./instrumentation.ts";
import type { DeliveryInput } from "./delivery.ts";
import { setupSentence } from "./format.ts";

export type DeliveryRejectionCode =
  | "LATE_ENTRY"
  | "CHASED_OPTION_PREMIUM"
  | "MOVE_ALREADY_COMPLETED"
  | "INSUFFICIENT_UPSIDE_REMAINING"
  | "STALE_READY_CANDIDATE"
  | "QUOTE_STALE"
  | "WRONG_DIRECTIONAL_STRUCTURE"
  | "MOMENTUM_EXHAUSTED"
  | "SESSION_TOO_LATE"
  | "EXPIRED_TRADING_SESSION"
  | "SPREAD_TOO_WIDE";

export type TimingClass = "EARLY" | "TIMELY" | "LATE";

export interface FinalDeliveryRevalidationInput {
  deliveryInput: DeliveryInput;
  nowMs: number;
  readyExpiresAtMs?: number | null;
  firstReadyAtMs?: number | null;
}

export interface FinalDeliveryRevalidationResult {
  allowed: boolean;
  rejectionCode: DeliveryRejectionCode | null;
  reasons: string[];
  timingClass: TimingClass;
  actionableReason: string;
  invalidation: string;
  entryQuality: EntryQualityResult;
  metrics: Record<string, number | string | boolean | null>;
}

function movePct(from: number | null | undefined, to: number): number | null {
  if (from == null || !Number.isFinite(from) || from === 0) return null;
  return +(((to / from) - 1) * 100).toFixed(4);
}

function upsideToTargetPct(current: number, target: number | null | undefined, side: "call" | "put"): number | null {
  if (target == null || !Number.isFinite(target) || current <= 0) return null;
  if (side === "call") return +(((target - current) / current) * 100).toFixed(4);
  return +(((current - target) / current) * 100).toFixed(4);
}

function num(env: NodeJS.ProcessEnv, key: string, d: number): number {
  const x = Number(env[key]);
  return Number.isFinite(x) ? x : d;
}

/** Map entry-quality verdicts to standardized delivery rejection codes. */
export function mapVerdictToDeliveryRejection(verdict: string): DeliveryRejectionCode | null {
  switch (verdict) {
    case "LATE": return "LATE_ENTRY";
    case "CHASED": return "CHASED_OPTION_PREMIUM";
    case "INSUFFICIENT_UPSIDE_REMAINING": return "INSUFFICIENT_UPSIDE_REMAINING";
    case "QUOTE_STALE": return "QUOTE_STALE";
    case "SPREAD_TOO_WIDE": return "SPREAD_TOO_WIDE";
    case "SESSION_TOO_LATE": return "SESSION_TOO_LATE";
    case "WRONG_DIRECTIONAL_STRUCTURE": return "WRONG_DIRECTIONAL_STRUCTURE";
    case "STALE": return "STALE_READY_CANDIDATE";
    default: return null;
  }
}

function timingClassFromEntryQuality(eq: EntryQualityResult): TimingClass {
  const earliness = eq.metrics.earliness;
  if (earliness === "EARLY" || earliness === "ALLOW") return "EARLY";
  if (earliness === "TIMELY") return "TIMELY";
  return "LATE";
}

function buildActionableReason(eq: EntryQualityResult, strategyKey: string): string {
  const cls = timingClassFromEntryQuality(eq);
  const setup = setupSentence(strategyKey);
  if (cls === "EARLY") return `${setup} Setup still early with meaningful upside remaining.`;
  if (cls === "TIMELY") return `${setup} Confirmed structure with room to T1/T2 — not yet extended.`;
  return setup;
}

function buildInvalidation(entry: DeliveryInput["entry"], side: "call" | "put"): string {
  if (!entry?.stop) return side === "call" ? "Break below frozen stop or loss of bullish structure." : "Break above frozen stop or loss of bearish structure.";
  return side === "call"
    ? `Invalid below $${entry.stop.toFixed(2)} (frozen stop) or on bearish structure break.`
    : `Invalid above $${entry.stop.toFixed(2)} (frozen stop) or on bullish structure break.`;
}

/**
 * Final deterministic revalidation immediately before Discord send.
 * Blocks measurably late, chased, stale, or exhausted setups even if they passed batch ranking.
 */
export function revalidateBeforeDiscordSend(
  input: FinalDeliveryRevalidationInput,
  env: NodeJS.ProcessEnv = process.env,
): FinalDeliveryRevalidationResult {
  const { deliveryInput: d, nowMs } = input;
  const side = d.contract.side;
  const optMid = d.entry?.mid ?? ((d.contract.bid ?? 0) + (d.contract.ask ?? 0)) / 2;
  const metrics: Record<string, number | string | boolean | null> = {};

  const candidateSession = d.tradingSessionDate ?? tradingDay(d.firstDetectedAtMs ?? nowMs);
  metrics.trading_session_date = candidateSession;
  metrics.current_trading_session = tradingDay(nowMs);

  if (!isSameTradingSession(candidateSession, nowMs)) {
    const eqStub = evaluateEntryQuality(
      entryQualityFromDelivery({
        side,
        dte: d.contract.dte ?? null,
        underlyingNow: d.currentUnderlyingPrice,
        optionNow: optMid,
        observedUnderlyingPrice: d.observedUnderlyingPrice,
        contract: d.contract,
        entry: d.entry,
        firstDetectedAtMs: d.firstDetectedAtMs,
        underlyingAtFirstDetection: d.underlyingAtFirstDetection,
        optionAtFirstDetection: d.optionAtFirstDetection,
        featureSnapshot: d.featureSnapshot,
        nowMs,
      }, nowMs, env),
      env,
    );
    return {
      allowed: false,
      rejectionCode: "EXPIRED_TRADING_SESSION",
      reasons: [`candidate session ${candidateSession} != current ${tradingDay(nowMs)}`],
      timingClass: "LATE",
      actionableReason: "",
      invalidation: buildInvalidation(d.entry, side),
      entryQuality: eqStub,
      metrics,
    };
  }

  const readyExpires = input.readyExpiresAtMs ?? (d.firstReadyAtMs != null ? d.firstReadyAtMs + readyTtlMs(env) : null);
  if (isReadyCandidateExpired(readyExpires, nowMs)) {
    metrics.ready_expires_at_ms = readyExpires;
    metrics.ready_age_ms = input.firstReadyAtMs != null ? nowMs - input.firstReadyAtMs : null;
    const eqStub = evaluateEntryQuality(
      entryQualityFromDelivery({ side, dte: d.contract.dte ?? null, underlyingNow: d.currentUnderlyingPrice, optionNow: optMid, observedUnderlyingPrice: d.observedUnderlyingPrice, contract: d.contract, entry: d.entry, firstDetectedAtMs: d.firstDetectedAtMs, underlyingAtFirstDetection: d.underlyingAtFirstDetection, optionAtFirstDetection: d.optionAtFirstDetection, featureSnapshot: d.featureSnapshot, nowMs }, nowMs, env),
      env,
    );
    return {
      allowed: false,
      rejectionCode: "STALE_READY_CANDIDATE",
      reasons: [`READY candidate expired (readyExpiresAtMs=${readyExpires})`],
      timingClass: "LATE",
      actionableReason: "",
      invalidation: buildInvalidation(d.entry, side),
      entryQuality: eqStub,
      metrics,
    };
  }

  const eqInput = entryQualityFromDelivery({
    side,
    dte: d.contract.dte ?? null,
    underlyingNow: d.currentUnderlyingPrice,
    optionNow: optMid,
    observedUnderlyingPrice: d.observedUnderlyingPrice,
    contract: d.contract,
    entry: d.entry,
    firstDetectedAtMs: d.firstDetectedAtMs,
    underlyingAtFirstDetection: d.underlyingAtFirstDetection,
    optionAtFirstDetection: d.optionAtFirstDetection,
    featureSnapshot: d.featureSnapshot,
    nowMs,
  }, nowMs, env);
  const eq = evaluateEntryQuality(eqInput, env);

  const uPre = movePct(d.underlyingAtFirstDetection ?? d.observedUnderlyingPrice, d.currentUnderlyingPrice)
    ?? (eq.metrics.underlying_pre_move_60m_pct as number | null);
  const oPre = movePct(d.optionAtFirstDetection, optMid)
    ?? (eq.metrics.option_pre_move_30m_pct as number | null);
  const upsideT1 = d.entry?.t1 != null
    ? upsideToTargetPct(optMid, d.entry.t1, "call")
    : null;
  const upsideT2 = d.entry?.t2 != null
    ? upsideToTargetPct(optMid, d.entry.t2, "call")
    : null;
  const detectionLatencyMs = d.firstDetectedAtMs ? nowMs - d.firstDetectedAtMs : null;

  metrics.underlying_pre_move_pct = uPre;
  metrics.option_pre_move_pct = oPre;
  metrics.upside_to_t1_pct = upsideT1;
  metrics.upside_to_t2_pct = upsideT2;
  metrics.detection_to_delivery_ms = detectionLatencyMs;
  metrics.quote_age_ms = d.contract.quoteAgeMs;
  metrics.spread_pct = d.contract.spreadPct;

  const timingClass = timingClassFromEntryQuality(eq);
  const actionableReason = buildActionableReason(eq, d.strategy);
  const invalidation = buildInvalidation(d.entry, side);

  const maxBatchWaitMs = num(env, "OPTIONS_MAX_BATCH_WAIT_MS", readyTtlMs(env));
  if (detectionLatencyMs != null && detectionLatencyMs > maxBatchWaitMs) {
    return {
      allowed: false,
      rejectionCode: "STALE_READY_CANDIDATE",
      reasons: [`detection-to-delivery ${detectionLatencyMs}ms > max batch wait ${maxBatchWaitMs}ms`],
      timingClass: "LATE",
      actionableReason: "",
      invalidation,
      entryQuality: eq,
      metrics,
    };
  }

  const nearlyAtT1Pct = num(env, "ENTRY_NEAR_TARGET_BLOCK_PCT", 3);
  const moveCompletedUnderlyingPct = num(env, "ENTRY_MOVE_COMPLETED_BLOCK_PCT", 0.4);
  if (upsideT1 != null && upsideT1 < nearlyAtT1Pct && Math.abs(uPre ?? 0) >= moveCompletedUnderlyingPct) {
    return {
      allowed: false,
      rejectionCode: "MOVE_ALREADY_COMPLETED",
      reasons: [`T1 nearly reached (${upsideT1.toFixed(2)}% remaining) after ${(uPre ?? 0).toFixed(2)}% underlying move`],
      timingClass: "LATE",
      actionableReason: "",
      invalidation,
      entryQuality: eq,
      metrics,
    };
  }

  const snap = d.featureSnapshot ?? {};
  const feature = (snap.underlying && typeof snap.underlying === "object") ? snap.underlying as Record<string, unknown> : snap as Record<string, unknown>;
  const momentumAccel = typeof feature.accel === "number" ? feature.accel : null;
  const move5m = typeof feature.move5m === "number" ? feature.move5m : null;
  if (side === "call" && momentumAccel != null && momentumAccel < -0.05 && (move5m ?? 0) < 0) {
    return {
      allowed: false,
      rejectionCode: "MOMENTUM_EXHAUSTED",
      reasons: [`momentum decelerating (accel=${momentumAccel.toFixed(3)}, move5m=${(move5m ?? 0).toFixed(2)}%)`],
      timingClass: "LATE",
      actionableReason: "",
      invalidation,
      entryQuality: eq,
      metrics,
    };
  }

  const gateMode = String(env.ENTRY_QUALITY_GATE ?? "shadow").toLowerCase();
  const enforce = gateMode === "enforce" || gateMode === "1";

  // Freshness/liquidity first — aged Stage-2 quotes must fail before earliness labeling.
  const maxSpread = d.maxSpreadPct ?? num(env, "ENTRY_MAX_SPREAD_PCT", 10);
  const maxAge = d.maxQuoteAgeMs ?? num(env, "ENTRY_MAX_QUOTE_AGE_MS", 15_000);
  if (d.contract.spreadPct != null && d.contract.spreadPct > maxSpread) {
    return { allowed: false, rejectionCode: "SPREAD_TOO_WIDE", reasons: [`spread ${d.contract.spreadPct}% > ${maxSpread}%`], timingClass, actionableReason: "", invalidation, entryQuality: eq, metrics };
  }
  if (d.contract.quoteAgeMs == null || !Number.isFinite(d.contract.quoteAgeMs) || d.contract.quoteAgeMs < 0) {
    return { allowed: false, rejectionCode: "QUOTE_STALE", reasons: ["quote freshness unavailable or invalid"], timingClass, actionableReason: "", invalidation, entryQuality: eq, metrics };
  }
  if (d.contract.quoteAgeMs != null && d.contract.quoteAgeMs > maxAge) {
    return { allowed: false, rejectionCode: "QUOTE_STALE", reasons: [`quote age ${d.contract.quoteAgeMs}ms > ${maxAge}ms`], timingClass, actionableReason: "", invalidation, entryQuality: eq, metrics };
  }

  if (enforce && eq.composite.subscriberAction === "BLOCK") {
    const code = mapVerdictToDeliveryRejection(eq.composite.primaryVerdict)
      ?? (eq.composite.primaryVerdict === "LATE" ? "LATE_ENTRY" : "LATE_ENTRY");
    return {
      allowed: false,
      rejectionCode: code,
      reasons: eq.composite.reasons.length ? eq.composite.reasons : [code],
      timingClass: timingClass === "EARLY" ? "TIMELY" : timingClass,
      actionableReason: "",
      invalidation,
      entryQuality: eq,
      metrics,
    };
  }

  if (timingClass === "LATE") {
    return {
      allowed: false,
      rejectionCode: mapVerdictToDeliveryRejection(String(eq.metrics.earliness ?? "LATE")) ?? "LATE_ENTRY",
      reasons: eq.dimensions.entryEarliness.reasons.length ? eq.dimensions.entryEarliness.reasons : ["late at final delivery gate"],
      timingClass: "LATE",
      actionableReason: "",
      invalidation,
      entryQuality: eq,
      metrics,
    };
  }

  const bullish = side === "call";
  const favMovePct = d.observedUnderlyingPrice > 0
    ? ((d.currentUnderlyingPrice - d.observedUnderlyingPrice) / d.observedUnderlyingPrice) * 100 * (bullish ? 1 : -1)
    : 0;
  if (favMovePct > d.chaseLimitPct) {
    return {
      allowed: false,
      rejectionCode: "CHASED_OPTION_PREMIUM",
      reasons: [`underlying chase ${favMovePct.toFixed(2)}% > limit ${d.chaseLimitPct.toFixed(2)}%`],
      timingClass: "LATE",
      actionableReason: "",
      invalidation,
      entryQuality: eq,
      metrics,
    };
  }

  const maxOptionPremiumExpansion = num(env, "ENTRY_MAX_OPTION_PREMIUM_EXPANSION_PCT", 20);
  if (oPre != null && oPre > maxOptionPremiumExpansion) {
    return {
      allowed: false,
      rejectionCode: "CHASED_OPTION_PREMIUM",
      reasons: [`option premium expanded ${oPre.toFixed(2)}% > ${maxOptionPremiumExpansion}% since detection`],
      timingClass: "LATE",
      actionableReason: "",
      invalidation,
      entryQuality: eq,
      metrics,
    };
  }

  return {
    allowed: true,
    rejectionCode: null,
    reasons: eq.composite.reasons.length ? eq.composite.reasons : ["final delivery gate passed"],
    timingClass,
    actionableReason,
    invalidation,
    entryQuality: eq,
    metrics,
  };
}

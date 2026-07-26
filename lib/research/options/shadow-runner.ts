/**
 * options/shadow-runner.ts — shadow-mode gate evaluation (never sends Discord).
 */
import { evaluateEntryQuality, entryQualityFromDelivery, type EntryQualityResult } from "../../entry-quality-gate.ts";
import { evaluateMarketSessionGuard, isSameTradingSession } from "../../market-session-guard.ts";
import { tradingDay } from "../../trading-session.ts";
import type { DeliveryInput } from "./delivery.ts";
import { upsertShadowOutcomeFromDecision } from "./shadow-outcomes.ts";

export interface ShadowDecisionInput {
  path: "supervisor" | "independent" | "proposed";
  symbol: string;
  strategy: string;
  side: string;
  deliveryInput?: DeliveryInput | null;
  supervisorWouldSend?: boolean;
  independentWouldSend?: boolean;
  featureSnapshot?: Record<string, unknown> | null;
  firstDetectedAtMs?: number | null;
  underlyingAtFirstDetection?: number | null;
  optionAtFirstDetection?: number | null;
  nowMs?: number;
  candidateId?: number | null;
  actuallyDelivered?: boolean;
}

export interface ShadowDecisionResult {
  wouldSend: boolean;
  wouldAllowSession: boolean;
  actualAction: "OBSERVE_ONLY" | "WOULD_SEND" | "WOULD_BLOCK";
  entryQuality: EntryQualityResult | null;
  sessionState: string;
  reasons: string[];
  blockReasons: string[];
}

type ShadowDb = {
  prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown; all?: (...a: unknown[]) => unknown[]; lastInsertRowid?: number | bigint };
};

function fingerprint(input: ShadowDecisionInput): string {
  const d = input.deliveryInput;
  return [input.symbol, input.strategy, input.side, d?.contract.optionSymbol ?? "", Math.floor((input.nowMs ?? Date.now()) / 60_000)].join("|");
}

export function shadowModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUBSCRIBER_SHADOW_MODE === "1"
    || env.ENTRY_QUALITY_GATE === "shadow"
    || env.MARKET_SESSION_GUARD === "shadow"
    || env.OPTIONS_CALLOUTS_KILL === "1";
}

function actualAction(wouldSend: boolean, env: NodeJS.ProcessEnv): ShadowDecisionResult["actualAction"] {
  if (env.OPTIONS_CALLOUTS_KILL === "1") return "OBSERVE_ONLY";
  const sessionMode = String(env.MARKET_SESSION_GUARD ?? "shadow").toLowerCase();
  const eqMode = String(env.ENTRY_QUALITY_GATE ?? "shadow").toLowerCase();
  if (sessionMode === "shadow" || sessionMode === "0" || eqMode === "shadow" || eqMode === "0") {
    return "OBSERVE_ONLY";
  }
  return wouldSend ? "WOULD_SEND" : "WOULD_BLOCK";
}

export function evaluateShadowDecision(input: ShadowDecisionInput, env: NodeJS.ProcessEnv = process.env): ShadowDecisionResult {
  const nowMs = input.nowMs ?? Date.now();
  const guard = evaluateMarketSessionGuard(nowMs, env);
  const wouldAllowSession = guard.subscriberDeliveryAllowed;
  const reasons: string[] = [];
  const blockReasons: string[] = [];
  let entryQuality: EntryQualityResult | null = null;
  let wouldSend = false;

  if (input.path === "supervisor") {
    wouldSend = Boolean(input.supervisorWouldSend) && wouldAllowSession;
    if (input.supervisorWouldSend) reasons.push("supervisor path would emit");
    if (!wouldAllowSession) blockReasons.push(`session guard: ${guard.reason}`);
  } else if (input.path === "independent") {
    wouldSend = Boolean(input.independentWouldSend) && wouldAllowSession;
    if (input.independentWouldSend) reasons.push("independent path selected for delivery");
    if (!wouldAllowSession) blockReasons.push(`session guard: ${guard.reason}`);
  } else if (input.deliveryInput) {
    const candidateSession = input.deliveryInput.tradingSessionDate ?? tradingDay(input.deliveryInput.firstDetectedAtMs ?? nowMs);
    if (!isSameTradingSession(candidateSession, nowMs)) {
      blockReasons.push("EXPIRED_TRADING_SESSION");
      reasons.push(`candidate session ${candidateSession} != current ${tradingDay(nowMs)}`);
    } else if (!wouldAllowSession) {
      blockReasons.push(`session guard: ${guard.reason}`);
      reasons.push(`session guard: ${guard.state}`);
    } else {
      const optMid = input.deliveryInput.entry?.mid ?? ((input.deliveryInput.contract.bid ?? 0) + (input.deliveryInput.contract.ask ?? 0)) / 2;
      entryQuality = evaluateEntryQuality(
        entryQualityFromDelivery({
          side: input.deliveryInput.contract.side,
          dte: input.deliveryInput.contract.dte ?? null,
          underlyingNow: input.deliveryInput.currentUnderlyingPrice,
          optionNow: optMid,
          observedUnderlyingPrice: input.deliveryInput.observedUnderlyingPrice,
          contract: input.deliveryInput.contract,
          entry: input.deliveryInput.entry,
          firstDetectedAtMs: input.firstDetectedAtMs ?? input.deliveryInput.firstDetectedAtMs,
          underlyingAtFirstDetection: input.underlyingAtFirstDetection ?? input.deliveryInput.underlyingAtFirstDetection,
          optionAtFirstDetection: input.optionAtFirstDetection ?? input.deliveryInput.optionAtFirstDetection,
          featureSnapshot: input.featureSnapshot ?? input.deliveryInput.featureSnapshot,
          minutesToSessionClose: Math.round((guard.regularCloseMs - nowMs) / 60000),
          sessionState: guard.optionsSessionState,
          nowMs,
        }, nowMs, env),
        env,
      );
      if (entryQuality.composite.subscriberAction !== "SEND") {
        blockReasons.push(`entry_quality:${entryQuality.composite.primaryVerdict}`);
      }
      reasons.push(...entryQuality.composite.reasons);
    }
    wouldSend = blockReasons.length === 0 && entryQuality?.composite.subscriberAction === "SEND";
  }

  if (env.OPTIONS_CALLOUTS_KILL === "1") {
    blockReasons.push("kill_switch_engaged");
    wouldSend = false;
  }

  return {
    wouldSend,
    wouldAllowSession,
    actualAction: actualAction(wouldSend, env),
    entryQuality,
    sessionState: guard.state,
    reasons,
    blockReasons,
  };
}

export function persistShadowDecision(
  db: ShadowDb,
  input: ShadowDecisionInput,
  result: ShadowDecisionResult,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (!shadowModeEnabled(env)) return null;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_shadow_decisions'").get()) return null;
    const info = db.prepare(
      `INSERT INTO options_shadow_decisions (
        trading_session_date, symbol, strategy, side, path, would_send, entry_quality_verdict,
        session_guard_state, reasons_json, metrics_json, alert_fingerprint, created_at_ms,
        actual_action, would_allow_session, block_reasons_json, entry_quality_dimensions_json,
        candidate_id, actually_delivered
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      tradingDay(input.nowMs ?? Date.now()),
      input.symbol,
      input.strategy,
      input.side,
      input.path,
      result.wouldSend ? 1 : 0,
      result.entryQuality?.composite.primaryVerdict ?? result.entryQuality?.verdict ?? null,
      result.sessionState,
      JSON.stringify(result.reasons),
      JSON.stringify(result.entryQuality?.metrics ?? {}),
      fingerprint(input),
      input.nowMs ?? Date.now(),
      result.actualAction,
      result.wouldAllowSession ? 1 : 0,
      JSON.stringify(result.blockReasons),
      result.entryQuality ? JSON.stringify(result.entryQuality.dimensions) : null,
      input.candidateId ?? null,
      input.actuallyDelivered ? 1 : 0,
    ) as { lastInsertRowid?: number | bigint };
    const shadowDecisionId = Number(info.lastInsertRowid ?? 0) || null;
    if (shadowDecisionId && input.deliveryInput && (input.path === "proposed" || input.path === "independent")) {
      upsertShadowOutcomeFromDecision(db as any, shadowDecisionId, input, result, env);
    }
    return shadowDecisionId;
  } catch {
    return null;
  }
}

export function recordProposedShadowFromDelivery(
  db: ShadowDb,
  deliveryInput: DeliveryInput,
  extra: {
    firstDetectedAtMs?: number | null;
    underlyingAtFirstDetection?: number | null;
    optionAtFirstDetection?: number | null;
    featureSnapshot?: Record<string, unknown> | null;
    candidateId?: number | null;
    actuallyDelivered?: boolean;
  },
  env: NodeJS.ProcessEnv = process.env,
): ShadowDecisionResult {
  const input: ShadowDecisionInput = {
    path: "proposed",
    symbol: deliveryInput.candidateSymbol,
    strategy: deliveryInput.strategy,
    side: deliveryInput.contract.side,
    deliveryInput,
    ...extra,
    nowMs: deliveryInput.decisionMs ?? Date.now(),
  };
  const result = evaluateShadowDecision(input, env);
  persistShadowDecision(db, input, result, env);
  return result;
}

export function recordSupervisorShadowObservation(
  db: ShadowDb,
  input: Omit<ShadowDecisionInput, "path"> & { supervisorWouldSend: boolean },
  env: NodeJS.ProcessEnv = process.env,
): ShadowDecisionResult {
  const full: ShadowDecisionInput = { ...input, path: "supervisor" };
  const result = evaluateShadowDecision(full, env);
  persistShadowDecision(db, full, result, env);
  return result;
}

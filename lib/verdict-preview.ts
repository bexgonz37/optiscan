/**
 * verdict-preview.ts — read-only TRADE/WAIT/SKIP preview for scan/research UI.
 * Reuses the same scoring helpers as alert-capture without persisting alerts.
 */

import { optionsLiquidityScore, riskScore, setupScore, ivToPct } from "./alert-scoring.js";
import {
  moveStatus as calcMoveStatus,
  zeroDteContractScore,
  watchScores,
  optionStillWorthIt,
  tradeBias,
  riskFlags0dte,
  expectedRemainingMovePct,
} from "./zero-dte.js";
import {
  computeTradeVerdict,
  hasLiveSpeedProof,
  passesQualityGates,
  resolveAlertTier,
  type AlertVerdictInput,
  type LiveTapeContext,
  type TradeVerdict,
} from "./trade-verdict.ts";
import { minutesToClose } from "./trading-session.ts";
import type { MomentumRow } from "./types.ts";

export interface VerdictPreviewResult {
  verdict: TradeVerdict;
  entryPremium: number | null;
  contractLine: string | null;
  alertInput: AlertVerdictInput;
}

export function buildVerdictPreview(input: {
  symbol: string;
  momentum: MomentumRow | null;
  live?: LiveTapeContext | null;
  nowMs?: number;
  capture?: Partial<AlertVerdictInput> | null;
}): VerdictPreviewResult | null {
  const mom = input.momentum;
  if (!mom?.contract) return null;

  const nowMs = input.nowMs ?? Date.now();
  const live = input.live ?? null;
  const sideContract = mom.contract;
  const direction =
    mom.bias === "bearish" ? "bearish" : mom.bias === "bullish" ? "bullish" : "choppy";
  const dirUp = direction !== "bearish";
  const minsToClose = minutesToClose(nowMs);
  const shortRate = live?.shortRate ?? null;
  const surge = live?.surge ?? null;
  const efficiency = null;
  const aboveVwap =
    mom.priceVsVwapPct == null ? null : mom.priceVsVwapPct >= 0;
  const hodBreak = false;
  const lodBreak = false;

  const expRemainPct = expectedRemainingMovePct({ shortRate: shortRate ?? 0, minsToClose });
  const status = calcMoveStatus({
    movePct: mom.movePct,
    shortRate,
    accel: null,
    direction: dirUp ? "bullish" : "bearish",
    aboveVwap,
    hodBreak,
    lodBreak,
    surge,
    efficiency,
  });

  const contractRes = zeroDteContractScore(sideContract, { minsToClose, expRemainPct });
  const risk = riskScore({
    spreadPct: sideContract.spreadPct,
    optionVolume: sideContract.volume,
    openInterest: sideContract.openInterest,
    efficiency,
    moveStatus: status,
    iv: sideContract.iv,
    minsToClose,
    shareVolume: null,
  });

  const setup = setupScore({
    momentum01: Math.min(100, mom.momentumScore ?? 50) / 100,
    relVol: mom.relVol,
    surge,
    vwapAligned: aboveVwap == null ? false : dirUp ? aboveVwap : !aboveVwap,
    levelBreak: dirUp ? hodBreak : lodBreak,
    optionVolume: sideContract.volume,
    openInterest: sideContract.openInterest,
    spreadPct: sideContract.spreadPct,
    zeroDteScore: contractRes.score,
    moveStatus: status,
    riskScore: risk.score,
  });

  const watch = watchScores({
    shortRate,
    accel: null,
    aboveVwap,
    hodBreak,
    lodBreak,
    surge,
    relVol: mom.relVol,
    efficiency,
    callContract: dirUp ? sideContract : null,
    putContract: dirUp ? null : sideContract,
    minsToClose,
    expRemainPct,
  });

  const worth = optionStillWorthIt({
    status,
    contractScore: contractRes.score,
    minsToClose,
    spreadPct: sideContract.spreadPct,
    efficiency,
  });

  const bias = tradeBias({
    direction,
    status,
    callWatch: watch.callWatch,
    putWatch: watch.putWatch,
    contractScore: contractRes.score,
    worthItScore: worth.score,
  });

  const flags = riskFlags0dte({
    flags: contractRes.flags,
    status,
    efficiency,
    minsToClose,
    hodBreak,
    lodBreak,
    surge,
    direction,
  });

  const liquidityScore = optionsLiquidityScore(sideContract).score;
  const alertInput: AlertVerdictInput = {
    ticker: input.symbol,
    direction,
    trade_bias: bias,
    signal_score: setup.score,
    risk_score: risk.score,
    option_worth_score: worth.score,
    worth_verdict: worth.verdict,
    zero_dte_contract_score: contractRes.score,
    options_liquidity_score: liquidityScore,
    move_status: status,
    risk_flags: JSON.stringify(flags),
    option_side: sideContract.side ?? null,
    strike: sideContract.strike ?? null,
    expiration: sideContract.expiration ?? null,
    dte: sideContract.dte ?? null,
    percent_move_at_alert: mom.movePct,
    relative_volume: mom.relVol,
    short_rate_at_alert: shortRate,
    volume_surge_at_alert: surge,
    long_call_score: watch.callWatch,
    long_put_score: watch.putWatch,
    alert_tier: live?.shortRate != null ? "trade" : "research",
    asset_class: "options",
    ...(input.capture ?? {}),
  };
  if (input.capture?.alert_time) alertInput.alert_time = input.capture.alert_time;
  if (input.capture?.capture_action) alertInput.capture_action = input.capture.capture_action;

  const side = dirUp ? "CALL" : "PUT";
  const qualityGates = passesQualityGates(alertInput);
  const speedOk = hasLiveSpeedProof(alertInput, side, live ?? undefined);
  const tier = resolveAlertTier(computeTradeVerdict(alertInput, live ?? undefined), qualityGates, speedOk);
  alertInput.alert_tier = tier;

  const verdict = computeTradeVerdict(alertInput, live ?? undefined);
  const entryPremium = sideContract.mid ?? sideContract.entry ?? null;

  return {
    verdict,
    entryPremium,
    contractLine: verdict.contractLine,
    alertInput,
  };
}

/**
 * alert-capture.ts — turns scanner signals into persisted, fully-scored 0DTE
 * alerts. Two entry points:
 *
 *   captureZeroDte(...)  — from the every-second scanner loop (primary path):
 *                          full tape context (acceleration, surge, efficiency,
 *                          HOD/LOD) + ranked 0DTE contracts.
 *   captureAlerts(...)   — from the slower swing-radar scan (secondary): maps
 *                          candle-based signals into the same scoring.
 *
 * Spec rules enforced here:
 *   - CATALYSTS NEVER BLOCK: the alert inserts immediately; news is fetched
 *     fire-and-forget afterwards and attached via updateAlertCatalyst.
 *   - Big moves are analyzed for continuation, never auto-skipped.
 *   - Everything is deterministic — no AI in the alert path.
 */

import { fetchNews } from "@/lib/polygon-provider";
import { classifyCatalyst } from "@/lib/catalysts";
import { optionsLiquidityScore, riskScore, setupScore, ivToPct } from "@/lib/alert-scoring";
import {
  moveStatus as calcMoveStatus,
  MOVE_STATUS_LABEL,
  zeroDteContractScore,
  watchScores,
  optionStillWorthIt,
  tradeBias,
  TRADE_BIAS_LABEL,
  riskFlags0dte,
  expectedRemainingMovePct,
  level,
} from "@/lib/zero-dte";
import { privateLabel0dte, publicLabel0dte, riskLabel } from "@/lib/language-modes";
import { optionsPressure } from "@/lib/options-pressure";
import { buildExplanation } from "@/lib/explain";
import { cached } from "@/lib/scan-cache";
import { computeTradeVerdict, hasLiveSpeedProof, isClearTradeSignal, passesQualityGates, resolveAlertTier } from "@/lib/trade-verdict";
import { alertExists, insertAlert, getSettingNum, updateAlertCatalyst, insertNotificationEvent } from "@/lib/alert-store";
import { tradingDay, minutesToClose } from "@/lib/db";
import { isOptionsSession } from "@/lib/trading-session";
import { notifyNewAlert } from "@/lib/notifications";
import type { MomentumRow, UnusualRow } from "@/lib/types";

const NEWS_TTL_MS = 15 * 60 * 1000;

/** Fire-and-forget catalyst attach — context only, never blocks the alert. */
function attachCatalystLater(alertId: number, ticker: string, relVol: number | null) {
  void (async () => {
    try {
      const news: any = await cached(`news:${ticker}`, NEWS_TTL_MS, () => fetchNews(ticker, { limit: 10, days: 3 }));
      const items = news?.available ? news.items : [];
      const cat = classifyCatalyst(items, { relVol: relVol ?? 0 });
      updateAlertCatalyst(alertId, cat, ticker);
    } catch (err: any) {
      console.warn(`[alert-lab] catalyst attach skipped for ${ticker}:`, err?.message);
    }
  })();
}

export interface ZeroDteSignal {
  ticker: string;
  price: number | null;
  movePct: number;
  shortRate: number | null;
  accel: number | null;
  surge: number | null;
  relVol: number | null;
  efficiency: number | null;
  vwap: number | null;
  aboveVwap: boolean | null;
  hodBreak: boolean;
  lodBreak: boolean;
  direction: "bullish" | "bearish" | "choppy";
  directionConfidence: number; // 0-100
  shareVolume: number | null;
  bestCall: any | null; // ranked 0DTE contracts (normalized shape)
  bestPut: any | null;
  scannerScore?: number | null;
  source?: "momentum" | "unusual";
  alertType?: string;
  nowMs?: number;
  /** full 0DTE chain at trigger (optional) — used for pressure confirmation */
  chainContracts?: any[] | null;
}

/** Score + persist one 0DTE signal. Returns alert id or null (dup/below bar). */
export async function captureZeroDte(sig: ZeroDteSignal): Promise<number | null> {
  const nowMs = sig.nowMs ?? Date.now();
  // 0DTE options callouts are an RTH product: outside 9:30-16:00 ET there is
  // no same-day liquidity and spreads are junk. Extended hours belong to the
  // stock capture path (lib/stock-capture.ts); this guard covers every caller
  // (1s loop, swing radar, manual) so options can never fire premarket/AH.
  if (!isOptionsSession(nowMs)) return null;
  const day = tradingDay(nowMs);
  const minsToClose = minutesToClose(nowMs);
  const dirUp = sig.direction !== "bearish";
  const sideContract = sig.direction === "bearish" ? sig.bestPut : sig.bestCall;

  const source = sig.source ?? "momentum";
  const dedupKey = sideContract?.optionSymbol ?? null;
  if (alertExists(sig.ticker, source, dedupKey, day)) return null;

  const expRemainPct = expectedRemainingMovePct({ shortRate: sig.shortRate ?? 0, minsToClose });
  const status = calcMoveStatus({
    movePct: sig.movePct, shortRate: sig.shortRate, accel: sig.accel,
    direction: dirUp ? "bullish" : "bearish", aboveVwap: sig.aboveVwap,
    hodBreak: sig.hodBreak, lodBreak: sig.lodBreak, surge: sig.surge, efficiency: sig.efficiency,
  });

  const contractRes = sideContract
    ? zeroDteContractScore(sideContract, { minsToClose, expRemainPct })
    : { score: 0, reasons: ["No qualifying 0DTE contract"], flags: { spreadTooWide: true, lowLiquidity: true, premiumTooExpensive: false, ivTooHot: false, thetaRiskHigh: minsToClose < 120 } };

  const risk = riskScore({
    spreadPct: sideContract?.spreadPct, optionVolume: sideContract?.volume, openInterest: sideContract?.openInterest,
    efficiency: sig.efficiency, moveStatus: status, iv: sideContract?.iv,
    minsToClose, shareVolume: sig.shareVolume,
  });

  const setup = setupScore({
    momentum01: sig.directionConfidence / 100,
    relVol: sig.relVol, surge: sig.surge,
    vwapAligned: sig.aboveVwap == null ? false : dirUp ? sig.aboveVwap : !sig.aboveVwap,
    levelBreak: dirUp ? sig.hodBreak : sig.lodBreak,
    optionVolume: sideContract?.volume, openInterest: sideContract?.openInterest,
    spreadPct: sideContract?.spreadPct, zeroDteScore: contractRes.score,
    moveStatus: status, riskScore: risk.score,
  });

  const minScore = getSettingNum("alert_min_momentum_score", Number(process.env.ALERT_MIN_MOMENTUM_SCORE ?? 58));
  if (setup.score < minScore) return null;

  const minEfficiency = getSettingNum("scanner_min_efficiency", Number(process.env.SCANNER_MIN_EFFICIENCY ?? 0.28));
  if (sig.efficiency != null && sig.efficiency < minEfficiency) return null;

  const watch = watchScores({
    shortRate: sig.shortRate, accel: sig.accel, aboveVwap: sig.aboveVwap,
    hodBreak: sig.hodBreak, lodBreak: sig.lodBreak, surge: sig.surge, relVol: sig.relVol,
    efficiency: sig.efficiency, callContract: sig.bestCall, putContract: sig.bestPut,
    minsToClose, expRemainPct,
  });
  const worth = optionStillWorthIt({
    status, contractScore: contractRes.score, minsToClose,
    spreadPct: sideContract?.spreadPct, efficiency: sig.efficiency,
  });
  const bias = tradeBias({
    direction: sig.direction, status, callWatch: watch.callWatch, putWatch: watch.putWatch,
    contractScore: contractRes.score, worthItScore: worth.score,
  });
  const flags = riskFlags0dte({
    flags: contractRes.flags, status, efficiency: sig.efficiency, minsToClose,
    hodBreak: sig.hodBreak, lodBreak: sig.lodBreak, surge: sig.surge, direction: sig.direction,
  });

  if (flags.includes("Fake Breakout Risk")) return null;
  if (status === "exhausted" || (status as string) === "extended_risky") return null;

  const liquidityScore = optionsLiquidityScore(sideContract ?? {}).score;
  const liveCtx = { shortRate: sig.shortRate, surge: sig.surge, direction: sig.direction };
  const side = dirUp ? "CALL" : "PUT";
  const verdictInput = {
    ticker: sig.ticker, direction: sig.direction, trade_bias: bias,
    signal_score: setup.score, risk_score: risk.score,
    option_worth_score: worth.score, worth_verdict: worth.verdict,
    zero_dte_contract_score: contractRes.score,
    options_liquidity_score: liquidityScore,
    move_status: status, risk_flags: JSON.stringify(flags),
    option_side: sideContract?.side ?? null, strike: sideContract?.strike ?? null,
    dte: sideContract?.dte ?? null,
    percent_move_at_alert: sig.movePct, relative_volume: sig.relVol,
    short_rate_at_alert: sig.shortRate, volume_surge_at_alert: sig.surge,
    long_call_score: watch.callWatch, long_put_score: watch.putWatch,
  };

  const captureVerdict = computeTradeVerdict(verdictInput, liveCtx);
  const qualityGates = passesQualityGates(verdictInput);
  const speedOk = hasLiveSpeedProof(verdictInput, side, liveCtx);
  const tier = resolveAlertTier(captureVerdict, qualityGates, speedOk);

  const pressure = sig.chainContracts?.length
    ? optionsPressure(sig.chainContracts, { direction: sig.direction ?? undefined })
    : null;
  const continuationScore = worth.score;
  const exhaustionScore = 100 - ({ early: 85, continuing: 80, extended_tradable: 55, extended_risky: 30, exhausted: 5 }[status] ?? 50);

  const explainInput = {
    ticker: sig.ticker, direction: sig.direction, movePct: sig.movePct, shortRate: sig.shortRate,
    relVol: sig.relVol, surge: sig.surge, vwapAligned: sig.aboveVwap == null ? null : dirUp ? sig.aboveVwap : !sig.aboveVwap,
    levelBreak: dirUp ? sig.hodBreak : sig.lodBreak, efficiency: sig.efficiency,
    moveStatus: status, worthItVerdict: worth.verdict, zeroDteScore: contractRes.score,
    liquidityScore,
    riskScore: risk.score, setupScore: setup.score,
    spreadPct: sideContract?.spreadPct, ivPct: ivToPct(sideContract?.iv), minsToClose,
    riskFlags: flags,
  };
  const priv = buildExplanation(explainInput, "private");
  const pub = buildExplanation(explainInput, "public");

  const id = insertAlert({
    ticker: sig.ticker, source, alertType: sig.alertType ?? "0dte_momentum",
    direction: sig.direction,
    optionSymbol: sideContract?.optionSymbol ?? null, optionSide: sideContract?.side ?? null,
    strike: sideContract?.strike ?? null, expiration: sideContract?.expiration ?? null, dte: sideContract?.dte ?? null,
    alertTime: new Date(nowMs).toISOString(), tradingDay: day,
    priceAtAlert: sig.price, percentMoveAtAlert: sig.movePct,
    volume: sig.shareVolume, relativeVolume: sig.relVol,
    catalystType: null, catalystQuality: null, catalystSummary: null, catalystSource: "pending",
    signalScore: setup.score, riskScore: risk.score,
    optionsLiquidityScore: explainInput.liquidityScore,
    scannerScore: sig.scannerScore ?? null,
    scoreBreakdownJson: JSON.stringify({ ...setup.breakdown, reasons: setup.reasons, riskReasons: risk.reasons, contractReasons: contractRes.reasons }),
    aiExplanation: priv.text, publicExplanation: pub.text,
    privateLabel: privateLabel0dte({ bias, setupScore: setup.score, direction: sig.direction, riskFlags: flags } as any),
    publicLabel: publicLabel0dte({ direction: sig.direction, setupScore: setup.score }),
    tradeBias: bias, moveStatus: status,
    optionWorthScore: worth.score, worthVerdict: worth.verdict,
    chaseRisk: status === "extended_risky" ? "High" : status === "extended_tradable" ? "Medium" : "Low",
    ivRisk: level(ivToPct(sideContract?.iv), 150, 250),
    spreadRisk: level(sideContract?.spreadPct, 6, 10),
    continuationScore, exhaustionScore,
    longCallScore: watch.callWatch, longPutScore: watch.putWatch,
    zeroDteContractScore: contractRes.score,
    riskFlags: flags,
    shortRateAtAlert: sig.shortRate,
    volumeSurgeAtAlert: sig.surge,
    alertTier: tier,
    captureAction: captureVerdict.action,
    captureConfidence: captureVerdict.confidence,
    assetClass: "options", session: "regular",
    optionsPressureLabel: pressure?.label ?? null,
    optionsPressureJson: pressure ? JSON.stringify(pressure) : null,
    snapshot: sideContract ? {
      optionSymbol: sideContract.optionSymbol ?? null, bid: sideContract.bid ?? null, ask: sideContract.ask ?? null,
      mid: sideContract.mid ?? null, spreadPct: sideContract.spreadPct ?? null,
      volume: sideContract.volume ?? null, openInterest: sideContract.openInterest ?? null,
      iv: sideContract.iv ?? null, delta: sideContract.delta ?? null,
    } : null,
    catalystRecords: [],
  });

  if (id != null) {
    attachCatalystLater(id, sig.ticker, sig.relVol);
    const verdictInputWithTier = { ...verdictInput, alert_tier: tier };
    if (isClearTradeSignal(verdictInputWithTier, liveCtx)) {
      void notifyNewAlert(id, {
        assetClass: "options",
        ticker: sig.ticker,
        direction: sig.direction,
        setupScore: setup.score,
        riskScore: risk.score,
        liquidityScore: explainInput.liquidityScore,
        publicExplanation: pub.text,
        tradeBias: bias,
        moveStatus: status,
        optionWorthScore: worth.score,
        worthVerdict: worth.verdict,
        zeroDteContractScore: contractRes.score,
        riskFlags: JSON.stringify(flags),
        optionSide: sideContract?.side ?? null,
        strike: sideContract?.strike ?? null,
        expiration: sideContract?.expiration ?? null,
        dte: sideContract?.dte ?? null,
        movePct: sig.movePct,
        longCallScore: watch.callWatch,
        longPutScore: watch.putWatch,
        shortRate: sig.shortRate,
        volumeSurge: sig.surge,
      });
    } else {
      try {
        insertNotificationEvent({
          alertId: id, channel: "discord_webhook", status: "skipped",
          error: captureVerdict.action === "TRADE"
            ? "TRADE but not clear enough for Discord (need ≥82% confidence, ≥0.2%/min aligned speed)"
            : `verdict ${captureVerdict.action} (${tier} tier) — only clear TRADE notifies`,
        });
      } catch { /* bookkeeping never breaks capture */ }
    }
  }
  return id;
}

/** Secondary path: map the slower swing-radar rows into the same 0DTE scoring. */
export async function captureAlerts(input: {
  momentum: MomentumRow[];
  unusual: UnusualRow[];
  quotes?: Map<string, any>;
  nowMs?: number;
}): Promise<{ inserted: number; skipped: number }> {
  if (process.env.ALERT_LAB_ENABLED === "0") return { inserted: 0, skipped: 0 };
  const nowMs = input.nowMs ?? Date.now();
  if (!isOptionsSession(nowMs)) return { inserted: 0, skipped: 0 };
  const minUnusual = getSettingNum("alert_min_unusual_score", Number(process.env.ALERT_MIN_UNUSUAL_SCORE ?? 80));
  let inserted = 0;
  let skipped = 0;

  for (const r of input.momentum) {
    if (!r.symbol || !r.contract) continue;
    const quote = input.quotes?.get(r.symbol);
    const dirUp = r.bias !== "bearish";
    const id = await captureZeroDte({
      ticker: r.symbol, price: r.underlyingPrice, movePct: r.movePct,
      shortRate: null, accel: null, surge: null, relVol: r.relVol,
      efficiency: null, vwap: null,
      aboveVwap: r.priceVsVwapPct == null ? null : r.priceVsVwapPct >= 0,
      hodBreak: quote?.dayHigh != null && r.underlyingPrice != null ? r.underlyingPrice >= quote.dayHigh * 0.999 : false,
      lodBreak: quote?.dayLow != null && r.underlyingPrice != null ? r.underlyingPrice <= quote.dayLow * 1.001 : false,
      direction: r.bias === "bearish" ? "bearish" : r.bias === "bullish" ? "bullish" : "choppy",
      directionConfidence: Math.min(100, (r.momentumScore ?? 50)),
      shareVolume: quote?.volume ?? null,
      bestCall: dirUp ? r.contract : null,
      bestPut: dirUp ? null : r.contract,
      scannerScore: r.score, source: "momentum", alertType: "intraday_momentum", nowMs,
    });
    if (id != null) inserted++; else skipped++;
  }

  for (const u of input.unusual) {
    if (!u.symbol || u.score < minUnusual) continue;
    const quote = input.quotes?.get(u.symbol);
    const momPeer = input.momentum.find((m) => m.symbol === u.symbol);
    const dirUp = u.side === "call";
    const id = await captureZeroDte({
      ticker: u.symbol, price: u.underlyingPrice ?? quote?.price ?? null,
      movePct: quote?.changePercent ?? momPeer?.movePct ?? 0,
      shortRate: null, accel: null, surge: null, relVol: momPeer?.relVol ?? null,
      efficiency: null, vwap: null, aboveVwap: null,
      hodBreak: false, lodBreak: false,
      direction: dirUp ? "bullish" : u.side === "put" ? "bearish" : "choppy",
      directionConfidence: Math.min(100, u.score),
      shareVolume: quote?.volume ?? null,
      bestCall: dirUp ? u : null, bestPut: dirUp ? null : (u.side === "put" ? u : null),
      scannerScore: u.score, source: "unusual", alertType: "options_volume_spike", nowMs,
    });
    if (id != null) inserted++; else skipped++;
  }

  return { inserted, skipped };
}

export { MOVE_STATUS_LABEL, TRADE_BIAS_LABEL };

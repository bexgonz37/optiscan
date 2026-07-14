/**
 * stock-capture.ts — persists regular-stock callouts (premarket / after-hours).
 *
 * The session router in scanner-loop sends triggers here instead of the 0DTE
 * options path when isStockSession(). Rules:
 *   - NEVER fetches an option chain — underlying tape only.
 *   - CATALYSTS NEVER BLOCK: alert inserts immediately, news attaches after.
 *   - Deterministic scoring (lib/stock-signals.ts) — no AI in the signal path.
 *   - Only clear BUY LONG/SHORT callouts notify Discord (stock wording, no
 *     contract line); everything else is history for the accuracy lab.
 */

import { fetchNews } from "@/lib/polygon-provider";
import { classifyCatalyst } from "@/lib/catalysts";
import { cached } from "@/lib/scan-cache";
import { computeStockVerdict, STOCK_CLEAR_MIN_CONFIDENCE, STOCK_DEFAULT_MIN_SCORE } from "@/lib/stock-signals";
import { marketSession } from "@/lib/trading-session";
import { getSettingNum, insertAlert, insertNotificationEvent, updateAlertCatalyst } from "@/lib/alert-store";
import { tradingDay } from "@/lib/db";
import { notifyNewAlert } from "@/lib/notifications";
import { normalizeProviderTimestampMs } from "@/lib/data-freshness";
import { classifyMoveTiming } from "@/lib/move-timing";

const NEWS_TTL_MS = 15 * 60 * 1000;

function attachCatalystLater(alertId: number, ticker: string, relVol: number | null) {
  void (async () => {
    try {
      const news: any = await cached(`news:${ticker}`, NEWS_TTL_MS, () => fetchNews(ticker, { limit: 10, days: 3 }));
      const items = news?.available ? news.items : [];
      const cat = classifyCatalyst(items, { relVol: relVol ?? 0 });
      updateAlertCatalyst(alertId, cat, ticker);
    } catch (err: any) {
      console.warn(`[stock-lab] catalyst attach skipped for ${ticker}:`, err?.message);
    }
  })();
}

export interface StockSignal {
  ticker: string;
  price: number | null;
  movePct: number;
  shortRate: number | null;
  instantRate?: number | null;
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
  /** Verified NBBO for the compact card + now-only stock Discord gate. */
  bid?: number | null;
  ask?: number | null;
  quoteProviderTimestamp?: number | string | bigint | Date | null;
  nowMs?: number;
  signalDetectedAtMs?: number | null;
  lastConfirmedAtMs?: number | null;
  moveBeganAtMs?: number | null;
  dataTimestampMs?: number | string | bigint | Date | null;
  lastTriggerEventAtMs?: number | null;
}

function isoOrNull(ms?: number | null): string | null {
  return ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Score + persist one stock callout. Returns alert id or null (dup/below bar). */
export async function captureStockAlert(sig: StockSignal): Promise<number | null> {
  const nowMs = sig.nowMs ?? Date.now();
  const session = marketSession(nowMs);
  const stockEnabled = process.env.STOCK_CALLOUTS === "1";
  if (!stockEnabled) return null;
  if (session === "closed") return null;
  const vwapDistPct =
    typeof sig.price === "number" && typeof sig.vwap === "number" && sig.vwap > 0
      ? +(((sig.price - sig.vwap) / sig.vwap) * 100).toFixed(2)
      : null;

  const minScore = getSettingNum("stock_min_score", Number(process.env.STOCK_MIN_SCORE ?? STOCK_DEFAULT_MIN_SCORE));
  const dataTimestampMs = normalizeProviderTimestampMs(sig.dataTimestampMs ?? null, nowMs);
  const timing = classifyMoveTiming({
    direction: sig.direction,
    shortRate: sig.shortRate,
    instantRate: sig.instantRate,
    surge: sig.surge,
    relVol: sig.relVol,
    hodBreak: sig.hodBreak,
    lodBreak: sig.lodBreak,
    aboveVwap: sig.aboveVwap,
    movePct: sig.movePct,
    signalDetectedAtMs: sig.signalDetectedAtMs ?? sig.lastTriggerEventAtMs ?? nowMs,
    lastConfirmedAtMs: sig.lastConfirmedAtMs ?? sig.lastTriggerEventAtMs ?? nowMs,
    moveBeganAtMs: sig.moveBeganAtMs ?? sig.lastTriggerEventAtMs ?? nowMs,
    dataTimestampMs,
    nowMs,
  });
  const v = computeStockVerdict({
    direction: sig.direction, directionConfidence: sig.directionConfidence,
    shortRate: sig.shortRate, accel: sig.accel, surge: sig.surge, relVol: sig.relVol,
    efficiency: sig.efficiency, aboveVwap: sig.aboveVwap,
    hodBreak: sig.hodBreak, lodBreak: sig.lodBreak, movePct: sig.movePct,
  }, { minScore });

  // Persist BUYs and near-miss WAITs (accuracy lab needs both); drop SKIPs.
  if (v.action === "SKIP") return null;
  if (v.action === "WAIT" && v.score < minScore - 10) return null;
  const timingBlocksTrade = v.action === "BUY" && !timing.actionable;
  const captureAction = timingBlocksTrade ? "WAIT" : v.action === "BUY" ? "TRADE" : v.action;
  const alertTier = captureAction === "TRADE" ? "trade" : "research";
  const displayHeadline = timingBlocksTrade ? `${timing.statusLabel}: ${sig.ticker}` : v.headline;

  const dirWord = v.side === "SHORT" ? "downside" : "upside";
  const timingLine = `${timing.statusLabel}. ${timing.reasons[0] ?? "Live timing validated."}`;
  const explanation =
    `${sig.ticker} ${session} stock signal: ${displayHeadline}. ${timingLine} ${v.reason} ` +
    `Move ${sig.movePct > 0 ? "+" : ""}${sig.movePct?.toFixed(1)}% on the day, ` +
    `speed ${sig.shortRate != null ? `${sig.shortRate > 0 ? "+" : ""}${sig.shortRate.toFixed(2)}%/min` : "n/a"}, ` +
    `volume surge ${sig.surge != null ? `${sig.surge.toFixed(1)}x` : "n/a"}. ` +
    `Watching for ${dirWord} follow-through at 1m/5m. Research signal — not financial advice.`;

  const id = insertAlert({
    ticker: sig.ticker, source: "momentum", alertType: `${session}_stock_momentum`,
    direction: sig.direction,
    optionSymbol: null, optionSide: null, strike: null, expiration: null, dte: null,
    alertTime: new Date(nowMs).toISOString(), tradingDay: tradingDay(nowMs),
    priceAtAlert: sig.price, percentMoveAtAlert: sig.movePct,
    volume: sig.shareVolume, relativeVolume: sig.relVol,
    catalystType: null, catalystQuality: null, catalystSummary: null, catalystSource: "pending",
    signalScore: v.score, riskScore: null, optionsLiquidityScore: null, scannerScore: null,
    scoreBreakdownJson: JSON.stringify({
      reasons: v.reasons,
      verdict: captureAction,
      rawVerdict: v.action,
      side: v.side,
      confidence: v.confidence,
      timing,
    }),
    aiExplanation: explanation, publicExplanation: explanation,
    privateLabel: displayHeadline, publicLabel: `${session === "premarket" ? "Premarket" : session === "regular" ? "Regular-hours" : "After-hours"} momentum: ${sig.ticker}`,
    tradeBias: v.side === "LONG" ? "stock_long_candidate" : v.side === "SHORT" ? "stock_short_candidate" : null,
    moveStatus: timing.statusLabel,
    shortRateAtAlert: sig.shortRate, volumeSurgeAtAlert: sig.surge,
    alertTier,
    captureAction,
    captureConfidence: v.confidence,
    assetClass: "stock", session,
    moveClassification: timing.classification,
    signalDetectedAt: isoOrNull(sig.signalDetectedAtMs ?? sig.lastTriggerEventAtMs ?? nowMs),
    lastConfirmedAt: isoOrNull(sig.lastConfirmedAtMs ?? sig.lastTriggerEventAtMs ?? nowMs),
    moveBeganAt: isoOrNull(sig.moveBeganAtMs ?? sig.lastTriggerEventAtMs ?? nowMs),
    dataTimestamp: isoOrNull(dataTimestampMs),
    expiresAt: isoOrNull(nowMs + 5 * 60_000),
    lastValidatedAt: isoOrNull(nowMs),
    lastTriggerEventAt: isoOrNull(sig.lastTriggerEventAtMs ?? nowMs),
    invalidationReason: timing.actionable ? null : timing.reasons.join(" "),
    vwapAtAlert: sig.vwap ?? null,
    vwapDistPctAtAlert: vwapDistPct,
    aboveVwap: sig.aboveVwap,
    snapshot: null, catalystRecords: [],
  });

  if (id != null) {
    attachCatalystLater(id, sig.ticker, sig.relVol);
    const clear = captureAction === "TRADE" && v.confidence >= STOCK_CLEAR_MIN_CONFIDENCE;
    if (clear) {
      void notifyNewAlert(id, {
        assetClass: "stock", session,
        ticker: sig.ticker, direction: sig.direction,
        stockHeadline: v.headline,
        stockReason: `${timing.statusLabel}: ${v.reason}`,
        moveClassification: timing.classification,
        signalAgeSeconds: timing.signalAgeSeconds,
        moveAgeSeconds: timing.moveAgeSeconds,
        setupScore: v.score, confidence: v.confidence,
        movePct: sig.movePct, price: sig.price,
        // Session VWAP for the anti-chase / extension gate (verified, may be null).
        vwap: sig.vwap ?? null,
        shortRate: sig.shortRate, volumeSurge: sig.surge,
        // NBBO + freshness for the compact card and the now-only stock gate.
        bid: sig.bid ?? null, ask: sig.ask ?? null,
        quoteAsOfMs: normalizeProviderTimestampMs(sig.quoteProviderTimestamp ?? null, nowMs),
        actionableNow: captureAction === "TRADE",
        nowMs,
      });
    } else {
      try {
        insertNotificationEvent({
          alertId: id, channel: "discord_webhook", status: "skipped",
          error: timingBlocksTrade
            ? `stock timing blocked Discord: ${timing.statusLabel} - ${timing.reasons.join(" ")}`
            : v.action === "BUY"
            ? `BUY but confidence ${v.confidence}% < ${STOCK_CLEAR_MIN_CONFIDENCE}% — only clear stock BUYs notify`
            : `stock verdict ${v.action} — only clear BUY LONG/SHORT notifies`,
        });
      } catch { /* bookkeeping never breaks capture */ }
    }
  }
  return id;
}

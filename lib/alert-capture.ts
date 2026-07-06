/**
 * alert-capture.ts — turns qualifying scanner rows into persisted Alert Lab
 * rows. Called fire-and-forget after each fresh scan (see scan-core.ts) so it
 * never adds latency to, or breaks, the scanner itself.
 *
 * Capture thresholds: /settings overrides (scanner_settings table) win, then
 * env, then defaults:
 *   alert_min_momentum_score / ALERT_MIN_MOMENTUM_SCORE (default 65 — GOOD+)
 *   alert_min_unusual_score  / ALERT_MIN_UNUSUAL_SCORE  (default 80 — STRONG)
 *
 * For each new alert it computes and stores: options liquidity score, risk
 * score, setup score WITH full component breakdown (score_breakdown_json),
 * private + public labels, and deterministic private + public explanations.
 * Discord (if enabled) is notified via the notifications module.
 *
 * API cost note: each NEW alert ticker costs one Polygon news call for
 * catalyst classification, cached 15 minutes per ticker (dedup runs BEFORE the
 * news lookup, so re-scans of an already-captured alert cost nothing).
 */

import { fetchNews } from "@/lib/polygon-provider";
import { classifyCatalyst } from "@/lib/catalysts";
import { optionsLiquidityScore, riskScore, setupScore } from "@/lib/alert-scoring";
import { privateLabel, publicLabel, riskLabel } from "@/lib/language-modes";
import { buildExplanation } from "@/lib/explain";
import { cached } from "@/lib/scan-cache";
import { alertExists, insertAlert, getSettingNum } from "@/lib/alert-store";
import { tradingDay, minutesToClose } from "@/lib/db";
import { notifyNewAlert } from "@/lib/notifications";
import { ivToPct } from "@/lib/alert-scoring";
import type { MomentumRow, UnusualRow } from "@/lib/types";

const NEWS_TTL_MS = 15 * 60 * 1000;

function thresholds(env = process.env) {
  return {
    momentum: getSettingNum("alert_min_momentum_score", Number(env.ALERT_MIN_MOMENTUM_SCORE ?? 65)),
    unusual: getSettingNum("alert_min_unusual_score", Number(env.ALERT_MIN_UNUSUAL_SCORE ?? 80)),
    enabled: env.ALERT_LAB_ENABLED !== "0",
  };
}

async function catalystFor(ticker: string, relVol: number | null) {
  const news: any = await cached(`news:${ticker}`, NEWS_TTL_MS, () => fetchNews(ticker, { limit: 10, days: 3 }));
  // available:false (plan limits, 429, outage) -> classify with zero items but
  // an honest source label so we never fabricate a catalyst.
  const items = news?.available ? news.items : [];
  const cat = classifyCatalyst(items, { relVol: relVol ?? 0 });
  if (!news?.available) {
    return { ...cat, type: "no_clear_catalyst", quality: "unknown", summary: `News unavailable: ${news?.note ?? "unknown"}`, source: "unavailable", records: [] };
  }
  return cat;
}

interface BuildArgs {
  ticker: string;
  source: "momentum" | "unusual";
  alertType: string;
  direction: string;
  optionSide: string | null;
  contract: any | null;
  movePct: number;
  relVol: number | null;
  shareVolume: number | null;
  priceAtAlert: number | null;
  scannerScore: number;
  hasUnusualFlow: boolean;
  trendAligned: boolean;
  vwapAligned: boolean;
  nowMs: number;
}

/** Compute scores + labels + explanations and persist one alert. */
async function buildAndInsert(a: BuildArgs): Promise<number | null> {
  const cat = await catalystFor(a.ticker, a.relVol);
  const liq = optionsLiquidityScore(a.contract ?? {});
  const risk = riskScore({
    spreadPct: a.contract?.spreadPct, openInterest: a.contract?.openInterest,
    catalystType: cat.type, catalystQuality: cat.quality,
    movePct: a.movePct, shareVolume: a.shareVolume, iv: a.contract?.iv,
    minsToClose: minutesToClose(a.nowMs),
  });
  const setup = setupScore({
    relVol: a.relVol, movePct: a.movePct,
    catalystType: cat.type, catalystQuality: cat.quality,
    liquidityScore: liq.score, riskScore: risk.score,
    trendAligned: a.trendAligned, vwapAligned: a.vwapAligned,
  });

  const rl = riskLabel(risk.score);
  const explainInput = {
    ticker: a.ticker, direction: a.direction, movePct: a.movePct, relVol: a.relVol,
    catalystType: cat.type, catalystQuality: cat.quality, catalystSummary: cat.summary,
    liquidityScore: liq.score, riskScore: risk.score, setupScore: setup.score,
    spreadPct: a.contract?.spreadPct, openInterest: a.contract?.openInterest,
    ivPct: ivToPct(a.contract?.iv), hasUnusualFlow: a.hasUnusualFlow,
    trendAligned: a.trendAligned, optionSide: a.optionSide,
  };
  const priv = buildExplanation(explainInput, "private");
  const pub = buildExplanation(explainInput, "public");

  const alertTime = new Date(a.nowMs).toISOString();
  const id = insertAlert({
    ticker: a.ticker, source: a.source, alertType: a.alertType, direction: a.direction,
    optionSymbol: a.contract?.optionSymbol ?? null, optionSide: a.optionSide,
    strike: a.contract?.strike ?? null, expiration: a.contract?.expiration ?? null, dte: a.contract?.dte ?? null,
    alertTime, tradingDay: tradingDay(a.nowMs),
    priceAtAlert: a.priceAtAlert, percentMoveAtAlert: a.movePct,
    volume: a.shareVolume, relativeVolume: a.relVol,
    catalystType: cat.type, catalystQuality: cat.quality, catalystSummary: cat.summary, catalystSource: cat.source,
    signalScore: setup.score, riskScore: risk.score, optionsLiquidityScore: liq.score,
    scannerScore: a.scannerScore,
    scoreBreakdownJson: JSON.stringify({ ...setup.breakdown, reasons: setup.reasons, riskReasons: risk.reasons, liquidityReasons: liq.reasons }),
    aiExplanation: priv.text, publicExplanation: pub.text,
    privateLabel: privateLabel(setup.score, { riskLabel: rl }),
    publicLabel: publicLabel(setup.score, { riskLabel: rl }),
    snapshot: a.contract ? {
      optionSymbol: a.contract.optionSymbol ?? null, bid: a.contract.bid ?? null, ask: a.contract.ask ?? null,
      mid: a.contract.entry ?? a.contract.mid ?? null, spreadPct: a.contract.spreadPct ?? null,
      volume: a.contract.volume ?? null, openInterest: a.contract.openInterest ?? null,
      iv: a.contract.iv ?? null, delta: a.contract.delta ?? null,
    } : null,
    catalystRecords: cat.records,
  });

  if (id != null) {
    // Server-side channels (Discord). Browser popup/sound/desktop are handled
    // client-side by AlertPopup, which polls for new alert rows.
    void notifyNewAlert(id, {
      ticker: a.ticker, setupScore: setup.score, riskScore: risk.score,
      liquidityScore: liq.score, publicExplanation: pub.text,
    });
  }
  return id;
}

export async function captureAlerts(input: {
  momentum: MomentumRow[];
  unusual: UnusualRow[];
  quotes?: Map<string, any>;
  nowMs?: number;
}): Promise<{ inserted: number; skipped: number }> {
  const cfg = thresholds();
  if (!cfg.enabled) return { inserted: 0, skipped: 0 };
  const nowMs = input.nowMs ?? Date.now();
  const day = tradingDay(nowMs);
  const unusualTickers = new Set(input.unusual.map((u) => u.symbol));
  let inserted = 0;
  let skipped = 0;

  for (const r of input.momentum) {
    if (!r.symbol || !r.contract || r.score < cfg.momentum) continue;
    if (alertExists(r.symbol, "momentum", r.contract.optionSymbol, day)) { skipped++; continue; }
    const quote = input.quotes?.get(r.symbol);
    const id = await buildAndInsert({
      ticker: r.symbol, source: "momentum", alertType: "intraday_momentum",
      direction: r.bias ?? "neutral", optionSide: (r.contract.side as string) ?? r.side,
      contract: r.contract, movePct: r.movePct, relVol: r.relVol,
      shareVolume: quote?.volume ?? null, priceAtAlert: r.underlyingPrice,
      scannerScore: r.score, hasUnusualFlow: unusualTickers.has(r.symbol),
      trendAligned: r.trend === (r.bias === "bearish" ? "down" : "up"),
      vwapAligned: r.priceVsVwapPct != null && (r.bias === "bearish" ? r.priceVsVwapPct < 0 : r.priceVsVwapPct >= 0),
      nowMs,
    });
    if (id != null) inserted++; else skipped++;
  }

  for (const u of input.unusual) {
    if (!u.symbol || u.score < cfg.unusual) continue;
    if (alertExists(u.symbol, "unusual", u.optionSymbol, day)) { skipped++; continue; }
    const quote = input.quotes?.get(u.symbol);
    const momPeer = input.momentum.find((m) => m.symbol === u.symbol);
    const id = await buildAndInsert({
      ticker: u.symbol, source: "unusual", alertType: "options_volume_spike",
      direction: u.side === "call" ? "bullish" : u.side === "put" ? "bearish" : "neutral",
      optionSide: (u.side as string) ?? null,
      contract: u, movePct: quote?.changePercent ?? momPeer?.movePct ?? 0,
      relVol: momPeer?.relVol ?? null, shareVolume: quote?.volume ?? null,
      priceAtAlert: u.underlyingPrice ?? quote?.price ?? null,
      scannerScore: u.score, hasUnusualFlow: true,
      trendAligned: false, vwapAligned: false,
      nowMs,
    });
    if (id != null) inserted++; else skipped++;
  }

  return { inserted, skipped };
}

/**
 * alert-capture.ts — turns qualifying scanner rows into persisted Alert Lab
 * rows. Called fire-and-forget after each fresh scan (see scan-core.ts) so it
 * never adds latency to, or breaks, the scanner itself.
 *
 * Capture thresholds (env-tunable):
 *   ALERT_MIN_MOMENTUM_SCORE (default 65 — GOOD and up)
 *   ALERT_MIN_UNUSUAL_SCORE  (default 80 — STRONG only)
 *
 * API cost note: each NEW alert ticker costs one Polygon news call for
 * catalyst classification, cached 15 minutes per ticker (dedup runs BEFORE the
 * news lookup, so re-scans of an already-captured alert cost nothing).
 */

import { fetchNews } from "@/lib/polygon-provider";
import { classifyCatalyst } from "@/lib/catalysts";
import { optionsLiquidityScore, riskScore, signalQualityScore } from "@/lib/alert-scoring";
import { cached } from "@/lib/scan-cache";
import { alertExists, insertAlert } from "@/lib/alert-store";
import { tradingDay } from "@/lib/db";
import type { MomentumRow, UnusualRow } from "@/lib/types";

const NEWS_TTL_MS = 15 * 60 * 1000;

function thresholds(env = process.env) {
  return {
    momentum: Number(env.ALERT_MIN_MOMENTUM_SCORE ?? 65),
    unusual: Number(env.ALERT_MIN_UNUSUAL_SCORE ?? 80),
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

export async function captureAlerts(input: {
  momentum: MomentumRow[];
  unusual: UnusualRow[];
  quotes?: Map<string, any>;
  nowMs?: number;
}): Promise<{ inserted: number; skipped: number }> {
  const cfg = thresholds();
  if (!cfg.enabled) return { inserted: 0, skipped: 0 };
  const nowMs = input.nowMs ?? Date.now();
  const alertTime = new Date(nowMs).toISOString();
  const day = tradingDay(nowMs);
  const unusualTickers = new Set(input.unusual.map((u) => u.symbol));
  let inserted = 0;
  let skipped = 0;

  for (const r of input.momentum) {
    if (!r.symbol || !r.contract || r.score < cfg.momentum) continue;
    if (alertExists(r.symbol, "momentum", r.contract.optionSymbol, day)) { skipped++; continue; }

    const quote = input.quotes?.get(r.symbol);
    const cat = await catalystFor(r.symbol, r.relVol);
    const liq = optionsLiquidityScore(r.contract);
    const risk = riskScore({
      spreadPct: r.contract.spreadPct, openInterest: r.contract.openInterest,
      catalystType: cat.type, catalystQuality: cat.quality,
      movePct: r.movePct, shareVolume: quote?.volume ?? null, iv: r.contract.iv,
    });
    const quality = signalQualityScore({
      relVol: r.relVol, movePct: r.movePct, catalystType: cat.type, catalystQuality: cat.quality,
      liquidityScore: liq.score, hasUnusualFlow: unusualTickers.has(r.symbol),
    });

    const id = insertAlert({
      ticker: r.symbol, source: "momentum", direction: r.bias ?? null,
      optionSymbol: r.contract.optionSymbol, optionSide: (r.contract.side as string) ?? r.side,
      strike: r.contract.strike, expiration: r.contract.expiration, dte: r.contract.dte,
      alertTime, tradingDay: day,
      priceAtAlert: r.underlyingPrice, percentMoveAtAlert: r.movePct,
      volume: quote?.volume ?? null, relativeVolume: r.relVol,
      catalystType: cat.type, catalystQuality: cat.quality, catalystSummary: cat.summary, catalystSource: cat.source,
      signalScore: quality.score, riskScore: risk.score, optionsLiquidityScore: liq.score,
      scannerScore: r.score,
      snapshot: {
        optionSymbol: r.contract.optionSymbol, bid: r.contract.bid, ask: r.contract.ask,
        mid: r.contract.entry ?? r.contract.mid ?? null, spreadPct: r.contract.spreadPct,
        volume: r.contract.volume, openInterest: r.contract.openInterest,
        iv: r.contract.iv, delta: r.contract.delta,
      },
      catalystRecords: cat.records,
    });
    if (id != null) inserted++; else skipped++;
  }

  for (const u of input.unusual) {
    if (!u.symbol || u.score < cfg.unusual) continue;
    if (alertExists(u.symbol, "unusual", u.optionSymbol, day)) { skipped++; continue; }

    const quote = input.quotes?.get(u.symbol);
    const momPeer = input.momentum.find((m) => m.symbol === u.symbol);
    const relVol = momPeer?.relVol ?? null;
    const movePct = quote?.changePercent ?? momPeer?.movePct ?? 0;
    const cat = await catalystFor(u.symbol, relVol);
    const liq = optionsLiquidityScore({ spreadPct: u.spreadPct, volume: u.volume, openInterest: u.openInterest, dte: u.dte });
    const risk = riskScore({
      spreadPct: u.spreadPct, openInterest: u.openInterest,
      catalystType: cat.type, catalystQuality: cat.quality,
      movePct, shareVolume: quote?.volume ?? null, iv: u.iv,
    });
    const quality = signalQualityScore({
      relVol, movePct, catalystType: cat.type, catalystQuality: cat.quality,
      liquidityScore: liq.score, hasUnusualFlow: true,
    });

    const id = insertAlert({
      ticker: u.symbol, source: "unusual",
      direction: u.side === "call" ? "bullish" : u.side === "put" ? "bearish" : "neutral",
      optionSymbol: u.optionSymbol, optionSide: (u.side as string) ?? null,
      strike: u.strike, expiration: u.expiration, dte: u.dte,
      alertTime, tradingDay: day,
      priceAtAlert: u.underlyingPrice ?? quote?.price ?? null, percentMoveAtAlert: movePct,
      volume: quote?.volume ?? null, relativeVolume: relVol,
      catalystType: cat.type, catalystQuality: cat.quality, catalystSummary: cat.summary, catalystSource: cat.source,
      signalScore: quality.score, riskScore: risk.score, optionsLiquidityScore: liq.score,
      scannerScore: u.score,
      snapshot: {
        optionSymbol: u.optionSymbol, bid: u.bid, ask: u.ask, mid: u.mid, spreadPct: u.spreadPct,
        volume: u.volume, openInterest: u.openInterest, iv: u.iv, delta: u.delta,
      },
      catalystRecords: cat.records,
    });
    if (id != null) inserted++; else skipped++;
  }

  return { inserted, skipped };
}

/**
 * alert-tracker.ts — background checkpoint sweeper for Alert Lab.
 *
 * HOW SCHEDULING WORKS (and its tradeoffs):
 * OptiScan runs as a persistent Node process (`next dev` / `next start`), so a
 * plain in-process interval — started once from instrumentation.ts — sweeps
 * every 60s for due checkpoints (5m/15m/30m/1h after alert_time, plus EOD at
 * 16:00 ET). There is no external queue to operate.
 *
 * Reliability: checkpoint values are computed from Polygon MINUTE CANDLES, not
 * from "the price right now". If the app was closed at alert+15min, the next
 * sweep backfills the exact 15m/30m/1h/EOD values from history. The tradeoff:
 * while the process is down nothing records (fine — it catches up), and on a
 * serverless deploy there is no resident process at all — point a cron (e.g.
 * Vercel Cron) at GET /api/alerts/track instead, which runs the same sweep.
 *
 * API cost: one candles call per ticker per sweep, only when that ticker has
 * due checkpoints. Alerts older than ~2 days backfill with 5-min bars to stay
 * inside aggregate limits.
 */

import { fetchCandles } from "@/lib/polygon-provider";
import { isFalsePositive } from "@/lib/alert-scoring";
import { etCloseMs, tradingDay } from "@/lib/db";
import {
  trackingAlerts,
  existingCheckpoints,
  recordCheckpoint,
  finalizeAlert,
  recordAlertOutcomes,
  alertSpreadHistory,
} from "@/lib/alert-store";

const CHECKPOINTS: { key: string; mins: number | null }[] = [
  { key: "1m", mins: 1 },
  { key: "3m", mins: 3 },
  { key: "5m", mins: 5 },
  { key: "15m", mins: 15 },
  { key: "30m", mins: 30 },
  { key: "1h", mins: 60 },
  { key: "eod", mins: null }, // due at 16:00 ET of the alert's trading day
];

const FP_MIN_FAVORABLE_PCT = Number(process.env.ALERT_FP_MIN_FAVORABLE_PCT ?? 1.5);

interface Bar { t: number; c: number; h: number; l: number; v: number }

/** Favorable-signed % move: positive = moved WITH the alert's direction. */
function favorablePct(direction: string | null, alertPrice: number, price: number): number {
  const raw = ((price - alertPrice) / alertPrice) * 100;
  return direction === "bearish" ? -raw : raw;
}

/**
 * Compute one checkpoint from bars (pure — exported for tests).
 * Uses bars in [alertMs, cpMs]: close of the last bar at/before cpMs, the most
 * favorable extreme (bearish alerts count downside as favorable), and the
 * worst adverse excursion (drawdown, always <= 0).
 */
export function computeCheckpoint(
  bars: Bar[],
  opts: { alertMs: number; cpMs: number; alertPrice: number; direction: string | null },
) {
  const { alertMs, cpMs, alertPrice, direction } = opts;
  if (!Number.isFinite(alertPrice) || alertPrice <= 0) return null;
  const win = bars.filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c) && b.t >= alertMs && b.t <= cpMs);
  if (!win.length) return null;

  const last = win[win.length - 1];
  const bearish = direction === "bearish";
  let bestPrice = alertPrice;
  let bestFav = 0;
  let worstFav = 0;
  for (const b of win) {
    const hi = Number.isFinite(b.h) ? b.h : b.c;
    const lo = Number.isFinite(b.l) ? b.l : b.c;
    const favExtreme = bearish ? lo : hi; // favorable direction extreme
    const advExtreme = bearish ? hi : lo; // adverse direction extreme
    const fav = favorablePct(direction, alertPrice, favExtreme);
    const adv = favorablePct(direction, alertPrice, advExtreme);
    if (fav > bestFav) { bestFav = fav; bestPrice = favExtreme; }
    if (adv < worstFav) worstFav = adv;
  }

  return {
    priceAtCheckpoint: last.c,
    percentMoveFromAlert: +favorablePct(direction, alertPrice, last.c).toFixed(2),
    maxPriceAfterAlert: bestPrice,
    maxPercentMoveAfterAlert: +bestFav.toFixed(2),
    drawdownAfterAlert: +worstFav.toFixed(2),
  };
}

/** Which checkpoints are due for an alert at `nowMs` (excluding recorded). */
export function dueCheckpoints(alert: { alert_time: string; trading_day: string }, done: string[], nowMs: number) {
  const alertMs = Date.parse(alert.alert_time);
  const out: { key: string; cpMs: number }[] = [];
  for (const cp of CHECKPOINTS) {
    if (done.includes(cp.key)) continue;
    const cpMs = cp.mins != null ? alertMs + cp.mins * 60_000 : etCloseMs(alert.trading_day);
    if (cpMs <= nowMs) out.push({ key: cp.key, cpMs });
  }
  return out;
}

async function barsForAlert(ticker: string, alertDay: string, cache: Map<string, Bar[]>): Promise<Bar[]> {
  if (cache.has(ticker)) return cache.get(ticker)!;
  const ageDays = Math.max(1, Math.round((Date.now() - Date.parse(alertDay)) / 86400000) + 1);
  const res: any = await fetchCandles(ticker, {
    resolution: ageDays > 2 ? "5" : "1",
    timespan: "minute",
    from: alertDay,
    to: tradingDay(),
  });
  const bars: Bar[] = res?.available ? res.bars : [];
  cache.set(ticker, bars);
  return bars;
}

/** One sweep over all tracking alerts. Returns what it did (for /track). */
export async function runTrackerSweep(nowMs = Date.now()) {
  const alerts: any[] = trackingAlerts();
  if (!alerts.length) return { checked: 0, recorded: 0, finalized: 0 };
  const barCache = new Map<string, Bar[]>();
  let recorded = 0;
  let finalized = 0;

  for (const a of alerts) {
    const due = dueCheckpoints(a, existingCheckpoints(a.id), nowMs);
    if (!due.length) continue;
    const alertMs = Date.parse(a.alert_time);
    const bars = await barsForAlert(a.ticker, a.trading_day, barCache);

    for (const { key, cpMs } of due) {
      const cp = computeCheckpoint(bars, { alertMs, cpMs, alertPrice: a.price_at_alert, direction: a.direction });
      if (!cp) {
        // No bars yet (delayed data / halted) — record the attempt only at EOD
        // +1h grace so earlier checkpoints can still backfill next sweep.
        if (key === "eod" && nowMs > cpMs + 3_600_000) {
          recordCheckpoint({ alertId: a.id, checkpoint: key, checkedAt: new Date(nowMs).toISOString(),
            priceAtCheckpoint: null, percentMoveFromAlert: null, maxPriceAfterAlert: null,
            maxPercentMoveAfterAlert: null, drawdownAfterAlert: null, isFalsePositive: null });
          finalizeAlert(a.id, false);
          finalized++;
        }
        continue;
      }

      let fp: boolean | null = null;
      if (key === "eod") {
        fp = isFalsePositive({
          maxFavorablePct: cp.maxPercentMoveAfterAlert,
          eodFavorablePct: cp.percentMoveFromAlert,
          minFavorablePct: FP_MIN_FAVORABLE_PCT,
        });
      }
      recordCheckpoint({
        alertId: a.id, checkpoint: key, checkedAt: new Date(nowMs).toISOString(),
        priceAtCheckpoint: cp.priceAtCheckpoint, percentMoveFromAlert: cp.percentMoveFromAlert,
        maxPriceAfterAlert: cp.maxPriceAfterAlert, maxPercentMoveAfterAlert: cp.maxPercentMoveAfterAlert,
        drawdownAfterAlert: cp.drawdownAfterAlert, isFalsePositive: fp,
      });
      recorded++;
      if (key === "eod") {
        finalizeAlert(a.id, Boolean(fp));
        // Outcome facts beyond price: which SIDE worked, spread health, reversal.
        try {
          const win = bars.filter((b) => b.t >= alertMs && b.t <= cpMs);
          if (win.length && Number.isFinite(a.price_at_alert) && a.price_at_alert > 0) {
            const maxUp = (Math.max(...win.map((b) => (Number.isFinite(b.h) ? b.h : b.c))) - a.price_at_alert) / a.price_at_alert * 100;
            const maxDown = (Math.min(...win.map((b) => (Number.isFinite(b.l) ? b.l : b.c))) - a.price_at_alert) / a.price_at_alert * 100;
            const thr = FP_MIN_FAVORABLE_PCT;
            const spreads = alertSpreadHistory(a.id);
            recordAlertOutcomes(a.id, {
              callSideWorked: maxUp >= thr,
              putSideWorked: maxDown <= -thr,
              spreadWidened: spreads.atAlert != null && spreads.maxLive != null ? spreads.maxLive > Math.max(spreads.atAlert * 1.5, spreads.atAlert + 3) : null,
              reversed: Boolean(cp.maxPercentMoveAfterAlert != null && cp.maxPercentMoveAfterAlert >= thr && cp.percentMoveFromAlert != null && cp.percentMoveFromAlert < 0),
            });
          }
        } catch { /* outcome bookkeeping never blocks finalize */ }
        finalized++;
      }
    }
  }
  return { checked: alerts.length, recorded, finalized };
}

// ── In-process scheduler (started from instrumentation.ts) ──────────────────

const SWEEP_MS = Number(process.env.ALERT_TRACK_INTERVAL_MS ?? 60_000);
type G = typeof globalThis & { __optiscanTracker?: ReturnType<typeof setInterval>; __optiscanSweeping?: boolean };

export function startAlertTracker() {
  const g = globalThis as G;
  if (g.__optiscanTracker) return; // survive dev-mode module reloads
  if (process.env.ALERT_LAB_ENABLED === "0") return;
  g.__optiscanTracker = setInterval(async () => {
    if (g.__optiscanSweeping) return; // never overlap sweeps
    g.__optiscanSweeping = true;
    try {
      await runTrackerSweep();
    } catch (err) {
      console.warn("[alert-lab] tracker sweep failed:", (err as Error)?.message);
    } finally {
      g.__optiscanSweeping = false;
    }
  }, SWEEP_MS);
  // Don't hold the process open just for the tracker.
  (g.__optiscanTracker as any)?.unref?.();
  console.log(`[alert-lab] tracker running every ${Math.round(SWEEP_MS / 1000)}s`);
}

/**
 * stock-momentum-latch.ts - pure deterministic crossing latch for the shares
 * momentum path.
 *
 * It remembers a short-lived "speed crossed while still valid" episode so a
 * very fast stock is not missed when volume confirmation arrives one or two
 * evaluations later. It does not bypass final capture/Discord gates; callers
 * still re-run stock scoring, freshness, NBBO, timing, and anti-chase checks.
 */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

export interface StockMomentumLatchConfig {
  enabled: boolean;
  ttlMs: number;
  minVelocityPctMin: number;
  minInstantPctMin: number;
  minAcceleration: number;
  minVolumeSurge: number;
  minRelVol: number;
  maxQuoteAgeMs: number;
  maxVwapExtensionPct: number;
  maxDayRunPct: number;
}

export function stockMomentumLatchConfig(env: NodeJS.ProcessEnv = process.env): StockMomentumLatchConfig {
  return {
    enabled: env.STOCK_MOMENTUM_LATCH !== "0",
    ttlMs: num(env.STOCK_MOMENTUM_LATCH_TTL_MS, 20_000),
    minVelocityPctMin: num(env.STOCK_LATCH_MIN_VELOCITY_PCT_MIN, 0.22),
    minInstantPctMin: num(env.STOCK_LATCH_MIN_INSTANT_PCT_MIN, 0.24),
    minAcceleration: num(env.STOCK_LATCH_MIN_ACCEL, 0),
    minVolumeSurge: num(env.STOCK_LATCH_MIN_VOL_SURGE, 1.18),
    minRelVol: num(env.STOCK_LATCH_MIN_REL_VOL, 1.35),
    maxQuoteAgeMs: num(env.STOCK_MAX_QUOTE_AGE_MS, 15_000),
    maxVwapExtensionPct: num(env.STOCK_MAX_VWAP_EXT_PCT, 2.5),
    maxDayRunPct: num(env.STOCK_MAX_DAY_RUN_PCT, 6),
  };
}

export interface StockMomentumSnapshot {
  direction: "bullish" | "bearish" | "choppy";
  shortRate: number | null;
  instantRate: number | null;
  acceleration: number | null;
  surge: number | null;
  relVol: number | null;
  vwapDistPct: number | null;
  dayChangePct: number | null;
  quoteAgeMs: number | null;
}

export interface StockMomentumLatchState {
  developingSinceMs: number | null;
  lastCrossedAtMs: number | null;
  firedAtMs: number | null;
  invalidatedAtMs: number | null;
  reason: string | null;
}

export const EMPTY_STOCK_MOMENTUM_LATCH: StockMomentumLatchState = Object.freeze({
  developingSinceMs: null,
  lastCrossedAtMs: null,
  firedAtMs: null,
  invalidatedAtMs: null,
  reason: null,
});

function alignedRate(s: StockMomentumSnapshot, value: number | null): number | null {
  if (!isNum(value)) return null;
  if (s.direction === "bullish") return value;
  if (s.direction === "bearish") return -value;
  return null;
}

export function stockMomentumExtendedReason(
  s: StockMomentumSnapshot,
  cfg: StockMomentumLatchConfig = stockMomentumLatchConfig(),
): string | null {
  if (cfg.maxDayRunPct > 0 && isNum(s.dayChangePct) && Math.abs(s.dayChangePct) >= cfg.maxDayRunPct) {
    return `day move ${s.dayChangePct.toFixed(1)}% is beyond ${cfg.maxDayRunPct}%`;
  }
  if (cfg.maxVwapExtensionPct > 0 && isNum(s.vwapDistPct) && s.vwapDistPct >= cfg.maxVwapExtensionPct) {
    return `VWAP extension ${s.vwapDistPct.toFixed(1)}% is beyond ${cfg.maxVwapExtensionPct}%`;
  }
  return null;
}

export function stockMomentumDeveloping(
  s: StockMomentumSnapshot,
  cfg: StockMomentumLatchConfig = stockMomentumLatchConfig(),
): { ok: boolean; reason: string } {
  if (!cfg.enabled) return { ok: false, reason: "latch disabled" };
  if (s.direction !== "bullish") return { ok: false, reason: `direction ${s.direction} is not long momentum` };
  if (isNum(s.quoteAgeMs) && s.quoteAgeMs > cfg.maxQuoteAgeMs) return { ok: false, reason: "quote stale" };
  const extended = stockMomentumExtendedReason(s, cfg);
  if (extended) return { ok: false, reason: extended };
  const rate = alignedRate(s, s.shortRate);
  const instant = alignedRate(s, s.instantRate);
  const accel = alignedRate(s, s.acceleration);
  const fast = (isNum(rate) && rate >= cfg.minVelocityPctMin) || (isNum(instant) && instant >= cfg.minInstantPctMin);
  if (!fast) return { ok: false, reason: "velocity below latch threshold" };
  if (cfg.minAcceleration > 0 && (!isNum(accel) || accel < cfg.minAcceleration)) {
    return { ok: false, reason: "acceleration below latch threshold" };
  }
  return { ok: true, reason: "speed crossed while still inside anti-chase window" };
}

export function stockMomentumVolumeConfirmed(
  s: StockMomentumSnapshot,
  cfg: StockMomentumLatchConfig = stockMomentumLatchConfig(),
): boolean {
  return (isNum(s.surge) && s.surge >= cfg.minVolumeSurge) || (isNum(s.relVol) && s.relVol >= cfg.minRelVol);
}

export function updateStockMomentumLatch(
  state: StockMomentumLatchState,
  input: { snapshot: StockMomentumSnapshot; nowMs: number; fired?: boolean; cfg?: StockMomentumLatchConfig },
): StockMomentumLatchState {
  const cfg = input.cfg ?? stockMomentumLatchConfig();
  const nowMs = input.nowMs;
  if (!cfg.enabled) return { ...EMPTY_STOCK_MOMENTUM_LATCH };
  if (input.fired) {
    return { ...state, firedAtMs: nowMs, developingSinceMs: null, lastCrossedAtMs: null, reason: "normal trigger fired" };
  }
  if (state.developingSinceMs != null && nowMs - state.developingSinceMs > cfg.ttlMs) {
    return { ...EMPTY_STOCK_MOMENTUM_LATCH, invalidatedAtMs: nowMs, reason: "latch expired" };
  }
  const dev = stockMomentumDeveloping(input.snapshot, cfg);
  if (!dev.ok) {
    const hasActive = state.developingSinceMs != null;
    return hasActive ? { ...EMPTY_STOCK_MOMENTUM_LATCH, invalidatedAtMs: nowMs, reason: dev.reason } : state;
  }
  return {
    ...state,
    developingSinceMs: state.developingSinceMs ?? nowMs,
    lastCrossedAtMs: nowMs,
    invalidatedAtMs: null,
    reason: dev.reason,
  };
}

export function stockMomentumLatchRescue(
  state: StockMomentumLatchState,
  snapshot: StockMomentumSnapshot,
  nowMs: number,
  cfg: StockMomentumLatchConfig = stockMomentumLatchConfig(),
): { rescue: boolean; reason: string } {
  if (!cfg.enabled) return { rescue: false, reason: "latch disabled" };
  if (state.firedAtMs != null && nowMs - state.firedAtMs <= cfg.ttlMs) return { rescue: false, reason: "episode already fired" };
  if (state.developingSinceMs == null) return { rescue: false, reason: "no active crossing" };
  if (nowMs - state.developingSinceMs > cfg.ttlMs) return { rescue: false, reason: "latch expired" };
  const dev = stockMomentumDeveloping(snapshot, cfg);
  if (!dev.ok) return { rescue: false, reason: dev.reason };
  if (!stockMomentumVolumeConfirmed(snapshot, cfg)) return { rescue: false, reason: "volume not confirmed yet" };
  return { rescue: true, reason: "latched velocity now has volume confirmation" };
}

export function markStockMomentumLatchFired(state: StockMomentumLatchState, nowMs: number): StockMomentumLatchState {
  return { ...state, firedAtMs: nowMs, developingSinceMs: null, lastCrossedAtMs: null, reason: "fired" };
}

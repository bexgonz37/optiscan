/**
 * Polygon quota policy — discovery vs grader reserve.
 * When daily budget is nearly exhausted, discovery pauses but grader marks may continue.
 */
import { getCallStats, QuotaExceededError } from "./polygon-provider.js";

export type PolygonCallPurpose = "discovery" | "grader" | "default";

export function graderDailyReserve(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.POLYGON_GRADER_DAILY_RESERVE ?? 5000);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5000;
}

export function discoveryDailyBudget(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): number {
  const stats = getCallStats(nowMs);
  const reserve = graderDailyReserve(env);
  const cap = stats.dailyCap;
  if (cap <= 0) return Infinity;
  return Math.max(0, cap - reserve);
}

export function isDiscoveryPaused(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): boolean {
  const stats = getCallStats(nowMs);
  if (!stats.dailyCap || stats.dailyCap <= 0) return false;
  const budget = discoveryDailyBudget(env, nowMs);
  return stats.callsToday >= budget;
}

export function quotaPolicySnapshot(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()) {
  const stats = getCallStats(nowMs);
  const reserve = graderDailyReserve(env);
  const discoveryBudget = discoveryDailyBudget(env, nowMs);
  const discoveryPaused = isDiscoveryPaused(env, nowMs);
  const hardDailyExceeded = stats.dailyCap > 0 && stats.callsToday >= stats.dailyCap;
  return {
    ...stats,
    graderDailyReserve: reserve,
    discoveryDailyBudget: discoveryBudget,
    discoveryPaused,
    quotaMode: hardDailyExceeded ? "hard_exhausted" : discoveryPaused ? "discovery_paused" : stats.quotaExceeded ? "minute_limited" : "ok",
    operatorWarning: hardDailyExceeded
      ? "Polygon daily cap exhausted — discovery and marks paused until next ET trading day."
      : discoveryPaused
        ? `Polygon discovery budget reached (${stats.callsToday}/${discoveryBudget}) — reserving ${reserve} calls for open-position marks.`
        : stats.quotaExceeded
          ? "Polygon minute cap reached — backing off non-critical fetches."
          : null,
  };
}

/** Whether a provider call of this purpose should be allowed under current quota. */
export function shouldAllowPolygonCall(purpose: PolygonCallPurpose, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): boolean {
  const stats = getCallStats(nowMs);
  if (stats.dailyCap > 0 && stats.callsToday >= stats.dailyCap) return purpose === "grader" ? false : false;
  if (purpose === "grader") return stats.dailyCap <= 0 || stats.callsToday < stats.dailyCap;
  if (purpose === "discovery" && isDiscoveryPaused(env, nowMs)) return false;
  return !stats.quotaExceeded;
}

export { QuotaExceededError };

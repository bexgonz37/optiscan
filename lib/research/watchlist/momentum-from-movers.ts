/**
 * momentum-from-movers.ts — the Watchlist's HIGH_VOLUME_MOMENTUM tier, fed from
 * observations that have already been paid for.
 *
 * WHY THIS EXISTS
 *
 * `universe.ts` has had a `HIGH_VOLUME_MOMENTUM` tier since it was written, and
 * `liveProfessionalWatchlistDeps()` deliberately did not supply it — correctly,
 * because at the time no confirmed source existed and an unconfigured source
 * contributing a fabricated name is worse than contributing nothing.
 *
 * `market_mover_observations` is now that source. It is written by
 * `recordMarketMoverCycle` off the whole-market snapshot the scanner has
 * ALREADY fetched and paid for, before the $50 broad-runner ceiling, so reading
 * it here costs **zero provider requests**. An MRNA-class mover reaches the
 * Watchlist by being observed, not by being quoted again.
 *
 * WHAT THIS IS NOT
 *
 * It is not a callout, not an entry, and carries no trade authority. Earning a
 * Watchlist slot means only WATCH THIS INTO THE OPEN. A symbol admitted here
 * still has to clear the options-liquidity gate in `universe.ts` and then carry
 * real setup evidence in `professional-plan.ts` before it is published — and
 * both of those can, and often will, reject it. Admission buys a look, nothing
 * more.
 *
 * WHICH SESSION IS READ
 *
 * The most recent session on or before today that actually has observations,
 * resolved from the table rather than assumed. The overnight run at 18:00 ET
 * wants the session that just closed; the premarket run at 08:30 ET wants the
 * same one until its own session starts producing rows. Asking the table
 * "what is the newest session you hold" answers both without a calendar, and
 * returns nothing at all rather than a guess when the table is empty.
 */
import { listMarketMoversOnDb } from "../discovery/mover-store.ts";
import type { MomentumCandidate } from "./universe.ts";

interface StoreDb {
  prepare: (sql: string) => { all: (...a: any[]) => any[]; get: (...a: any[]) => any };
}

/** How many observed movers may be offered. The admission band caps it again. */
export const MOMENTUM_FEED_LIMIT = 40;

/**
 * Floor for being OFFERED to the watchlist. Deliberately below the universe's
 * own `MIN_MOMENTUM_ABS_MOVE_PCT`/dollar-volume floors: this function's job is
 * to hand over observations, and the admission decision stays where it already
 * lives. Two independent floors in two modules is how thresholds drift apart.
 */
export const MOMENTUM_FEED_MIN_ABS_MOVE_PCT = 3;

function hasTable(db: StoreDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/**
 * Newest session date in the observation table at or before `onOrBefore`.
 * Null when the table is absent or holds nothing — never a fabricated date.
 */
export function latestObservedSessionOnDb(db: StoreDb, onOrBefore: string): string | null {
  if (!hasTable(db, "market_mover_observations")) return null;
  try {
    const r = db.prepare(
      "SELECT MAX(session_date) AS d FROM market_mover_observations WHERE session_date <= ?",
    ).get(onOrBefore) as any;
    const d = r?.d;
    return typeof d === "string" && d.length === 10 ? d : null;
  } catch {
    return null;
  }
}

/**
 * Observed movers as Watchlist momentum candidates.
 *
 * `absMovePct` is the session PEAK absolute move and `observedAtMs` is when the
 * symbol was LAST seen, so the pair always describes an observation that has
 * already happened. `universe.ts` rejects any candidate whose `observedAtMs` is
 * in the future, and this must never be the thing that trips it.
 */
export function momentumCandidatesFromMoversOnDb(
  db: StoreDb,
  opts: { sessionDate: string; nowMs: number; limit?: number },
): { candidates: MomentumCandidate[]; sessionUsed: string | null } {
  const sessionUsed = latestObservedSessionOnDb(db, opts.sessionDate);
  if (!sessionUsed) return { candidates: [], sessionUsed: null };

  const rows = listMarketMoversOnDb(db as any, sessionUsed, {
    limit: Math.max(1, Math.min(500, Math.floor(opts.limit ?? MOMENTUM_FEED_LIMIT))),
    minPeakAbsMovePct: MOMENTUM_FEED_MIN_ABS_MOVE_PCT,
  }) as Array<{
    symbol: string;
    peakAbsMovePct: number | null;
    dollarVolume: number | null;
    lastObservedAtMs: number | null;
    firstObservedAtMs: number | null;
  }>;

  const candidates: MomentumCandidate[] = [];
  for (const r of rows) {
    const symbol = String(r?.symbol ?? "").trim().toUpperCase();
    const absMovePct = Number(r?.peakAbsMovePct);
    const dollarVolume = Number(r?.dollarVolume);
    const observedAtMs = Number(r?.lastObservedAtMs ?? r?.firstObservedAtMs);
    if (!symbol) continue;
    if (!Number.isFinite(absMovePct) || !Number.isFinite(dollarVolume)) continue;
    if (!Number.isFinite(observedAtMs) || observedAtMs > opts.nowMs) continue;
    candidates.push({ symbol, absMovePct: Math.abs(absMovePct), dollarVolume, observedAtMs });
  }
  return { candidates, sessionUsed };
}

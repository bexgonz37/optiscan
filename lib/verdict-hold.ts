/**
 * verdict-hold.ts — display hysteresis for live trade verdicts (v1.1).
 *
 * Problem: the hero verdict recomputes from live tape every tick, so a BUY
 * that momentarily stalls flips TRADE→WAIT→TRADE in front of the user
 * ("it changes its mind last minute"). The math is correct; the presentation
 * is jarring and erodes trust.
 *
 * Rule: UPGRADES show instantly (never hide an improving signal). DOWNGRADES
 * must persist for DOWNGRADE_HOLD_MS before the displayed verdict switches;
 * while pending, the UI shows a "weakening" warning with the reason, and
 * after switching it shows what it was downgraded from and why.
 *
 * This module is PURE presentation-state — it never changes what the verdict
 * engine decides, only when the screen commits to showing a worse verdict.
 */

export interface VerdictLike {
  action: string; // "TRADE" | "WAIT" | "SKIP"
  reason: string;
}

export interface HeldVerdict<V extends VerdictLike> {
  /** The verdict the UI should render right now. */
  shown: V;
  /** True while a worse verdict is pending but not yet committed. */
  weakening: boolean;
  /** Reason of the pending/committed downgrade (why it got worse). */
  weakeningReason: string | null;
  /** Set after a committed downgrade: the action it fell from. */
  downgradedFrom: string | null;
}

interface HoldEntry<V extends VerdictLike> {
  shown: V;
  pendingAction: string | null;
  pendingSince: number;
  pendingReason: string | null;
  downgradedFrom: string | null;
  downgradedAt: number;
  touchedAt: number;
}

export const DOWNGRADE_HOLD_MS = Number(process.env.NEXT_PUBLIC_VERDICT_HOLD_MS ?? 25_000);
/** How long the "downgraded from X" explanation stays visible after a switch. */
export const DOWNGRADE_NOTE_MS = 120_000;
const ENTRY_TTL_MS = 6 * 60 * 60 * 1000;

const RANK: Record<string, number> = { TRADE: 2, WAIT: 1, SKIP: 0 };

function rank(action: string): number {
  return RANK[action] ?? 0;
}

/**
 * Resolve the verdict to display for `key` given the freshly computed one.
 * Store is caller-owned (module-level Map in the component) so tests can use
 * their own.
 */
export function holdVerdict<V extends VerdictLike>(
  store: Map<string, HoldEntry<V>>,
  key: string,
  fresh: V,
  nowMs: number = Date.now(),
  holdMs: number = DOWNGRADE_HOLD_MS,
): HeldVerdict<V> {
  pruneHolds(store, nowMs);
  const h = store.get(key);

  if (!h) {
    store.set(key, {
      shown: fresh, pendingAction: null, pendingSince: 0, pendingReason: null,
      downgradedFrom: null, downgradedAt: 0, touchedAt: nowMs,
    });
    return { shown: fresh, weakening: false, weakeningReason: null, downgradedFrom: null };
  }
  h.touchedAt = nowMs;

  const shownRank = rank(h.shown.action);
  const freshRank = rank(fresh.action);

  if (freshRank >= shownRank) {
    // Same tier (refresh the details) or an upgrade (show immediately).
    const upgraded = freshRank > shownRank;
    h.shown = fresh;
    h.pendingAction = null;
    h.pendingReason = null;
    if (upgraded) {
      h.downgradedFrom = null;
      h.downgradedAt = 0;
    }
    const noteActive = h.downgradedFrom != null && nowMs - h.downgradedAt < DOWNGRADE_NOTE_MS;
    return {
      shown: fresh,
      weakening: false,
      weakeningReason: noteActive ? h.pendingReason : null,
      downgradedFrom: noteActive ? h.downgradedFrom : null,
    };
  }

  // Downgrade requested: start (or continue) the hold window.
  if (h.pendingAction !== fresh.action) {
    h.pendingAction = fresh.action;
    h.pendingSince = nowMs;
    h.pendingReason = fresh.reason;
  } else {
    h.pendingReason = fresh.reason; // keep the freshest explanation
  }

  if (nowMs - h.pendingSince >= holdMs) {
    // Sustained — commit the downgrade and say what happened.
    h.downgradedFrom = h.shown.action;
    h.downgradedAt = nowMs;
    h.shown = fresh;
    h.pendingAction = null;
    return {
      shown: fresh,
      weakening: false,
      weakeningReason: h.pendingReason,
      downgradedFrom: h.downgradedFrom,
    };
  }

  // Not yet sustained — keep showing the stronger verdict, warn it's weakening.
  return {
    shown: h.shown,
    weakening: true,
    weakeningReason: fresh.reason,
    downgradedFrom: null,
  };
}

/** Drop entries not touched in 6h (finished alerts) so the map stays small. */
export function pruneHolds<V extends VerdictLike>(store: Map<string, HoldEntry<V>>, nowMs: number): void {
  if (store.size < 64) return;
  for (const [k, e] of store) {
    if (nowMs - e.touchedAt > ENTRY_TTL_MS) store.delete(k);
  }
}

export function makeHoldStore<V extends VerdictLike>(): Map<string, HoldEntry<V>> {
  return new Map();
}

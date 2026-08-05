/**
 * option-milestone-evidence.ts — the executable-evidence rule for option
 * milestones, extracted so it can be tested without a database, a provider, or
 * the scheduler.
 *
 * An option milestone may only be claimed from exact-OCC option quotes. The
 * underlying moving after the close is not option performance, and a quote that
 * has aged out is not a current mark. Both rules live here so the tracker, the
 * lifecycle runners and the after-hours delivery gate share one definition
 * instead of re-deriving it.
 */

export interface OptionMilestoneSnapshot {
  checkpoint: string;
  optionSymbol: string | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  takenAt: string;
}

export interface VerifiedOptionMilestoneEvidence<T extends OptionMilestoneSnapshot> {
  entry: T;
  live: T[];
}

export const OPTION_MILESTONE_MAX_QUOTE_AGE_MS = Number(
  process.env.OPTION_MILESTONE_MAX_QUOTE_AGE_MS ?? 90_000,
);

/** True when a snapshot is a two-sided exact-OCC mark taken recently enough to call current. */
export function isExecutableLiveMark(
  snapshot: OptionMilestoneSnapshot,
  expectedOcc: string,
  nowMs: number,
  maxQuoteAgeMs: number = OPTION_MILESTONE_MAX_QUOTE_AGE_MS,
): boolean {
  if (snapshot.checkpoint !== "live") return false;
  if (String(snapshot.optionSymbol ?? "").toUpperCase() !== expectedOcc) return false;
  const at = Date.parse(snapshot.takenAt);
  if (!Number.isFinite(at) || at > nowMs || nowMs - at > maxQuoteAgeMs) return false;
  return snapshot.bid != null && snapshot.bid > 0
    && snapshot.ask != null && snapshot.ask >= snapshot.bid
    && snapshot.mid != null && snapshot.mid > 0;
}

/**
 * Returns the opening mark plus every still-current exact-OCC live mark, or
 * null when the evidence cannot support a milestone claim. Callers must treat
 * null as "no verified option return", never as zero.
 */
export function verifiedOptionMilestoneSnapshots<T extends OptionMilestoneSnapshot>(
  snapshots: readonly T[],
  expectedOcc: string | null | undefined,
  nowMs: number,
  maxQuoteAgeMs: number = OPTION_MILESTONE_MAX_QUOTE_AGE_MS,
): VerifiedOptionMilestoneEvidence<T> | null {
  const occ = String(expectedOcc ?? "").toUpperCase();
  if (!occ) return null;
  const entry = snapshots.find(
    (s) => s.checkpoint === "alert" && String(s.optionSymbol ?? "").toUpperCase() === occ,
  );
  const live = snapshots.filter((s) => isExecutableLiveMark(s, occ, nowMs, maxQuoteAgeMs));
  return entry && live.length ? { entry, live } : null;
}

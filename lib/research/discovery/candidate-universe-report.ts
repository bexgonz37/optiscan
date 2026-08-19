/**
 * candidate-universe-report.ts — is the momentum candidate universe still
 * SCREENERS-FIRST, and can it be checked at 9pm on a Tuesday?
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 *
 * The scanner's discovery cycle merges two candidate sources: a curated symbol list,
 * and a whole-market snapshot ("the screener") pre-filtered to the broad stock-runner
 * floor. The whole-market snapshot is the PRIMARY source — the curated list exists so
 * the loop is never empty, and it can only ADD names, never restrict the snapshot.
 *
 * That property was previously only observable through `discoveryStats`, which lives in
 * the loop's in-memory state. It is null whenever the market is closed (the loop is
 * showing a snapshot recap instead) and it is wiped by any restart or deploy. So the
 * one question an owner most wants to answer after hours — "is my scanner still looking
 * at the whole market, or did something quietly restrict it to a saved list?" — could
 * not be answered at all outside of market hours.
 *
 * This module answers it from CONFIGURATION, which is true at every hour, and reports
 * the live counts alongside when the loop happens to have them.
 *
 * ── What it is not ────────────────────────────────────────────────────────────
 *
 * Read-only. It makes no provider call, spends no quota, touches no table, and is not
 * consulted by any scanner rule, threshold, ranking, contract choice, target, stop,
 * exit, or delivery decision. Deleting it would change no trade.
 */

export interface DiscoveryStatsLike {
  atMs?: number;
  curatedCount?: number;
  broadCount?: number;
  broadPass?: number;
  universeSize?: number;
  promoted?: number;
  source?: string;
}

export type UniverseVerdict =
  | "SCREENERS_FIRST"
  | "CURATED_ONLY_BROAD_DISABLED"
  | "CURATED_LIST_OVERRIDDEN";

export interface CandidateUniverseReport {
  version: "CANDIDATE_UNIVERSE_REPORT_V1";
  verdict: UniverseVerdict;
  headline: string;
  /**
   * The whole-market snapshot is opt-OUT: it runs unless STOCK_BROAD_DISCOVERY is
   * explicitly "0". Anything else, including unset, means it is on.
   */
  broadDiscoveryEnabled: boolean;
  /**
   * The curated list is SUPPLEMENTAL. It is merged with the whole-market snapshot and
   * loses to it on collision (the snapshot print is fresher), so it cannot narrow the
   * universe. It can only guarantee a floor.
   */
  curatedListSize: number;
  curatedListOverridden: boolean;
  /**
   * Live counts from the last discovery cycle, when the loop has them. Null outside
   * market hours and after any restart — which is a gap in observation, NOT evidence
   * that broad discovery is off. `broadDiscoveryEnabled` is the durable answer.
   */
  lastCycle: {
    observed: boolean;
    reason: string;
    atMs: number | null;
    source: string | null;
    curatedCount: number | null;
    broadScanned: number | null;
    broadPassedFloor: number | null;
    mergedUniverseSize: number | null;
    promoted: number | null;
  };
  notes: string[];
}

export interface CandidateUniverseInputs {
  env: NodeJS.ProcessEnv;
  /** Size of the curated discovery list actually in use. */
  curatedListSize: number;
  /** The loop's last discovery snapshot, or null when it has none. */
  discoveryStats: DiscoveryStatsLike | null | undefined;
  /** Current market session, used only to explain WHY a cycle is unobserved. */
  session: string | null;
}

export function buildCandidateUniverseReport(input: CandidateUniverseInputs): CandidateUniverseReport {
  const env = input.env ?? {};
  const broadDiscoveryEnabled = String(env.STOCK_BROAD_DISCOVERY ?? "") !== "0";
  const curatedListOverridden = String(env.SCANNER_DISCOVERY_UNIVERSE ?? "").trim().length > 0;
  const stats = input.discoveryStats ?? null;

  const observed = stats != null && stats.universeSize != null;
  const session = input.session ?? "unknown";
  const reason = observed
    ? "The loop ran a discovery cycle and these are its counts."
    : `No discovery cycle is in memory (session: ${session}). Discovery runs during the `
      + "live scan; outside it the loop shows a snapshot recap, and any restart clears the "
      + "counters. This is an absence of observation, not evidence that broad discovery is off — "
      + "read broadDiscoveryEnabled, which comes from configuration and is true at any hour.";

  const verdict: UniverseVerdict = !broadDiscoveryEnabled
    ? "CURATED_ONLY_BROAD_DISABLED"
    : curatedListOverridden
      ? "CURATED_LIST_OVERRIDDEN"
      : "SCREENERS_FIRST";

  const headline = verdict === "SCREENERS_FIRST"
    ? "Screeners first: the whole-market snapshot is the primary momentum source, and the "
      + `curated list of ${input.curatedListSize} names supplements it.`
    : verdict === "CURATED_LIST_OVERRIDDEN"
      ? "Screeners first, with a NON-DEFAULT curated list. The whole-market snapshot still runs "
        + "and still cannot be narrowed by the list, but SCANNER_DISCOVERY_UNIVERSE has replaced "
        + "the default supplemental names."
      : "BROAD DISCOVERY IS OFF. STOCK_BROAD_DISCOVERY=0, so the whole-market snapshot is skipped "
        + `and the candidate universe is the curated list of ${input.curatedListSize} names only. `
        + "A stock outside that list cannot be discovered no matter how it moves.";

  const notes: string[] = [
    "The curated list is SUPPLEMENTAL and additive. Sources are merged by symbol and the "
    + "whole-market print wins on collision, so the list can raise the floor of the universe "
    + "but can never restrict it.",
    "There is no per-user saved watchlist in this system, so no saved list can narrow the scan.",
    "Appearing in the candidate universe is not a callout. Every gate, directional authority "
    + "check, strategy confirmation and contract selection still applies downstream.",
  ];
  if (!broadDiscoveryEnabled) {
    notes.push("OWNER ACTION: unset STOCK_BROAD_DISCOVERY (or set it to 1) to restore screeners-first discovery.");
  }
  if (curatedListOverridden) {
    notes.push("SCANNER_DISCOVERY_UNIVERSE is set, so the default curated list is not in use.");
  }

  return {
    version: "CANDIDATE_UNIVERSE_REPORT_V1",
    verdict,
    headline,
    broadDiscoveryEnabled,
    curatedListSize: input.curatedListSize,
    curatedListOverridden,
    lastCycle: {
      observed,
      reason,
      atMs: observed ? Number(stats?.atMs ?? null) || null : null,
      source: observed ? String(stats?.source ?? "") || null : null,
      curatedCount: observed ? Number(stats?.curatedCount ?? null) : null,
      broadScanned: observed ? Number(stats?.broadCount ?? null) : null,
      broadPassedFloor: observed ? Number(stats?.broadPass ?? null) : null,
      mergedUniverseSize: observed ? Number(stats?.universeSize ?? null) : null,
      promoted: observed ? Number(stats?.promoted ?? null) : null,
    },
    notes,
  };
}

/**
 * owner-delivery-reconciliation.ts — the nightly recap's answer to "what did the owner
 * ACTUALLY receive tonight, and how do those messages reconcile with what was tracked?"
 *
 * ── The sentence this module exists to stop the recap from saying ────────────
 *
 * The recap's PRIMARY section was headed "OWNER DISCORD ALERTS — the alerts you actually
 * received", and it was built from `OWNER_VALIDATION_PAPER` mirrors. A paper mirror is
 * written after the send result WITHOUT reading it, so a mirror exists whether or not a
 * Discord message was ever posted. On 2026-08-20 production wrote ten owner openings,
 * suppressed every one of them, mirrored most of them — and that heading would have called
 * it a ten-alert day.
 *
 * So the populations are separated at the source and never summed:
 *
 *   DELIVERED TO YOU        `discord_deliveries.status = 'SENT'`. Nothing else.
 *   NOT SENT / SUPPRESSED   the same ledger, any other status, with its reason.
 *   INTERNAL / PAPER        `OWNER_VALIDATION_PAPER` rows with no SENT opening. Real
 *                           tracked trades, real evidence — and never once presented as
 *                           an alert the owner received.
 *
 * ── Reconciliation is two-directional on purpose ─────────────────────────────
 *
 * "Delivered openings that reconcile" is not the interesting number. The two that matter
 * are the ones a single-direction check hides:
 *
 *   - a DELIVERED opening with NO tracking row. The owner was told to take a trade and the
 *     system kept no record of how it went. `orphanedDeliveries` surfaces it by name rather
 *     than dropping it from a join.
 *   - a TRACKED trade with no delivered opening. Legitimate and expected while suppression
 *     is on — but it belongs in INTERNAL, not in the owner's win rate.
 *
 * Statistics are computed ONLY over the population being reported. The delivered W/L,
 * expectancy and profit factor read the delivered subset and nothing else.
 *
 * Read-only. No provider call, no quota spend, no send authority, no writes.
 */

import {
  loadOwnerDeliveryLedgerOnDb,
  type DeliveryTruthDb,
  type OwnerOpeningDelivery,
} from "../../notifications/owner-delivery-truth.ts";
import { buildOwnerLearningReportOnDb, type OwnerLearningRow } from "./owner-learning.ts";
import { OWNER_VALIDATION_PAPER_KIND } from "../../opportunity-case/owner-mirror-identity.ts";

export const OWNER_DELIVERY_RECONCILIATION_VERSION = "OWNER_DELIVERY_RECONCILIATION_V1" as const;

export interface ReconciliationDb extends DeliveryTruthDb {
  prepare(sql: string): { get?: (...a: any[]) => any; all?: (...a: any[]) => any[] };
}

/** Realized statistics over ONE explicitly named population. Never blended with another. */
export interface PopulationStats {
  /** Which rows these numbers describe. Printed alongside them, always. */
  population: string;
  openings: number;
  tracked: number;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number | null;
  expectancyPct: number | null;
  profitFactor: number | null;
  bestPct: number | null;
  worstPct: number | null;
}

export interface DeliveredOpening {
  deliveryId: string;
  opportunityCaseId: string | null;
  sentAtMs: number | null;
  headline: string | null;
  /** The owner mirror for this case, when one exists. */
  paperTradeId: number | null;
  optionSymbol: string | null;
  status: string | null;
  realizedReturnPct: number | null;
  /** False => the owner was told about a trade nothing is tracking. */
  tracked: boolean;
}

export interface OwnerDeliveryReconciliation {
  version: typeof OWNER_DELIVERY_RECONCILIATION_VERSION;
  sessionDate: string;
  ledgerAvailable: boolean;

  /** THE delivered population: ledger SENT. */
  deliveredToYou: DeliveredOpening[];
  deliveredStats: PopulationStats;

  /** Attempted openings that never reached Discord, with the ledger's own reasons. */
  notSent: OwnerOpeningDelivery[];
  notSentByReason: Record<string, number>;

  /** Tracked owner paper rows with no SENT opening. Internal evidence, never "alerts". */
  internalPaperStats: PopulationStats;

  /**
   * Delivered openings with no owner mirror. Surfaced by case id rather than dropped —
   * a delivered alert with no tracking is the one gap a join would silently swallow.
   */
  orphanedDeliveries: DeliveredOpening[];
  /** Delivered ledger rows carrying no case id at all, so they cannot be reconciled. */
  deliveriesWithoutCaseIdentity: number;

  /** Exact reconciliation: deliveredToYou.length always equals the ledger's SENT count. */
  reconciles: boolean;
  reconciliationNote: string;
}

const round = (n: number, dp = 4): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

function statsFor(population: string, rows: OwnerLearningRow[], openings: number): PopulationStats {
  const exact = rows.filter((r) => r.occExact);
  const closed = exact.filter((r) => r.status === "EXITED" && r.realizedReturnPct != null);
  const returns = closed.map((r) => r.realizedReturnPct as number);
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x <= 0);
  const gross = wins.reduce((s, x) => s + x, 0);
  const lossSum = -losses.reduce((s, x) => s + x, 0);
  return {
    population,
    openings,
    tracked: rows.length,
    closed: closed.length,
    open: exact.filter((r) => r.status !== "EXITED").length,
    wins: wins.length,
    losses: losses.length,
    winRate: returns.length ? round(wins.length / returns.length) : null,
    expectancyPct: returns.length ? round(returns.reduce((s, x) => s + x, 0) / returns.length) : null,
    // A profit factor with no losing trade is not infinity, it is unmeasured. Null says so.
    profitFactor: lossSum > 0 ? round(gross / lossSum) : null,
    bestPct: wins.length ? round(Math.max(...wins)) : null,
    worstPct: losses.length ? round(Math.min(...losses)) : null,
  };
}

const EMPTY_STATS = (population: string): PopulationStats => ({
  population,
  openings: 0, tracked: 0, closed: 0, open: 0, wins: 0, losses: 0,
  winRate: null, expectancyPct: null, profitFactor: null, bestPct: null, worstPct: null,
});

/**
 * Reconcile one ET session's owner Discord deliveries against the owner tracking lane.
 *
 * Isolated end to end: a missing ledger yields an empty delivered population and says so
 * via `ledgerAvailable`, rather than falling back to the mirrors — which is the exact
 * substitution that produced the false heading in the first place.
 */
export function buildOwnerDeliveryReconciliationOnDb(
  db: ReconciliationDb,
  opts: { sessionDate: string },
): OwnerDeliveryReconciliation {
  const ledger = loadOwnerDeliveryLedgerOnDb(db, { sessionDate: opts.sessionDate });

  let rows: OwnerLearningRow[] = [];
  try {
    rows = buildOwnerLearningReportOnDb(db as never, { sessionDate: opts.sessionDate }).rows;
  } catch {
    rows = [];
  }
  const byCase = new Map<string, OwnerLearningRow>();
  for (const r of rows) if (r.opportunityCaseId) byCase.set(r.opportunityCaseId, r);

  const deliveredToYou: DeliveredOpening[] = ledger.delivered.map((d) => {
    const row = d.opportunityCaseId ? byCase.get(d.opportunityCaseId) ?? null : null;
    return {
      deliveryId: d.deliveryId,
      opportunityCaseId: d.opportunityCaseId,
      sentAtMs: d.sentAtMs ?? d.createdAtMs,
      headline: d.headline,
      paperTradeId: row?.paperTradeId ?? null,
      optionSymbol: row?.optionSymbol ?? null,
      status: row?.status ?? null,
      realizedReturnPct: row?.realizedReturnPct ?? null,
      tracked: row != null,
    };
  });

  const deliveredRows = deliveredToYou
    .map((d) => (d.opportunityCaseId ? byCase.get(d.opportunityCaseId) : null))
    .filter((r): r is OwnerLearningRow => r != null);

  // INTERNAL is every tracked owner row whose case did NOT receive a Discord message.
  // Computed by difference from the delivered set, so a row can never appear in both.
  const internalRows = rows.filter((r) => !ledger.deliveredCaseIds.has(r.opportunityCaseId));

  return {
    version: OWNER_DELIVERY_RECONCILIATION_VERSION,
    sessionDate: opts.sessionDate,
    ledgerAvailable: ledger.ledgerAvailable,
    deliveredToYou,
    deliveredStats: ledger.delivered.length || deliveredRows.length
      ? statsFor("DELIVERED TO YOU (Discord ledger SENT)", deliveredRows, ledger.delivered.length)
      : EMPTY_STATS("DELIVERED TO YOU (Discord ledger SENT)"),
    notSent: ledger.notSent,
    notSentByReason: ledger.notSentByReason,
    internalPaperStats: internalRows.length
      ? statsFor(`INTERNAL / PAPER (${OWNER_VALIDATION_PAPER_KIND}, no Discord message)`, internalRows, internalRows.length)
      : EMPTY_STATS(`INTERNAL / PAPER (${OWNER_VALIDATION_PAPER_KIND}, no Discord message)`),
    orphanedDeliveries: deliveredToYou.filter((d) => !d.tracked && d.opportunityCaseId != null),
    deliveriesWithoutCaseIdentity: ledger.delivered.filter((d) => d.opportunityCaseId == null).length,
    // The delivered population IS the ledger's SENT rows, one for one, by construction.
    // Asserted rather than assumed so a future refactor that starts filtering the list
    // fails this check instead of quietly under-reporting what the owner received.
    reconciles: deliveredToYou.length === ledger.delivered.length,
    reconciliationNote: ledger.ledgerAvailable
      ? `${deliveredToYou.length} SENT / ${ledger.notSent.length} not sent, from discord_deliveries`
      : "delivery ledger unavailable — no delivered population can be reported",
  };
}

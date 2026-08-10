/**
 * winner-events.ts — the verified historical move universe.
 *
 * Extracts, from stored exact-OCC NBBO, the events where a contract actually reached
 * +10 / +25 / +50 / +100 / +200 percent from a defensible executable entry.
 *
 * ── The entry convention is the whole argument ───────────────────────────────
 *
 *     ENTRY  = the ASK at T   (a buyer crosses the spread)
 *     LATER  = the MID        (the conservative reading of what the position was worth)
 *
 * Using the ask for both understates every move; using the bid for both overstates it;
 * using the mid for entry claims a fill nobody was offering. The asymmetry is not an
 * oversight — it is the only pairing that cannot flatter the result, and it is recorded
 * ON the event so a later reader cannot silently assume a different one.
 *
 * ── Identity ─────────────────────────────────────────────────────────────────
 *
 * One event is ONE exact OCC. There is no path here that identifies a winner using one
 * contract and measures it on another — the failure that produced a +185% peak on a
 * trade whose own contract never printed above +47%. The OCC is the key, the quotes are
 * filtered on it, and nothing joins across contracts.
 *
 * ── Refusals ─────────────────────────────────────────────────────────────────
 *
 * No executable quote at T means no event, not an event with an assumed entry. A
 * milestone reached before T is not this event's move. And an event whose window
 * contained too few quotes reports its coverage rather than a confident extreme.
 */
import { forwardExcursionOnDb, FORWARD_MILESTONES, sessionDateOf } from "./replay.ts";
import { resolveContractOnDb, type StoreDb } from "./store.ts";

export const WINNER_EVENT_VERSION = "HIST_WINNER_V1" as const;

/** Below this many post-entry quotes an extreme is reported as unsupported. */
export const MIN_QUOTES_FOR_EXTREME = 3;

export type WinnerEvidenceQuality = "VERIFIED" | "THIN" | "UNSUPPORTED";

export interface WinnerEvent {
  version: typeof WINNER_EVENT_VERSION;
  eventId: string;
  occ: string;
  symbol: string;
  side: "call" | "put" | null;
  strike: number | null;
  expiration: string | null;
  sessionDate: string | null;
  /**
   * The opportunity case this event was anchored on, when it came from one.
   *
   * Carried so a REALIZED outcome can be joined on provable identity later. Without it
   * the only available join key is the OCC, and one contract can appear in several cases
   * across a week — which is how a realized return gets attached to the wrong decision.
   */
  opportunityCaseId: string | null;

  entryAtMs: number;
  entryConvention: string;
  entryPrice: number | null;

  windowToMs: number;
  quotesUsed: number;

  /** Highest milestone actually reached after entry. Null when none was. */
  peakMilestone: number | null;
  /** ms from entry to first touch of each milestone. Null = never reached. */
  msToMilestone: Record<string, number | null>;
  mfePct: number | null;
  maePct: number | null;

  evidenceQuality: WinnerEvidenceQuality;
  note: string;
}

function eventIdFor(occ: string, entryAtMs: number): string {
  // Deterministic: the same contract and instant always produce the same id, so a
  // re-extraction updates rather than duplicating.
  return `we_${String(occ).toUpperCase().replace(/[^A-Z0-9]/g, "")}_${entryAtMs}`;
}

/**
 * Extract one event.
 *
 * Returns an event even when nothing was reached — "this contract was executable at T
 * and went nowhere" is a real observation and the control group depends on it. What it
 * refuses to return is an event with a fabricated entry.
 */
export function extractWinnerEventOnDb(
  db: StoreDb,
  input: {
    occ: string;
    symbol?: string | null;
    entryAtMs: number;
    windowMs?: number;
    maxStalenessMs?: number;
    opportunityCaseId?: string | null;
  },
): WinnerEvent | null {
  const occ = String(input.occ).toUpperCase();
  const windowMs = Math.max(60_000, input.windowMs ?? 6 * 3600_000);
  const toMs = input.entryAtMs + windowMs;

  const fwd = forwardExcursionOnDb(db, occ, {
    fromMs: input.entryAtMs, toMs, maxStalenessMs: input.maxStalenessMs,
  });
  if (fwd.entry == null) {
    // No executable quote at T. An event here would be a move measured from a price
    // nobody was showing.
    return null;
  }

  const ref = resolveContractOnDb(db, occ);
  const reached = FORWARD_MILESTONES.filter((m) => fwd.msToMilestone[String(m)] != null);
  const peak = reached.length ? Math.max(...reached) : null;

  const quality: WinnerEvidenceQuality = fwd.quotesUsed >= MIN_QUOTES_FOR_EXTREME
    ? "VERIFIED"
    : fwd.quotesUsed > 0 ? "THIN" : "UNSUPPORTED";

  return {
    version: WINNER_EVENT_VERSION,
    eventId: eventIdFor(occ, input.entryAtMs),
    occ,
    symbol: String(input.symbol ?? ref?.underlying ?? "").toUpperCase(),
    side: ref?.side ?? null,
    strike: ref?.strike ?? null,
    expiration: ref?.expiration ?? null,
    sessionDate: sessionDateOf(input.entryAtMs),
    opportunityCaseId: input.opportunityCaseId ?? null,
    entryAtMs: input.entryAtMs,
    entryConvention: fwd.entryConvention,
    entryPrice: fwd.entry,
    windowToMs: toMs,
    quotesUsed: fwd.quotesUsed,
    peakMilestone: peak,
    msToMilestone: fwd.msToMilestone,
    // An extreme needs enough observations to assert the gaps held nothing larger.
    mfePct: quality === "VERIFIED" ? fwd.mfePct : null,
    maePct: quality === "VERIFIED" ? fwd.maePct : null,
    evidenceQuality: quality,
    note:
      quality === "VERIFIED"
        ? `${fwd.quotesUsed} same-contract quotes after entry`
        : `only ${fwd.quotesUsed} post-entry quote(s); milestone TIMES stand, but no extreme is claimed`,
  };
}

export interface WinnerEventCensus {
  examined: number;
  events: number;
  refusedNoEntry: number;
  byMilestone: Record<string, number>;
  byQuality: Record<WinnerEvidenceQuality, number>;
  note: string;
}

/**
 * Extract events for a batch of candidate entries and census the result.
 *
 * `refusedNoEntry` is reported separately from "reached nothing". A contract with no
 * executable quote at T and a contract that was executable and went nowhere are
 * completely different findings, and pooling them would make coverage gaps look like
 * evidence of no edge.
 */
export function extractWinnerEventsOnDb(
  db: StoreDb,
  candidates: ReadonlyArray<{
    occ: string;
    symbol?: string | null;
    entryAtMs: number;
    opportunityCaseId?: string | null;
  }>,
  opts: { windowMs?: number; maxStalenessMs?: number } = {},
): { events: WinnerEvent[]; census: WinnerEventCensus } {
  const events: WinnerEvent[] = [];
  let refused = 0;
  const byMilestone: Record<string, number> = Object.fromEntries(
    FORWARD_MILESTONES.map((m) => [String(m), 0]),
  );
  const byQuality: Record<WinnerEvidenceQuality, number> = { VERIFIED: 0, THIN: 0, UNSUPPORTED: 0 };

  for (const c of candidates) {
    const e = extractWinnerEventOnDb(db, { ...c, windowMs: opts.windowMs, maxStalenessMs: opts.maxStalenessMs });
    if (!e) { refused += 1; continue; }
    events.push(e);
    byQuality[e.evidenceQuality] += 1;
    for (const m of FORWARD_MILESTONES) {
      if (e.msToMilestone[String(m)] != null) byMilestone[String(m)] += 1;
    }
  }

  return {
    events,
    census: {
      examined: candidates.length,
      events: events.length,
      refusedNoEntry: refused,
      byMilestone,
      byQuality,
      note:
        "refusedNoEntry counts candidates with NO executable quote at their entry instant — a "
        + "coverage gap, not evidence of no move. An event that reached nothing is a real "
        + "observation and the control group depends on it. Extremes require at least "
        + `${MIN_QUOTES_FOR_EXTREME} post-entry quotes; milestone TIMES do not.`,
    },
  };
}

/**
 * Candidate entries drawn from real opportunity cases.
 *
 * The frozen OCC and the detection instant, which is exactly the pairing the live lane
 * committed to. Cases without a frozen contract produce no candidate: there is nothing
 * to measure, and substituting a current-chain contract for a historical one is the
 * survivorship error this whole store exists to avoid.
 */
export function winnerCandidatesFromCasesOnDb(
  db: StoreDb,
  opts: { sinceMs?: number | null; limit?: number; scope?: "delivered" | "all" } = {},
): Array<{ occ: string; symbol: string; entryAtMs: number; opportunityCaseId: string }> {
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opportunity_cases'").get?.();
    if (!has) return [];
  } catch { return []; }
  const where: string[] = [];
  const params: any[] = [];
  if ((opts.scope ?? "delivered") === "delivered") where.push("delivery_decision='delivered'");
  if (opts.sinceMs != null) { where.push("detected_at_ms >= ?"); params.push(opts.sinceMs); }
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 500));
  try {
    const rows = (db.prepare(
      `SELECT opportunity_id, underlying_symbol, detected_at_ms, case_json
         FROM opportunity_cases ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY detected_at_ms DESC LIMIT ?`,
    ).all?.(...params, limit) ?? []) as any[];
    const out: Array<{ occ: string; symbol: string; entryAtMs: number; opportunityCaseId: string }> = [];
    for (const r of rows) {
      let occ: string | null = null;
      try {
        const c = JSON.parse(String(r.case_json ?? "{}"));
        const raw = c?.selectedContract?.optionSymbol;
        occ = raw ? String(raw).toUpperCase() : null;
      } catch { occ = null; }
      const atMs = Number(r.detected_at_ms);
      if (!occ || !Number.isFinite(atMs)) continue;
      out.push({
        occ,
        symbol: String(r.underlying_symbol ?? "").toUpperCase(),
        entryAtMs: atMs,
        opportunityCaseId: String(r.opportunity_id),
      });
    }
    return out;
  } catch {
    return [];
  }
}

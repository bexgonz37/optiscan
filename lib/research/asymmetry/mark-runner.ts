/**
 * mark-runner.ts — due-work forward marking, and outcome aggregation from the
 * marks it writes.
 *
 *   runDueAsymmetryMarks()
 *     -> listCasesOnDb()        [read cases]
 *     -> dueHorizons()          [pure: which horizons are owed now]
 *     -> quote provider         [injected]
 *     -> writeMarkOnDb()        [write marks]
 *   aggregateOutcomesOnDb()
 *     -> read marks             [read]
 *     -> write outcomes         [write]
 *
 * "Due work" rather than seven timers: on each tick we compute which horizons
 * have elapsed for each open case and have not yet been marked. That is
 * restart-safe — a redeploy loses no horizon — and idempotent, because the
 * marks PRIMARY KEY is (session, fingerprint, horizon).
 *
 * ENTRY IS THE ASK, MARKS ARE THE BID. Never mid, never theoretical. That is
 * the conservative direction on both sides and it is asserted by test.
 */
import { listCasesOnDb } from "./case-store.ts";
import { isOptionsQuoteSession } from "../../market-session-guard.ts";
import { tradingDay } from "../../trading-session.ts";

export const MARKS_ENABLED_ENV = "HIGH_ASYMMETRY_CAPTURE_ENABLED";
export const MARK_HORIZONS_MINUTES = [1, 3, 5, 10, 15, 30, 60] as const;
export const MAX_MARK_QUOTE_AGE_MS = 120_000;

type MarkDb = Parameters<typeof listCasesOnDb>[0];

export type MarkRejection =
  | "NO_QUOTE" | "STALE_QUOTE" | "FUTURE_QUOTE" | "WRONG_OCC" | "WRONG_SESSION"
  /** The provider itself failed. Distinct from a genuine absence of quote. */
  | "PROVIDER_ERROR"
  /**
   * We DECLINED to pay for this quote — daily/minute provider cap reached.
   * Separated from NO_QUOTE because it says nothing about the contract.
   * Production on 2026-07-31 recorded 2,718 NO_QUOTE rejections that were
   * really this, which made a self-inflicted budget problem look like a market
   * with no liquidity and hid the real defect for a full session.
   */
  | "PROVIDER_BUDGET"
  /** Quote arrived but had no usable two-sided market (bid <= 0 or crossed). */
  | "NO_TWO_SIDED_MARKET";

export interface MarkQuote {
  optionSymbol: string;
  bid: number | null;
  ask: number | null;
  quoteAtMs: number | null;
}

/** Which horizons have elapsed and are not yet recorded. Pure. */
export function dueHorizons(
  firstDetectedAtMs: number,
  nowMs: number,
  alreadyMarked: number[],
): number[] {
  const done = new Set(alreadyMarked);
  return MARK_HORIZONS_MINUTES.filter((m) => !done.has(m) && nowMs >= firstDetectedAtMs + m * 60_000);
}

/**
 * Validate one mark. Returns a rejection reason or null.
 * Refuses anything that could not have been traded at that moment.
 */
export function validateMark(
  quote: MarkQuote,
  expectedOcc: string,
  entrySessionDate: string,
  nowMs: number,
): MarkRejection | null {
  if (String(quote.optionSymbol ?? "").toUpperCase() !== expectedOcc.toUpperCase()) return "WRONG_OCC";
  const at = num(quote.quoteAtMs);
  if (at == null) return "NO_QUOTE";
  if (at > nowMs) return "FUTURE_QUOTE";
  if (nowMs - at > MAX_MARK_QUOTE_AGE_MS) return "STALE_QUOTE";
  if (!isOptionsQuoteSession(at)) return "WRONG_SESSION";
  if (tradingDay(at) !== entrySessionDate) return "WRONG_SESSION";
  const bid = num(quote.bid);
  const ask = num(quote.ask);
  if (bid == null || ask == null) return "NO_QUOTE";
  // A quote that arrived but has no executable two-sided market is a REAL
  // observation about the contract, unlike a quote that never arrived. Kept
  // apart so "we could not see it" and "there was nothing to see" stay
  // countable separately.
  if (bid <= 0 || ask < bid) return "NO_TWO_SIDED_MARKET";
  return null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface MarkRunResult {
  ran: boolean;
  reason: string | null;
  casesRead: number;
  marksWritten: number;
  marksRejected: number;
  outcomesUpdated: number;
  errors: string[];
}

export interface MarkDeps {
  /**
   * Fetch a present-time quote for an exact OCC. ASYNC, and takes the
   * underlying symbol too — this matches the real provider interface
   * (`buildLiveGradeDeps().getQuote`), verified against source.
   */
  quote: (optionSymbol: string, underlyingSymbol: string) => Promise<{
    quote: MarkQuote | null;
    providerError: string | null;
    /** True when the request was refused for budget rather than answered. */
    budgetBlocked?: boolean;
    /**
     * The instant the quote was observed. Optional so injected test deps keep
     * working; when absent the sweep clock is used, which is the old behaviour.
     */
    observedAtMs?: number;
  }>;
  nowMs: number;
  sessionDate: string;
  env?: NodeJS.ProcessEnv;
}

/** Sweep due marks for open cases, then re-aggregate outcomes. Never throws. */
export async function runDueAsymmetryMarks(db: MarkDb, deps: MarkDeps): Promise<MarkRunResult> {
  const out: MarkRunResult = { ran: false, reason: null, casesRead: 0, marksWritten: 0, marksRejected: 0, outcomesUpdated: 0, errors: [] };
  try {
    const env = deps.env ?? process.env;
    if (env[MARKS_ENABLED_ENV] !== "1") {
      out.reason = `${MARKS_ENABLED_ENV} is not set`;
      return out;
    }
    out.ran = true;
    const cases = listCasesOnDb(db, deps.sessionDate, 500);
    out.casesRead = cases.length;

    for (const c of cases) {
      try {
        const marked = existingHorizons(db, c.sessionDate, c.fingerprint);
        const due = dueHorizons(c.firstDetectedAtMs, deps.nowMs, marked);
        if (!due.length) continue;
        for (const horizon of due) {
          const fetched = await deps.quote(c.optionSymbol, c.symbol);
          const q = fetched.quote;
          // Three distinct failures, kept apart. A provider outage, a budget
          // refusal, and a contract with no market look identical downstream if
          // they share a reason code — and for one full session they did.
          // JUDGE AGAINST THE OBSERVATION CLOCK, NOT THE SWEEP CLOCK.
          // deps.nowMs is captured once when the beat starts. With ~171 open
          // cases at ~200ms per provider call the sweep runs for tens of
          // seconds, so a quote fetched late is legitimately NEWER than the
          // sweep start and was being discarded as FUTURE_QUOTE — 636 of 995
          // mark failures. Falling back to deps.nowMs keeps injected test
          // deps working unchanged.
          const observedAtMs = Number.isFinite(fetched.observedAtMs as number)
            ? (fetched.observedAtMs as number)
            : deps.nowMs;
          const rejection: MarkRejection | null = fetched.budgetBlocked
            ? "PROVIDER_BUDGET"
            : fetched.providerError
              ? "PROVIDER_ERROR"
              : q ? validateMark(q, c.optionSymbol, c.sessionDate, observedAtMs) : "NO_QUOTE";
          const returnPct = !rejection && c.earlyAsk && c.earlyAsk > 0 && q?.bid != null
            ? round2(((q.bid - c.earlyAsk) / c.earlyAsk) * 100)
            : null;
          const wrote = writeMarkOnDb(db, {
            sessionDate: c.sessionDate, fingerprint: c.fingerprint, optionSymbol: c.optionSymbol,
            horizonMinutes: horizon, markedAtMs: deps.nowMs,
            bid: rejection ? null : q?.bid ?? null,
            ask: rejection ? null : q?.ask ?? null,
            // Age is measured from the observation instant too, so a long
            // sweep no longer inflates every quote's apparent age.
            quoteAgeMs: q?.quoteAtMs != null ? observedAtMs - q.quoteAtMs : null,
            returnPct, rejectedReason: rejection,
          });
          if (wrote) { if (rejection) out.marksRejected += 1; else out.marksWritten += 1; }
        }
        if (aggregateOutcomesOnDb(db, c.sessionDate, c.fingerprint, deps.nowMs)) out.outcomesUpdated += 1;
      } catch (err: any) {
        out.errors.push(`${c.fingerprint}: ${String(err?.message ?? err)}`);
      }
    }
    return out;
  } catch (err: any) {
    out.errors.push(String(err?.message ?? err));
    return out;
  }
}

/**
 * Rejections that say nothing about the contract and may succeed on a later
 * sweep. A horizon that failed for one of these is NOT considered marked, so
 * the runner will try it again while the horizon is still meaningful.
 *
 * Without this, a single transient refusal permanently consumed the horizon:
 * the marks PRIMARY KEY made the row final, existingHorizons counted it as
 * done, and dueHorizons never offered it again. One exhausted budget therefore
 * destroyed a whole session of forward marks rather than delaying them.
 */
export const TRANSIENT_MARK_REJECTIONS: readonly MarkRejection[] =
  Object.freeze(["PROVIDER_BUDGET", "PROVIDER_ERROR", "NO_QUOTE"]);

export function isTransientRejection(reason: string | null | undefined): boolean {
  return reason != null && (TRANSIENT_MARK_REJECTIONS as readonly string[]).includes(reason);
}

function existingHorizons(db: MarkDb, sessionDate: string, fingerprint: string): number[] {
  try {
    const rows = db.prepare(
      "SELECT horizon_minutes h, rejected_reason r FROM asymmetry_marks WHERE session_date=? AND fingerprint=?",
    ).all(sessionDate, fingerprint) as any[];
    // A transiently-failed horizon is still owed, so it is not reported as done.
    return rows.filter((r) => !isTransientRejection(r.r == null ? null : String(r.r))).map((r) => Number(r.h));
  } catch {
    return [];
  }
}

/**
 * Write a mark. Repeat-safe, and a retry may REPLACE a transient failure with a
 * real observation — but a settled row is never overwritten, so a successful
 * mark or a genuine market condition can't be clobbered by a later sweep.
 */
export function writeMarkOnDb(db: MarkDb, m: {
  sessionDate: string; fingerprint: string; optionSymbol: string;
  horizonMinutes: number; markedAtMs: number;
  bid: number | null; ask: number | null; quoteAgeMs: number | null;
  returnPct: number | null; rejectedReason: MarkRejection | null;
}): boolean {
  try {
    const res = db.prepare(`
      INSERT INTO asymmetry_marks
        (session_date, fingerprint, option_symbol, horizon_minutes, marked_at_ms, bid, ask, quote_age_ms, return_pct, rejected_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_date, fingerprint, horizon_minutes) DO UPDATE SET
        marked_at_ms = excluded.marked_at_ms,
        bid = excluded.bid,
        ask = excluded.ask,
        quote_age_ms = excluded.quote_age_ms,
        return_pct = excluded.return_pct,
        rejected_reason = excluded.rejected_reason
      WHERE asymmetry_marks.rejected_reason IN ('PROVIDER_BUDGET','PROVIDER_ERROR','NO_QUOTE')
    `).run(m.sessionDate, m.fingerprint, m.optionSymbol, m.horizonMinutes, m.markedAtMs,
      m.bid, m.ask, m.quoteAgeMs, m.returnPct, m.rejectedReason);
    return Number(res.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Recompute outcomes for one case from its persisted marks. Idempotent upsert.
 * An empty mark set yields NULL metrics, never zeros.
 */
export function aggregateOutcomesOnDb(db: MarkDb, sessionDate: string, fingerprint: string, nowMs: number): boolean {
  try {
    const marks = db.prepare(`
      SELECT horizon_minutes h, marked_at_ms t, return_pct r
        FROM asymmetry_marks
       WHERE session_date=? AND fingerprint=? AND rejected_reason IS NULL AND return_pct IS NOT NULL
       ORDER BY horizon_minutes ASC
    `).all(sessionDate, fingerprint) as any[];
    const caseRow = db.prepare("SELECT option_symbol o, early_ask e, first_detected_at_ms f FROM asymmetry_cases WHERE session_date=? AND fingerprint=?")
      .get(sessionDate, fingerprint) as any;
    if (!caseRow) return false;

    const returns = marks.map((m) => Number(m.r));
    const mfe = returns.length ? Math.max(...returns) : null;
    const mae = returns.length ? Math.min(...returns) : null;
    const finalReturn = returns.length ? returns[returns.length - 1] : null;
    const firstAt = (pct: number) => {
      const hit = marks.find((m) => Number(m.r) >= pct);
      return hit ? Number(hit.t) - Number(caseRow.f) : null;
    };
    const hit = (pct: number) => (mfe == null ? null : mfe >= pct ? 1 : 0);

    db.prepare(`
      INSERT INTO asymmetry_outcomes
        (session_date, fingerprint, option_symbol, entry_ask, mfe_pct, mae_pct, final_return_pct,
         hit_25, hit_50, hit_100, hit_200, hit_500,
         time_to_25_ms, time_to_50_ms, time_to_100_ms, time_to_200_ms, time_to_500_ms,
         invalidated, marks_used, updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
      ON CONFLICT(session_date, fingerprint) DO UPDATE SET
        mfe_pct=excluded.mfe_pct, mae_pct=excluded.mae_pct, final_return_pct=excluded.final_return_pct,
        hit_25=excluded.hit_25, hit_50=excluded.hit_50, hit_100=excluded.hit_100,
        hit_200=excluded.hit_200, hit_500=excluded.hit_500,
        time_to_25_ms=excluded.time_to_25_ms, time_to_50_ms=excluded.time_to_50_ms,
        time_to_100_ms=excluded.time_to_100_ms, time_to_200_ms=excluded.time_to_200_ms,
        time_to_500_ms=excluded.time_to_500_ms,
        marks_used=excluded.marks_used, updated_at_ms=excluded.updated_at_ms
    `).run(sessionDate, fingerprint, String(caseRow.o), caseRow.e == null ? null : Number(caseRow.e),
      mfe, mae, finalReturn,
      hit(25), hit(50), hit(100), hit(200), hit(500),
      firstAt(25), firstAt(50), firstAt(100), firstAt(200), firstAt(500),
      returns.length, nowMs);
    return true;
  } catch {
    return false;
  }
}

export interface OutcomeRow {
  fingerprint: string; optionSymbol: string; entryAsk: number | null;
  mfePct: number | null; maePct: number | null; finalReturnPct: number | null;
  hit25: boolean | null; hit50: boolean | null; hit100: boolean | null;
  hit200: boolean | null; hit500: boolean | null; marksUsed: number;
}

/** Reader for the outcomes table — used by the EOD review and diagnostics. */
export function listOutcomesOnDb(db: MarkDb, sessionDate: string): OutcomeRow[] {
  try {
    return (db.prepare(`
      SELECT fingerprint, option_symbol, entry_ask, mfe_pct, mae_pct, final_return_pct,
             hit_25, hit_50, hit_100, hit_200, hit_500, marks_used
        FROM asymmetry_outcomes WHERE session_date=?
    `).all(sessionDate) as any[]).map((r) => ({
      fingerprint: String(r.fingerprint), optionSymbol: String(r.option_symbol),
      entryAsk: r.entry_ask == null ? null : Number(r.entry_ask),
      mfePct: r.mfe_pct == null ? null : Number(r.mfe_pct),
      maePct: r.mae_pct == null ? null : Number(r.mae_pct),
      finalReturnPct: r.final_return_pct == null ? null : Number(r.final_return_pct),
      hit25: b(r.hit_25), hit50: b(r.hit_50), hit100: b(r.hit_100), hit200: b(r.hit_200), hit500: b(r.hit_500),
      marksUsed: Number(r.marks_used ?? 0),
    }));
  } catch {
    return [];
  }
}

const b = (v: unknown): boolean | null => (v == null ? null : Number(v) === 1);
const round2 = (n: number) => Math.round(n * 100) / 100;

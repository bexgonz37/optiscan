import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/replay-verify — prove the time fence against REAL ingested data.
 *
 * The unit harness proves fencing by mutation: classify at T, write the future, classify
 * again, assert identical. That cannot be done in production — writing fake future rows
 * into the durable store to prove a point would corrupt the very record the proof is
 * about.
 *
 * So this proves the same property by OBSERVATION instead. For a real contract with real
 * stored quotes it shows, at an instant T that has genuine data on both sides:
 *
 *   · the quote used at T is timestamped <= T
 *   · quotes AFTER T exist, are counted, and are NOT the entry
 *   · the best price available after T is materially different from the entry — so if
 *     the fence leaked, the numbers would visibly differ
 *   · session-to-date extremes at T differ from the day's FINAL extremes
 *
 * That last check is the one that matters most. The final HOD/LOD is what makes a
 * "share of the move consumed" metric look precise, and it is the leak most likely to
 * go unnoticed because it makes results better rather than broken.
 *
 * Read-only: no provider call, no writes.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const {
      replayQuoteAsOfOnDb, replayUnderlyingStateOnDb, forwardExcursionOnDb, sessionDateOf,
    } = await import("@/lib/research/historical/replay");
    const { resolveContractOnDb } = await import("@/lib/research/historical/store");

    const db = getDb() as any;
    const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit") ?? 3)));

    // Contracts with the most stored quotes: the ones where an instant T genuinely has
    // data on both sides, so the check is meaningful rather than vacuous.
    const contracts = (db.prepare(
      `SELECT occ, COUNT(*) n, MIN(ts_ms) lo, MAX(ts_ms) hi
         FROM historical_option_quotes GROUP BY occ
        HAVING n >= 20 ORDER BY n DESC LIMIT ?`,
    ).all(limit) ?? []) as any[];

    const checks: any[] = [];
    for (const c of contracts) {
      const occ = String(c.occ);
      const lo = Number(c.lo);
      const hi = Number(c.hi);
      // T at the midpoint of the stored span: real data before AND after.
      const T = Math.floor((lo + hi) / 2);
      const ref = resolveContractOnDb(db, occ);
      const symbol = ref?.underlying ?? null;

      const atT = replayQuoteAsOfOnDb(db, occ, { asOfMs: T, maxStalenessMs: 30 * 60_000 });
      const after = db.prepare(
        "SELECT COUNT(*) n, MAX(ask) maxAsk FROM historical_option_quotes WHERE occ=? AND ts_ms > ?",
      ).get(occ, T) as any;
      const fwd = forwardExcursionOnDb(db, occ, { fromMs: T, toMs: hi, maxStalenessMs: 30 * 60_000 });

      // Session extremes AT T versus the day's FINAL extremes, from the bar store.
      let sessionAtT: any = null;
      let finalExtremes: any = null;
      if (symbol) {
        const st = replayUnderlyingStateOnDb(db, symbol, T);
        sessionAtT = { high: st.sessionHigh, low: st.sessionLow, price: st.price, barsUsed: st.barsUsed };
        const day = sessionDateOf(T);
        const dayStart = day ? Date.parse(`${day}T00:00:00-05:00`) : null;
        if (dayStart != null && Number.isFinite(dayStart)) {
          const f = db.prepare(
            `SELECT MAX(high) hi, MIN(low) lo FROM historical_underlying_bars
              WHERE symbol=? AND timeframe='1m' AND ts_ms >= ? AND ts_ms < ?`,
          ).get(symbol, dayStart, dayStart + 86_400_000) as any;
          finalExtremes = { high: f?.hi ?? null, low: f?.lo ?? null };
        }
      }

      const quoteIsAtOrBeforeT = atT ? atT.tsMs <= T : null;
      const hodDiffers = sessionAtT?.high != null && finalExtremes?.high != null
        ? sessionAtT.high !== finalExtremes.high
        : null;

      checks.push({
        occ,
        symbol,
        storedQuotes: Number(c.n),
        spanFrom: new Date(lo).toISOString(),
        spanTo: new Date(hi).toISOString(),
        instantT: new Date(T).toISOString(),
        quoteAtT: atT ? { tsMs: atT.tsMs, at: new Date(atT.tsMs).toISOString(), bid: atT.bid, ask: atT.ask, ageMs: atT.ageMs } : null,
        quoteIsAtOrBeforeT,
        quotesStrictlyAfterT: Number(after?.n ?? 0),
        maxAskAfterT: after?.maxAsk ?? null,
        entryUsed: fwd.entry,
        entryDiffersFromLaterBest:
          fwd.entry != null && after?.maxAsk != null ? fwd.entry !== Number(after.maxAsk) : null,
        forwardMfePct: fwd.mfePct,
        sessionExtremesAtT: sessionAtT,
        dayFinalExtremes: finalExtremes,
        sessionHighAtTDiffersFromDayFinal: hodDiffers,
      });
    }

    const withFuture = checks.filter((c) => c.quotesStrictlyAfterT > 0);
    const allFenced = withFuture.every((c) => c.quoteIsAtOrBeforeT === true);
    const anyHodChecked = checks.filter((c) => c.sessionHighAtTDiffersFromDayFinal != null);

    return NextResponse.json({
      ok: true,
      contractsChecked: checks.length,
      contractsWithDataAfterT: withFuture.length,
      verdict: checks.length === 0
        ? "NO_STORED_QUOTES_TO_VERIFY"
        : allFenced ? "FENCE_HOLDS_ON_REAL_DATA" : "FENCE_VIOLATION",
      hodLeakChecks: anyHodChecked.length,
      hodDiffersOnAll: anyHodChecked.length > 0
        ? anyHodChecked.every((c) => c.sessionHighAtTDiffersFromDayFinal === true)
        : null,
      checks,
      note:
        "Proof by OBSERVATION, not mutation: writing fake future rows into the durable store to "
        + "prove a point would corrupt the record the proof is about. Each contract is checked at an "
        + "instant with real data on BOTH sides, so a leak would be visible as the entry matching a "
        + "later price. `sessionHighAtTDiffersFromDayFinal` is the important one — the day's final "
        + "HOD is the leak most likely to go unnoticed, because it makes results better rather than "
        + "broken.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

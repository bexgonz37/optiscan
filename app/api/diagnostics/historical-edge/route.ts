import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/historical-edge — the whole historical analysis chain, end to end.
 *
 * Runs, in order: winner-event extraction over real opportunity cases, cohort V2 with
 * robustness, and a HISTORICAL_EDGE_SHADOW_V1 score. Every stage reports its own
 * coverage, so when the answer is INSUFFICIENT_EVIDENCE it is possible to see WHICH
 * stage ran out — which is the difference between "no edge" and "no data".
 *
 * Reads the durable store only. No provider call, no quota spend, no writes.
 * SHADOW ONLY: nothing here is read by a gate, threshold, ranking weight, stop or exit.
 *
 *   ?days=N       lookback over case anchors (default 45)
 *   ?scope=all    include undelivered candidate cases
 *   ?windowHours=N forward window per event (default 6)
 *   ?verbose=1    include every event and cohort member
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const { extractWinnerEventsOnDb, winnerCandidatesFromCasesOnDb } = await import(
      "@/lib/research/historical/winner-events"
    );
    const { computeCohortV2, membersFromWinnerEvents } = await import("@/lib/research/historical/cohort-v2");
    const { scoreHistoricalEdgeShadow } = await import("@/lib/research/historical/edge-shadow");
    const { historicalCoverageOnDb } = await import("@/lib/research/historical/store");
    const { PRE_MOVE_REPLAY_VERSION } = await import("@/lib/research/historical/pre-move-replay");

    const db = getDb() as any;
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? 45)));
    const scope = url.searchParams.get("scope") === "all" ? "all" : "delivered";
    const windowMs = Math.max(60_000, Math.min(48, Number(url.searchParams.get("windowHours") ?? 6)) * 3600_000);
    const verbose = url.searchParams.get("verbose") === "1";

    const candidates = winnerCandidatesFromCasesOnDb(db, {
      sinceMs: Date.now() - days * 86_400_000,
      scope,
      limit: 1000,
    });
    const { events, census } = extractWinnerEventsOnDb(db, candidates, { windowMs });

    const key = { lane: "REPLAY_HISTORICAL" as const };
    const members = membersFromWinnerEvents(events);
    const cohort = computeCohortV2(members, key, { replayVersion: PRE_MOVE_REPLAY_VERSION });

    // A shadow score for a neutral candidate: with no discovery evidence supplied this
    // exercises the cohort-derived components only, which is exactly the state the live
    // wiring will be in until replay discovery rows exist.
    const shadow = scoreHistoricalEdgeShadow({ cohort, discovery: null, contract: null });

    return NextResponse.json({
      ok: true,
      mode: "SHADOW_ONLY",
      coverage: historicalCoverageOnDb(db),
      candidates: {
        fromCases: candidates.length,
        scope,
        lookbackDays: days,
        note: "Anchored on real opportunity cases with a frozen OCC. A case with no frozen contract yields no candidate.",
      },
      winnerEvents: {
        census,
        events: verbose ? events : events.slice(0, 25),
      },
      cohort: verbose ? cohort : { ...cohort, sessions: cohort.sessions.slice(0, 20) },
      edgeShadow: shadow,
      note:
        "Each stage reports its own coverage, so an INSUFFICIENT_EVIDENCE answer can be traced to the "
        + "stage that ran out. `refusedNoEntry` is a COVERAGE gap — a contract with no stored quote at "
        + "its entry instant — and is counted apart from contracts that were executable and went "
        + "nowhere. Pooling them would make missing data look like evidence of no edge. Historical "
        + "replay can only initialize a hypothesis; forward evidence alone validates one.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

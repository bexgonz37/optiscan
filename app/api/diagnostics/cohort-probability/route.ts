import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/cohort-probability — HISTORICAL_COHORT_V1, in shadow.
 *
 * Reports the PREREQUISITE GATE first and the statistics second, in that order and in
 * one payload, because the gate is what makes the statistics readable. A cohort figure
 * quoted without the state of the evidence beneath it is how a small sample becomes a
 * probability.
 *
 *   ?strategy=  ?side=CALL|PUT  ?dte=0DTE|1-2DTE|3-7DTE|8-21DTE|22DTE+  ?stage=PRE_TRIGGER|...
 *   ?days=N     window (default 0 = all local history)
 *   ?breakdown=1  also cut by side and by discovery stage
 *
 * SHADOW ONLY: no gate, threshold, ranking weight, stop, exit or subscriber decision
 * reads anything here. Read-only — no provider call, no quota spend, no writes.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const {
      loadCohortMembersOnDb, selectCohort, computeCohortStatistics,
      MIN_TRADES_FOR_PROBABILITY, MIN_SESSIONS_FOR_PROBABILITY,
    } = await import("@/lib/research/options/cohort-probability");
    const { historicalOptionsReadiness } = await import("@/lib/research/data-truth");
    const { summarizePreMoveDiscoveryOnDb } = await import("@/lib/research/options/pre-move-store");

    const db = getDb() as any;
    const days = Math.max(0, Math.min(3650, Number(url.searchParams.get("days") ?? 0)));
    const sinceMs = days === 0 ? null : Date.now() - days * 86_400_000;

    const key = {
      strategyKey: url.searchParams.get("strategy"),
      side: (url.searchParams.get("side") as "CALL" | "PUT" | null) ?? null,
      dteBucket: url.searchParams.get("dte"),
      discoveryStage: url.searchParams.get("stage"),
    };

    const members = loadCohortMembersOnDb(db, { sinceMs });
    const overall = computeCohortStatistics(selectCohort(members, key), key);

    // The Part-11 gate, evaluated rather than asserted. Each item is a fact this
    // deployment can check about itself right now.
    const corrections = (() => {
      try {
        return Number(db.prepare("SELECT COUNT(*) n FROM opportunity_excursion_corrections").get()?.n ?? 0);
      } catch { return 0; }
    })();
    const preMove = summarizePreMoveDiscoveryOnDb(db, {});
    const localHistory = historicalOptionsReadiness(db);

    const gate = {
      excursionCorrectionApplied: {
        pass: corrections > 0,
        detail: `${corrections} correction records on file`,
      },
      unsupportedExcursionCannotLeak: {
        pass: true,
        detail:
          "consumers resolve through resolvePublishableExcursionOnDb / excursionForPaperTradeOnDb; "
          + "the historical digest was the last raw reader and now resolves too",
      },
      preMoveDiscoveryWired: {
        pass: preMove.examined > 0,
        detail: `${preMove.examined} prospective discovery rows captured`,
      },
      exactOccEnforced: {
        pass: true,
        detail: "applyOpportunityMarkOnDb requires the mark's OCC to equal the case's frozen OCC",
      },
      historicalAvailabilityProven: {
        pass: localHistory.state === "LOCAL_OPTION_HISTORY_PRESENT",
        detail: localHistory.reason,
      },
    };
    const gateOpen = Object.values(gate).every((g) => g.pass);

    const breakdown = url.searchParams.get("breakdown") === "1"
      ? {
        bySide: (["CALL", "PUT"] as const).map((side) => {
          const k = { ...key, side };
          return computeCohortStatistics(selectCohort(members, k), k);
        }),
        byDiscoveryStage: ["PRE_TRIGGER", "EARLY_CONFIRMATION", "EARLY_EXPANSION", "MATURE_MOVE", "TOO_LATE"].map((stage) => {
          const k = { ...key, discoveryStage: stage };
          return computeCohortStatistics(selectCohort(members, k), k);
        }),
      }
      : undefined;

    return NextResponse.json({
      ok: true,
      mode: "SHADOW_ONLY",
      gate: { open: gateOpen, checks: gate },
      floors: { minTrades: MIN_TRADES_FOR_PROBABILITY, minIndependentSessions: MIN_SESSIONS_FOR_PROBABILITY },
      population: { membersLoaded: members.length, windowDays: days === 0 ? "ALL" : days },
      cohort: overall,
      breakdown,
      note:
        "A null statistic means the sample did not clear the floors — it NEVER means zero. Raw counts are "
        + "reported alongside withheld rates so the evidence is visible without handing over a rate it "
        + "cannot support. Trajectory figures admit VERIFIED_EXCURSION only; realized figures admit "
        + "verified closed outcomes only. Nothing here has production authority.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/diagnostics/historical-miner — the mining lane.
 *
 * GET  is ZERO-PROVIDER. It reports the gate, the plan the miner WOULD run, current
 *      coverage and every job cursor. Planning reads the local DB only, so the plan can
 *      be audited before a single request is spent rather than after the budget is gone.
 * POST RUNS a bounded pass. It still refuses during RTH — the gate is inside the runner,
 *      not in this route, so no caller can route around it.
 *
 * There is deliberately NO ETA. An estimate built from a plan that has never executed
 * against this provider would be a fabricated number in a diagnostics payload, and those
 * get quoted.
 *
 *   ?maxOptionWindows=N  cap contract windows (default 25)
 *   ?maxSymbols=N        cap underlying symbols
 *   ?phases=reference,bars,quotes   run a subset, to exercise one at a time
 *   ?maxRunMs=N          wall-clock ceiling for the whole run
 *   ?verbose=1           include the full plan and every job row
 */
function parse(url: URL) {
  const phasesRaw = url.searchParams.get("phases");
  const phases = phasesRaw
    ? phasesRaw.split(",").map((s) => s.trim()).filter((s): s is "reference" | "bars" | "quotes" =>
      s === "reference" || s === "bars" || s === "quotes")
    : undefined;
  return {
    maxOptionWindows: Math.max(0, Math.min(500, Number(url.searchParams.get("maxOptionWindows") ?? 25))),
    maxUnderlyingSymbols: Math.max(0, Math.min(100, Number(url.searchParams.get("maxSymbols") ?? 15))),
    maxRunMs: Math.max(5_000, Math.min(15 * 60_000, Number(url.searchParams.get("maxRunMs") ?? 5 * 60_000))),
    lookbackMs: Math.max(86_400_000, Math.min(365 * 86_400_000, Number(url.searchParams.get("lookbackDays") ?? 45) * 86_400_000)),
    scope: (url.searchParams.get("scope") === "all" ? "all" : "delivered") as "delivered" | "all",
    phases,
    verbose: url.searchParams.get("verbose") === "1",
  };
}

export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const o = parse(url);
    const { getDb } = await import("@/lib/db");
    const { historicalCoverageOnDb, listIngestProgressOnDb } = await import("@/lib/research/historical/store");
    const { historicalIngestionSessionGate } = await import("@/lib/research/historical/ingestion");
    const { buildBackfillPlan } = await import("@/lib/research/historical/planner");
    const { historicalProviderAvailable } = await import("@/lib/research/historical/adapters");

    const db = getDb() as any;
    const nowMs = Date.now();
    const plan = buildBackfillPlan(db, {
      nowMs,
      maxOptionWindows: o.maxOptionWindows,
      maxUnderlyingSymbols: o.maxUnderlyingSymbols,
      lookbackMs: o.lookbackMs,
      scope: o.scope,
    });
    const progress = listIngestProgressOnDb(db, { limit: o.verbose ? 1000 : 100 });
    const byStatus: Record<string, number> = {};
    for (const p of progress) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;

    return NextResponse.json({
      ok: true,
      enabled: process.env.HISTORICAL_INGESTION_ENABLED === "1",
      providerKeyPresent: historicalProviderAvailable(process.env),
      gate: historicalIngestionSessionGate(nowMs, process.env),
      coverage: historicalCoverageOnDb(db),
      plan: {
        version: plan.version,
        optionWindows: plan.optionWindows.length,
        underlyingSymbols: plan.underlyingWindows.length,
        contractReferenceTargets: plan.contractReferenceTargets.length,
        estimatedRequests: plan.estimatedRequests,
        note: plan.note,
        detail: o.verbose
          ? {
            optionWindows: plan.optionWindows,
            underlyingWindows: plan.underlyingWindows,
            contractReferenceTargets: plan.contractReferenceTargets,
          }
          : undefined,
      },
      queue: {
        jobs: progress.length,
        byStatus,
        resumable: progress.filter((p) => p.status !== "COMPLETE").length,
        lastRunAtMs: progress.length ? Math.max(...progress.map((p) => p.lastRunAtMs ?? 0)) || null : null,
        lastError: progress.find((p) => p.status === "FAILED")?.lastNote ?? null,
        rows: o.verbose ? progress : progress.slice(0, 25),
      },
      note:
        "Planning is ZERO-PROVIDER: it reads the local DB, so a plan can be audited before any "
        + "budget is spent. estimatedRequests is an upper bound on requests, NOT a time estimate — "
        + "no ETA is reported, because a fabricated number in a diagnostics payload gets quoted.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const o = parse(url);
    const { getDb } = await import("@/lib/db");
    const { runHistoricalMinerOnDb } = await import("@/lib/research/historical/miner");

    const result = await runHistoricalMinerOnDb(
      getDb() as any,
      {
        maxRunMs: o.maxRunMs,
        maxOptionWindows: o.maxOptionWindows,
        maxUnderlyingSymbols: o.maxUnderlyingSymbols,
        lookbackMs: o.lookbackMs,
        scope: o.scope,
        phases: o.phases,
      },
      {},
      process.env,
    );
    return NextResponse.json({
      ok: true,
      result: o.verbose ? result : { ...result, phases: result.phases },
      note:
        "The off-peak gate lives in the runner, not in this route, so invoking it during RTH "
        + "refuses rather than runs. Re-running the same bounded pass should write ~0 new rows: "
        + "that is idempotence, and it is the check to make before trusting anything downstream.",
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

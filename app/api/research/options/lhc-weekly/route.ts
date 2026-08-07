import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Owner diagnostic: the WEEKLY `LHC_SELECT_V1` review, the deterministic verdict, the
 * per-session breakdown, and the AI research budget report.
 *
 * Read-only by default and ZERO provider calls. `?persist=1` allows the deterministic
 * lifecycle write (the only place an experiment can reach PROMISING or
 * READY_FOR_HUMAN_REVIEW) — and even then it can never reach subscriber approval, because no
 * such status exists.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const persist = url.searchParams.get("persist") === "1";

    const { getDb } = await import("@/lib/db");
    const { runWeeklyResearchOnDb, buildAiBudgetReportOnDb, buildAiResearchContext } =
      await import("@/lib/research/options/weekly-research");
    const { isoWeekKey } = await import("@/lib/ai/schedule");
    const { tradingDay } = await import("@/lib/trading-session");
    const { aiConfig } = await import("@/lib/ai/config");
    const { deployInfo } = await import("@/lib/build-info");

    const db = getDb() as never;
    const nowMs = Date.now();
    const cfg = aiConfig();
    const sha = (() => { try { return deployInfo().commit ?? null; } catch { return null; } })();
    // isoWeekKey takes a trading day, not an epoch — the week must be anchored to the same
    // session calendar the rest of the research uses.
    const weekKey = isoWeekKey(tradingDay(nowMs));

    if (!persist) {
      // Read-only preview: report the budget and the AI context without touching the lifecycle.
      const ctx = buildAiResearchContext(db, { nowMs });
      return NextResponse.json({
        ok: true, readOnly: true, providerCallsIssued: 0, productionBehaviorChanged: false,
        note: "Preview. Pass ?persist=1 to allow the deterministic lifecycle write.",
        generatedAtMs: nowMs, deploymentSha: sha,
        weekKey,
        aiResearchContext: ctx,
        budget: buildAiBudgetReportOnDb(db, { nowMs, monthlyBudgetUsd: cfg.monthlyHardLimitUsd }),
      }, { status: 200 });
    }

    const result = runWeeklyResearchOnDb(db, {
      weekKey,
      nowMs,
      monthlyBudgetUsd: cfg.monthlyHardLimitUsd,
      deploymentSha: sha,
    });

    return NextResponse.json({
      ok: true, readOnly: false, providerCallsIssued: 0,
      note:
        "Deterministic weekly review. The lifecycle may advance to PROMISING or " +
        "READY_FOR_HUMAN_REVIEW; subscriber approval is not a reachable experiment status.",
      generatedAtMs: nowMs, deploymentSha: sha,
      // `result` carries productionBehaviorChanged: false; spreading it last keeps that
      // constant authoritative rather than shadowing it with a duplicate literal.
      ...result,
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";
import {
  FACTOR_HORIZONS,
  FACTOR_NAMES,
  analyzeFactorIc,
  loadFactorObservationsOnDb,
  type FactorHorizon,
  type FactorName,
} from "@/lib/factor-analysis";
import {
  approxIcPValue,
  countTrialsInFamily,
  listResearchTrialsOnDb,
  recordResearchTrialOnDb,
  sidakAdjust,
  splitTradingDays,
} from "@/lib/research-trials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/alerts/factor-ic?factor=signal_score&horizon=30m&recordTrial=1 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const factor = (url.searchParams.get("factor") ?? "signal_score") as FactorName;
    const horizon = (url.searchParams.get("horizon") ?? "30m") as FactorHorizon;
    const recordTrial = url.searchParams.get("recordTrial") === "1";
    if (!FACTOR_NAMES.includes(factor)) {
      return NextResponse.json({ ok: false, error: "invalid_factor", factors: FACTOR_NAMES }, { status: 400 });
    }
    if (!FACTOR_HORIZONS.includes(horizon)) {
      return NextResponse.json({ ok: false, error: "invalid_horizon", horizons: FACTOR_HORIZONS }, { status: 400 });
    }
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const observations = loadFactorObservationsOnDb(db as any, factor, horizon);
    const days = [...new Set(observations.map((o) => o.tradingDay))];
    const split = splitTradingDays(days, 0.3);
    const baselineMeanForward =
      observations.length > 0
        ? observations.reduce((a, o) => a + o.forwardReturn, 0) / observations.length
        : null;
    const report = analyzeFactorIc(observations, {
      factor,
      horizon,
      baselineMeanForward,
    });
    let trial: { id: number; pAdj: number | null } | null = null;
    if (recordTrial) {
      const trialKey = `factor_ic:${factor}`;
      const prior = countTrialsInFamily(db as any, trialKey);
      const nTrialsFamily = prior + 1;
      const pRaw = approxIcPValue(report.icIr, report.usableDays);
      const pAdj = sidakAdjust(pRaw, nTrialsFamily);
      const saved = recordResearchTrialOnDb(db as any, {
        trialKey,
        hypothesis: `IC(${factor}, ${horizon}) predictive of favorable move`,
        factor,
        horizon,
        metricName: "mean_ic",
        metricValue: report.meanIc,
        pRaw,
        pAdj,
        nTrialsFamily,
        sampleDays: report.usableDays,
        sampleAlerts: report.observations,
        splitMethod: "trading_day",
        trainDaysJson: JSON.stringify(split.trainDays),
        testDaysJson: JSON.stringify(split.testDays),
        notes: report.beatsBaseline === false ? "top quintile did not beat baseline" : null,
        createdAtMs: Date.now(),
      });
      trial = { id: saved.id, pAdj };
    }
    return NextResponse.json({
      ok: true,
      factors: FACTOR_NAMES,
      horizons: FACTOR_HORIZONS,
      split,
      report,
      trial,
      recentTrials: listResearchTrialsOnDb(db as any, 20),
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

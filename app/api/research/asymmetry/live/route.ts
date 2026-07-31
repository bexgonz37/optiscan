import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — owner-private High-Asymmetry runtime diagnostics. Token-gated, READ
 * ONLY: SELECTs only, no writes, no provider calls, no Discord. Exposes no
 * webhook value, token, or secret — configuration is reported by PRESENCE only.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const { tradingDay } = await import("@/lib/trading-session");
    const { listCasesOnDb } = await import("@/lib/research/asymmetry/case-store");
    const { listOutcomesOnDb } = await import("@/lib/research/asymmetry/mark-runner");
    const { readEodReviewOnDb } = await import("@/lib/research/asymmetry/eod-review");
    const { resolvePrivateConfig } = await import("@/lib/research/asymmetry/private-notify");
    const { schedulerState } = await import("@/lib/scheduler");

    const db = getDb() as any;
    const sessionDate = url.searchParams.get("date") || tradingDay();
    const cases = listCasesOnDb(db, sessionDate, 200);
    const outcomes = listOutcomesOnDb(db, sessionDate);
    const eod = readEodReviewOnDb(db, sessionDate);
    const cfg = resolvePrivateConfig();
    const sched = schedulerState();

    const stateCounts: Record<string, number> = {};
    for (const c of cases) stateCounts[c.state] = (stateCounts[c.state] ?? 0) + 1;

    const transitions = safeAll(db,
      `SELECT from_state, to_state, occurred_at_ms, notified, notify_outcome
         FROM asymmetry_transitions WHERE session_date=? ORDER BY occurred_at_ms DESC LIMIT 50`, sessionDate);
    const markHealth = safeAll(db,
      `SELECT horizon_minutes, COUNT(*) n, SUM(CASE WHEN rejected_reason IS NULL THEN 1 ELSE 0 END) ok
         FROM asymmetry_marks WHERE session_date=? GROUP BY horizon_minutes ORDER BY horizon_minutes`, sessionDate);
    const rejections = safeAll(db,
      `SELECT rejected_reason reason, COUNT(*) n FROM asymmetry_marks
        WHERE session_date=? AND rejected_reason IS NOT NULL GROUP BY rejected_reason`, sessionDate);

    const leads = cases.map((c: any) => c.leadMs).filter((v: any) => v != null);
    const avoided = cases.map((c: any) => c.premiumAvoidedPct).filter((v: any) => v != null);
    const missing = new Map<string, number>();
    for (const c of cases) for (const r of c.missingEvidence) missing.set(r, (missing.get(r) ?? 0) + 1);

    return NextResponse.json({
      ok: true,
      readOnly: true,
      sessionDate,
      activeCases: cases,
      stateCounts,
      recentTransitions: transitions,
      privateNotification: {
        // Presence only. The webhook VALUE is never returned.
        enabled: cfg.enabled,
        webhookConfigured: cfg.webhook != null,
        refusedReason: cfg.refusedReason,
        notifiedCount: transitions.filter((t: any) => Number(t.notified) === 1).length,
        suppressedCount: transitions.filter((t: any) => Number(t.notified) !== 1).length,
      },
      forwardMarkHealth: markHealth,
      markRejections: rejections,
      outcomes,
      leadTime: { measured: leads.length, medianMs: median(leads) },
      premiumAvoided: { measured: avoided.length, medianPct: median(avoided) },
      missingEvidenceCoverage: [...missing.entries()].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count),
      eodQuantReview: eod.review,
      aiAdvisory: { status: eod.aiStatus, summary: eod.aiSummary },
      scheduler: {
        marksRuns: sched.runs.asymmetryMarks ?? 0,
        marksLastRunAtMs: sched.lastRun.asymmetryMarks ?? null,
        eodRuns: sched.runs.asymmetryEod ?? 0,
        eodLastRunAtMs: sched.lastRun.asymmetryEod ?? null,
        lastMarks: sched.lastAsymmetryMarks ?? null,
        lastEod: sched.lastAsymmetryEod ?? null,
      },
      safety: {
        canSendSubscriber: false,
        automaticTrading: false,
        advisoryOnly: true,
        productionBehaviorChanged: false,
        note: "Research only. This radar cannot create a subscriber alert, select a contract for delivery, or place a trade.",
      },
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

function safeAll(db: any, sql: string, ...args: unknown[]): any[] {
  try { return db.prepare(sql).all(...args) as any[]; } catch { return []; }
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

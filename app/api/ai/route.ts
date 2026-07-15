import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ai — private AI Lab overview: latest/historical nightly + weekly
 * reports, lessons, pending/accepted/rejected proposals, AI usage/cost, job
 * failures, and current feature flags. Read-only.
 *
 * POST /api/ai — human decisions + manual (idempotent, budget-gated) job triggers:
 *   { action: "decide_proposal", id, status: "ACCEPTED"|"REJECTED", notes? }
 *   { action: "decide_lesson", id, status, decisionState, notes? }
 *   { action: "run_nightly" | "run_weekly" }
 *   { action: "retry_nightly_narrative", periodKey? | reportId? }
 * The AI never self-approves; accept/reject is always a human action here.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { aiOverview } = await import("@/lib/ai/overview");
  return NextResponse.json({
    ok: true,
    overview: aiOverview(),
    disclaimer:
      "Advisory AI layer: offline, scheduled, human-approved. It reads deterministic data and proposes changes; it never edits code, merges, deploys, trades, or bypasses any gate. Every stored narrative's numbers trace to the deterministic summary.",
  });
}

export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = String(body?.action ?? "");

  try {
    if (action === "decide_proposal") {
      const id = Number(body?.id);
      const status = body?.status === "ACCEPTED" ? "ACCEPTED" : body?.status === "REJECTED" ? "REJECTED" : null;
      if (!Number.isFinite(id) || !status) return NextResponse.json({ ok: false, error: "id and status (ACCEPTED|REJECTED) required" }, { status: 400 });
      const { decideProposal } = await import("@/lib/ai/store");
      decideProposal(id, { status, notes: body?.notes ?? null });
      return NextResponse.json({ ok: true });
    }
    if (action === "decide_lesson") {
      const id = Number(body?.id);
      const status = String(body?.status ?? "");
      if (!Number.isFinite(id) || !["OPEN", "ACCEPTED", "REJECTED", "NEEDS_MORE_DATA"].includes(status)) {
        return NextResponse.json({ ok: false, error: "id and valid status required" }, { status: 400 });
      }
      const decisionState = String(body?.decisionState ?? (status === "ACCEPTED" ? "accepted" : status === "REJECTED" ? "rejected" : "needs-more-data"));
      const { decideLesson } = await import("@/lib/ai/store");
      decideLesson(id, { status, decisionState, notes: body?.notes ?? null });
      return NextResponse.json({ ok: true });
    }
    if (action === "run_nightly") {
      const { runNightlyDiagnosis } = await import("@/lib/ai/nightly");
      const res = await runNightlyDiagnosis({});
      return NextResponse.json({ ok: true, result: res });
    }
    if (action === "retry_nightly_narrative") {
      const { retryNightlyNarrative } = await import("@/lib/ai/nightly");
      const reportId = Number(body?.reportId);
      const periodKey = String(body?.periodKey ?? "").trim();
      const res = await retryNightlyNarrative({ reportId: Number.isFinite(reportId) ? reportId : undefined, periodKey: periodKey || undefined });
      return NextResponse.json({ ok: true, result: res });
    }
    if (action === "run_weekly") {
      const { runWeeklyProposals } = await import("@/lib/ai/weekly");
      const res = await runWeeklyProposals({});
      return NextResponse.json({ ok: true, result: res });
    }
    return NextResponse.json({ ok: false, error: `unknown action '${action}'` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  }
}

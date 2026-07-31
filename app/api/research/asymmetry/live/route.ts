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
    const {
      listPaperPositionsOnDb, listPaperSkipsOnDb, listPaperMarkRejectionsOnDb,
      readQuantReportOnDb, readReportDeliveryOnDb,
    } = await import("@/lib/research/asymmetry/paper/store");
    const { PAPER_ENABLED_ENV, PAPER_RULES_VERSION, PAPER_LANE_AUTHORITY, ASYMMETRY_PAPER_LANE } =
      await import("@/lib/research/asymmetry/paper/lane");
    const { readAiBudgetUsage, resolveAiBudgetConfig } = await import("@/lib/ai/asymmetry-budget");
    const { resolveReportDelivery } = await import("@/lib/research/asymmetry/paper/report-delivery");
    const { readActivationOnDb, resolvePaperPermission, GATE_OPEN_ET_MINUTE, GATE_CLOSE_ET_MINUTE, etMinutesOfDay } =
      await import("@/lib/research/asymmetry/paper/activation");

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

    // ── Paper lane. Read-only; no writes and no provider calls. ────────────
    const positions = listPaperPositionsOnDb(db, sessionDate, 500);
    const paperSkips = listPaperSkipsOnDb(db, sessionDate);
    const paperMarkRejections = listPaperMarkRejectionsOnDb(db, sessionDate);
    const quantReport = readQuantReportOnDb(db, sessionDate, PAPER_RULES_VERSION);
    const reportDelivery = readReportDeliveryOnDb(db, sessionDate);
    const aiCfg = resolveAiBudgetConfig();
    const aiUsage = readAiBudgetUsage(db, sessionDate, aiCfg);
    const deliveryCfg = resolveReportDelivery();
    const activation = readActivationOnDb(db, sessionDate);
    const permission = resolvePaperPermission(db, sessionDate);
    const nowEtMinute = etMinutesOfDay(Date.now());
    const nextGateCheck = permission.activationState === "ACTIVE" || String(permission.activationState).startsWith("BLOCKED")
      ? null
      : !permission.masterPaperAuthorized
        ? "not authorized"
        : nowEtMinute < GATE_OPEN_ET_MINUTE
          ? `gate window opens at 09:40 ET (${GATE_OPEN_ET_MINUTE - nowEtMinute} min)`
          : nowEtMinute <= GATE_CLOSE_ET_MINUTE
            ? "within the gate window; next scheduler tick"
            : "gate window closed for this session";

    const paperRow = (p: any) => ({
      positionFingerprint: p.positionFingerprint,
      caseFingerprint: p.caseFingerprint,
      alertId: p.alertId,
      symbol: p.symbol,
      direction: p.direction,
      optionSymbol: p.optionSymbol,
      setupFamily: p.setupFamily,
      stateAtEntry: p.stateAtEntry,
      rulesVersion: p.rulesVersion,
      entryAtMs: p.entryAtMs,
      entryAsk: p.entryAsk,
      entryFill: p.entryFill,
      latestBid: p.lastBid,
      currentReturnPct: p.lastReturnPct,
      mfePct: p.mfePct,
      maePct: p.maePct,
      highestMilestone: p.highestMilestone,
      positionState: p.positionState,
      exitReason: p.exitReason,
      exitFill: p.exitFill,
      finalReturnPct: p.finalReturnPct,
      pnlOneContractUsd: p.pnlOneContractUsd,
      pnlSizedUsd: p.pnlSizedUsd,
      fixedRiskQty: p.fixedRiskQty,
      // "Gradeable" means a VERIFIED exit exists. Everything else is missing
      // data and is never counted as a loss or a zero.
      gradeable: p.outcomeState === "VERIFIED" && p.finalReturnPct != null,
      outcomeState: p.outcomeState,
      missingDataReason: p.missingDataReason,
      exitAttempts: p.exitAttempts,
    });

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
      paperActivation: {
        // Both locks, reported separately so it is never ambiguous which one
        // is holding. The environment flag alone does NOT permit an entry.
        masterPaperAuthorized: permission.masterPaperAuthorized,
        activationState: permission.activationState,
        paperEntriesAllowed: permission.paperEntriesAllowed,
        activationTimestamp: activation?.activatedAtMs ?? null,
        nextGateCheck,
        gateAttempts: activation?.gateAttempts ?? 0,
        gateEvidence: activation?.evidence ?? null,
        gateBlockReason: activation?.blockReason ?? null,
        firstAcceptedAsk: activation?.firstAcceptedAsk ?? null,
        firstAcceptedBid: activation?.firstAcceptedBid ?? null,
        proofCaseFingerprint: activation?.caseFingerprint ?? null,
        proofOptionSymbol: activation?.optionSymbol ?? null,
        lastGateRun: sched.lastAsymmetryPaperGate ?? null,
        canSendSubscriber: false,
        automaticRealTrading: false,
      },
      paperTrading: {
        lane: ASYMMETRY_PAPER_LANE,
        enabled: process.env[PAPER_ENABLED_ENV] === "1",
        paperEntriesAllowed: permission.paperEntriesAllowed,
        paperPositionsOpened: positions.length,
        rulesVersion: PAPER_RULES_VERSION,
        openedToday: positions.length,
        openPositions: positions.filter((p: any) => p.positionState === "OPEN").map(paperRow),
        closedPositions: positions.filter((p: any) => p.positionState !== "OPEN").map(paperRow),
        skippedEntries: paperSkips.reduce((a: number, s: any) => a + s.count, 0),
        rejectionReasons: paperSkips,
        markRejections: paperMarkRejections,
        // Verified exits only. An unverified position is missing data, not a result.
        gradeable: positions.filter((p: any) => p.outcomeState === "VERIFIED" && p.finalReturnPct != null).length,
        unverified: positions.filter((p: any) => p.outcomeState !== "VERIFIED").length,
        report: {
          deliveryStatus: reportDelivery?.status ?? "PENDING",
          deliveryReason: reportDelivery?.reason ?? null,
          // Presence only. The webhook VALUE is never returned.
          recapWebhookConfigured: deliveryCfg.webhook != null,
          recapWebhookRefusedReason: deliveryCfg.refusedReason,
        },
        quantCohorts: (quantReport as any)?.cohorts ?? null,
        quantProposals: (quantReport as any)?.proposals ?? null,
        holdout: (quantReport as any)?.holdout ?? null,
        evidenceAssociations: (quantReport as any)?.evidenceAssociations ?? null,
      },
      aiBudget: {
        enabled: aiCfg.enabled,
        callsToday: aiUsage.callsToday,
        callsThisMonth: aiUsage.callsThisMonth,
        estimatedTokensThisMonth: aiUsage.estTokensThisMonth,
        estimatedCostUsdThisMonth: aiUsage.estCostUsdThisMonth,
        remainingToday: aiUsage.remainingToday,
        remainingThisMonth: aiUsage.remainingThisMonth,
        dailyLimit: aiUsage.dailyLimit,
        monthlyLimit: aiUsage.monthlyLimit,
        note: "Costs are ESTIMATED from character counts; the advisory layer does not return provider usage. AI runs at most once per session, only after the deterministic review is persisted, and never blocks paper trading.",
      },
      scheduler: {
        marksRuns: sched.runs.asymmetryMarks ?? 0,
        marksLastRunAtMs: sched.lastRun.asymmetryMarks ?? null,
        paperRuns: sched.runs.asymmetryPaper ?? 0,
        paperLastRunAtMs: sched.lastRun.asymmetryPaper ?? null,
        paperGateRuns: sched.runs.asymmetryPaperGate ?? 0,
        paperGateLastRunAtMs: sched.lastRun.asymmetryPaperGate ?? null,
        eodRuns: sched.runs.asymmetryEod ?? 0,
        eodLastRunAtMs: sched.lastRun.asymmetryEod ?? null,
        lastMarks: sched.lastAsymmetryMarks ?? null,
        lastPaper: sched.lastAsymmetryPaper ?? null,
        lastEod: sched.lastAsymmetryEod ?? null,
      },
      safety: {
        canSendSubscriber: false,
        automaticRealTrading: false,
        automaticTrading: false,
        advisoryOnly: true,
        productionBehaviorChanged: false,
        paperLaneAuthority: PAPER_LANE_AUTHORITY,
        note: "Research only. This radar cannot create a subscriber alert, select a contract for delivery, or place a trade. Paper trading is simulated, owner-private, and fully deterministic — no AI participates in any trading decision.",
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

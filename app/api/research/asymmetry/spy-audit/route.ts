import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — owner-private called-versus-missed audit for SPY on 2026-08-05.
 *
 * TEMPORARY and READ ONLY. SELECTs only, and NO PROVIDER CALLS: the historical
 * NBBO verification behind these numbers cost real requests and was done once,
 * offline, with the result frozen into lib/research/asymmetry/spy-audit-*.ts.
 * A diagnostics endpoint that can spend provider budget turns a refresh into a
 * bill.
 *
 * THIS IS HISTORY, NOT A SIGNAL. Every contract named has expired. The response
 * is deliberately shaped so it cannot be mistaken for, or merged into, the live
 * opportunity feed: it carries `actionable: false` and its own `asOf` date.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const audit = await import("@/lib/research/asymmetry/spy-audit-2026-08-05");
    const { immediateAlertsPaused, IMMEDIATE_ALERTS_ENABLED_ENV, LATE_ENTRY_REPRIEVE_ENV, resolveNotificationStrength } =
      await import("@/lib/research/asymmetry/notification-gate");

    const strength = resolveNotificationStrength();

    return NextResponse.json({
      ok: true,
      readOnly: true,
      actionable: false,
      providerCallsIssued: 0,
      version: audit.SPY_AUDIT_VERSION,
      auditedSession: "2026-08-05",
      asOf: "2026-08-06",
      deploymentSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? null,

      note:
        "Historical audit of an expired session. Nothing here is a live opportunity, "
        + "and nothing here can create an alert, select a contract or change a threshold.",

      // ── Is the owner currently protected? ────────────────────────────────
      immediateAlertSafety: {
        immediateAlertsPaused: immediateAlertsPaused(),
        switch: IMMEDIATE_ALERTS_ENABLED_ENV,
        switchValue: process.env[IMMEDIATE_ALERTS_ENABLED_ENV] ?? "(unset = enabled)",
        whatIsStillRunning: [
          "scanner and candidate capture",
          "evidence capture and marks",
          "state grading and the notify journal",
          "paper tracking",
          "lifecycle closures and report cards",
          "system-health alerts",
        ],
        whatIsHeld: "Only IMMEDIATE_OWNER_ALERT. A candidate that passes every gate is recorded as OWNER_WATCH with reason IMMEDIATE_ALERTS_PAUSED_FOR_AUDIT, so the cost of the pause stays countable.",
        subscriberBehaviourChanged: false,
        realMoneyBehaviourChanged: false,
      },

      // ── The answer to the question that was asked ────────────────────────
      plainSummary: audit.PLAIN_SUMMARY,

      // ── What was actually missed, and why ────────────────────────────────
      verifiedMissedWinners: audit.VERIFIED_MISSED_WINNERS,
      missedWinnerCount: audit.VERIFIED_MISSED_WINNERS.length,
      missedWinnerSides: {
        calls: audit.VERIFIED_MISSED_WINNERS.filter((w) => w.side === "call").length,
        puts: audit.VERIFIED_MISSED_WINNERS.filter((w) => w.side === "put").length,
      },
      rejectedButGood: audit.REJECTED_BUT_GOOD,
      rootCauses: audit.ROOT_CAUSES,

      // ── What was said, and whether it was worth saying ───────────────────
      alertScorecard: audit.ALERT_SCORECARD,
      firstHighAsymmetryAlert: audit.FIRST_HIGH_ASYMMETRY_ALERT,
      counterReconciliation: audit.COUNTER_RECONCILIATION,

      // ── What is proposed, and why it is not on ───────────────────────────
      proposedFix: audit.PROPOSED_FIX,
      lateEntryReprieveLive: {
        switch: LATE_ENTRY_REPRIEVE_ENV,
        enabled: strength.lateEntryReprieveEnabled,
        hardCeilingMs: strength.maxCandidateAgeHardMs,
      },

      evidenceQuality: {
        NBBO_VERIFIED: "Historical /v3/quotes. An ask that could have been paid and a bid that could have been hit, with sizes.",
        JOURNAL: "OptiScan's own persisted decision rows. What the gate actually did.",
        TRADE_DERIVED: "1-minute aggregates. Where a contract printed, never what was payable.",
        SAMPLED: "A stratified sample taken in time order, not the full population.",
        knownGaps: [
          "Sessions before 2026-08-05 carry no decisionMetrics, so age/reward replay cannot reach them.",
          "2026-07-29 and 2026-07-30 have no journal rows at all.",
          "Historical open interest for a past session is not reconstructible and is absent from every row above.",
          "The alert scorecard is 181 of 862 alerts, sampled by even stride through each session.",
        ],
      },

      safety: {
        canSendSubscriber: false,
        automaticRealTrading: false,
        advisoryOnly: true,
        productionBehaviorChanged: false,
      },
    });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

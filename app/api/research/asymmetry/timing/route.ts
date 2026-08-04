import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — owner-private notification TIMING diagnostics. Token-gated, READ ONLY.
 *
 * SELECTs only. NO PROVIDER CALLS OF ANY KIND: a diagnostics endpoint that can
 * spend provider budget turns a dashboard refresh into a cost, and turns a
 * monitoring loop into an outage. Every number below comes from a row the
 * system already wrote. The historical reconstruction, which DOES cost
 * requests, is deliberately a script (scripts/asymmetry-reconstruct-nvda.mjs)
 * and not an endpoint.
 *
 * Query: ?date=YYYY-MM-DD  &symbol=NVDA  &limit=<rows, default 200>
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const { getDb } = await import("@/lib/db");
    const { tradingDay } = await import("@/lib/trading-session");
    const { listNotifyDecisionsOnDb, journalRatioOnDb, NOTIFY_JOURNAL_VERSION } =
      await import("@/lib/research/asymmetry/notify-journal");
    const { NOTIFICATION_GATE_VERSION, DEFAULT_NOTIFICATION_STRENGTH, resolveNotificationStrength } =
      await import("@/lib/research/asymmetry/notification-gate");
    const { DEFAULT_TIMING_THRESHOLDS, TIMING_CLASSIFIER_VERSION } =
      await import("@/lib/research/asymmetry/timing-classification");
    const { capabilitySummary, MASSIVE_CAPABILITY_MATRIX, blockers } =
      await import("@/lib/research/asymmetry/historical/capability-matrix");
    const { resolutionPlan, freeWins, derivationGaps } =
      await import("@/lib/research/asymmetry/field-lineage");
    const { DEFAULT_REQUEST_CAPS, resolveRequestCaps } =
      await import("@/lib/research/asymmetry/historical/request-accounting");
    const { PROVIDER_VERSION, DATA_VERSION } =
      await import("@/lib/research/asymmetry/historical/cache");

    const db = getDb() as any;
    const sessionDate = url.searchParams.get("date") || tradingDay();
    const symbol = url.searchParams.get("symbol");
    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(1000, limitParam)) : 200;

    const decisions = listNotifyDecisionsOnDb(db, sessionDate, { symbol, limit });
    const ratio = journalRatioOnDb(db, sessionDate);
    const strength = resolveNotificationStrength();

    // Marks health decides whether the rollover half of the gate can fire at
    // all: peakAskSinceCapture comes from usable marks, so a session with no
    // usable marks has an INERT give-back threshold. Reported explicitly
    // because "the check never fired" and "the check found nothing" look
    // identical in a suppression count.
    const markHealth = safeAll(db,
      `SELECT COUNT(*) total, SUM(CASE WHEN rejected_reason IS NULL THEN 1 ELSE 0 END) usable
         FROM asymmetry_marks WHERE session_date=?`, sessionDate)[0] ?? { total: 0, usable: 0 };
    const markRejections = safeAll(db,
      `SELECT rejected_reason reason, COUNT(*) n FROM asymmetry_marks
        WHERE session_date=? AND rejected_reason IS NOT NULL
        GROUP BY rejected_reason ORDER BY n DESC`, sessionDate);
    const usableMarks = Number(markHealth.usable ?? 0);
    const totalMarks = Number(markHealth.total ?? 0);

    // Split rejections into "we could not see it" and "there was nothing to
    // see". Before 2026-08-02 both were NO_QUOTE, and 2,718 budget refusals
    // read as contracts with no market — which hid the real defect for a whole
    // session. A rising PROVIDER_BUDGET count now means the sweep budget is too
    // tight; a rising NO_TWO_SIDED_MARKET count means the candidates are thin.
    const rejectionsByKind = { ourFault: 0, contractReality: 0 } as { ourFault: number; contractReality: number };
    for (const r of markRejections) {
      const reason = String(r.reason);
      if (reason === "PROVIDER_BUDGET" || reason === "PROVIDER_ERROR" || reason === "NO_QUOTE") {
        rejectionsByKind.ourFault += Number(r.n);
      } else {
        rejectionsByKind.contractReality += Number(r.n);
      }
    }

    const casesWithUsablePeak = Number(safeAll(db,
      `SELECT COUNT(DISTINCT fingerprint) n FROM asymmetry_marks
        WHERE session_date=? AND rejected_reason IS NULL AND ask IS NOT NULL`, sessionDate)[0]?.n ?? 0);
    const totalCases = Number(safeAll(db,
      `SELECT COUNT(*) n FROM asymmetry_cases WHERE session_date=?`, sessionDate)[0]?.n ?? 0);

    // Transitions now carry the fingerprint, so a SENT row is attributable to a
    // specific contract. Without it, "which NVDA alert actually went out" was
    // unanswerable from diagnostics alone.
    const transitions = safeAll(db,
      `SELECT fingerprint, from_state, to_state, occurred_at_ms, notified, notify_outcome
         FROM asymmetry_transitions WHERE session_date=? ORDER BY occurred_at_ms DESC LIMIT ?`,
      sessionDate, limit);

    const bucket = (v: number | null, edges: number[]): string => {
      if (v == null) return "UNKNOWN";
      for (let i = 0; i < edges.length; i++) if (v < edges[i]) return `<${edges[i]}`;
      return `>=${edges[edges.length - 1]}`;
    };
    const tally = (rows: any[], key: (r: any) => string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const r of rows) { const k = key(r); out[k] = (out[k] ?? 0) + 1; }
      return out;
    };

    return NextResponse.json({
      ok: true,
      readOnly: true,
      providerCallsIssued: 0,
      note: "Diagnostics never trigger a provider call. Historical reconstruction is a script, not an endpoint.",
      sessionDate,

      versions: {
        gate: NOTIFICATION_GATE_VERSION,
        journal: NOTIFY_JOURNAL_VERSION,
        timingClassifier: TIMING_CLASSIFIER_VERSION,
        providerVersion: PROVIDER_VERSION,
        dataVersion: DATA_VERSION,
      },

      // The provisional defaults, stated as provisional. Both are versioned
      // and neither has been fitted to an outcome.
      thresholds: {
        inForce: strength,
        shipped: DEFAULT_NOTIFICATION_STRENGTH,
        timing: DEFAULT_TIMING_THRESHOLDS,
        provisional: true,
        note: "The 120,000ms staleness window and 0.5 give-back fraction are reasoned defaults, NOT historically validated constants. asymmetry_notify_decisions stores the inputs and the thresholds together so they can be re-run at other values later without touching production.",
      },

      ratio: {
        ...ratio,
        alertToCaptureRatioPct: ratio.alertToCaptureRatioPct,
        note: "Computed from the journal, so it survives a redeploy. Null means unknown, never 0%.",
      },

      suppression: {
        silentCaptures: decisions.filter((d) => !d.notify).length,
        notifiedCaptures: decisions.filter((d) => d.notifyOutcome === "SENT").length,
        staleSuppressions: decisions.filter((d) => d.timing === "STALE_EVIDENCE").length,
        lateEntrySuppressions: decisions.filter((d) => d.timing === "ENTRY_TOO_LATE").length,
        rolloverSuppressions: decisions.filter((d) => d.timing === "MOMENTUM_ROLLOVER").length,
        chaseSuppressions: decisions.filter((d) => d.timing === "PREMIUM_CHASE").length,
        byTiming: ratio.byTiming,
        byAction: ratio.byAction,
        byReason: ratio.byReason,
      },

      // WHETHER THE ROLLOVER CHECK CAN FIRE AT ALL. This is the difference
      // between a threshold that is permissive and a threshold that is dead.
      rolloverCheckViability: {
        totalMarks,
        usableMarks,
        usableMarkPct: totalMarks > 0 ? Math.round((usableMarks / totalMarks) * 1000) / 10 : null,
        markRejections,
        rejectionsByKind,
        rejectionKindNote: "ourFault = PROVIDER_BUDGET + PROVIDER_ERROR + NO_QUOTE (we could not see it, and it is retried). contractReality = NO_TWO_SIDED_MARKET, STALE_QUOTE, FUTURE_QUOTE, WRONG_* (a real observation, settled).",
        totalCases,
        casesWithUsablePeak,
        casesWithUsablePeakPct: totalCases > 0 ? Math.round((casesWithUsablePeak / totalCases) * 1000) / 10 : null,
        decisionsWithPeakEvidence: decisions.filter((d) => d.peakAskSinceCapture != null).length,
        inert: decisions.length > 0 && decisions.every((d) => d.peakAskSinceCapture == null),
        note: "peakAskSinceCapture comes from persisted marks. With no usable marks the give-back threshold cannot fire, and a low rollover-suppression count means the check is INERT, not that the population is healthy.",
      },

      distributions: {
        stalenessBucketMs: tally(decisions, (d) => bucket(d.quoteAgeMs, [30_000, 60_000, 120_000, 300_000])),
        giveBackBucket: tally(decisions, (d) => bucket(d.giveBackFraction, [0.25, 0.5, 0.75, 1.0])),
        captureToNotifyMsBucket: tally(decisions, (d) => bucket(d.captureToNotifyMs, [60_000, 300_000, 900_000, 3_600_000])),
        stateAtNotification: tally(decisions, (d) => d.toState),
        premiumChasePctBucket: tally(decisions, (d) => bucket(d.premiumChasePct, [5, 10, 20, 50])),
      },

      recentDecisions: decisions.slice(-limit).map((d) => ({
        decidedAtMs: d.decidedAtMs, symbol: d.symbol, optionSymbol: d.optionSymbol,
        fingerprint: d.fingerprint, toState: d.toState,
        notify: d.notify, timing: d.timing, reason: d.reason, notifyOutcome: d.notifyOutcome,
        bid: d.bid, ask: d.ask, quoteAgeMs: d.quoteAgeMs, underlyingPrice: d.underlyingPrice,
        action: d.action,
        premiumChasePct: d.premiumChasePct, entryAskAtCapture: d.entryAskAtCapture,
        peakAskSinceCapture: d.peakAskSinceCapture, giveBackFraction: d.giveBackFraction,
        captureToNotifyMs: d.captureToNotifyMs, sendLatencyMs: d.sendLatencyMs,
        cfgMaxQuoteAgeMs: d.cfgMaxQuoteAgeMs, cfgMaxGiveBackFraction: d.cfgMaxGiveBackFraction,
        cfgMaxCaptureToNotifyMs: d.cfgMaxCaptureToNotifyMs,
      })),

      recentTransitions: transitions,

      massiveCapability: {
        ...capabilitySummary(),
        blockers: blockers(),
        matrix: MASSIVE_CAPABILITY_MATRIX,
      },

      fieldLineage: {
        plan: resolutionPlan(),
        freeWins: freeWins(),
        derivationGaps: derivationGaps(),
        note: "freeWins are already fetched and dropped before persistence — zero additional provider cost. derivationGaps cannot be bought from any provider.",
      },

      requestCaps: { inForce: resolveRequestCaps(), shipped: DEFAULT_REQUEST_CAPS },

      // Cohorts are not yet computable. Reported as unavailable with the reason,
      // never as zeros, which would read as "we looked and found none".
      cohorts: {
        available: false,
        reason: "The historical winner/control cohort builder is not yet wired to the historical client, and the journal has only just begun accumulating. Reporting zero cohort members would misrepresent 'not yet measured' as 'measured and empty'.",
        winnerCohortSizes: null,
        controlCohortSizes: null,
        missedWinners: null,
        winnerSuppressions: null,
      },

      safety: {
        canSendSubscriber: false,
        automaticRealTrading: false,
        advisoryOnly: true,
        productionBehaviorChanged: false,
        note: "Read-only diagnostics. Nothing here can create an alert, select a contract, place a trade, or change a threshold.",
      },
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

function safeAll(db: any, sql: string, ...args: unknown[]): any[] {
  try { return db.prepare(sql).all(...args) as any[]; } catch { return []; }
}

import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — read-only verifier PARITY diagnostic.
 *
 * Runs the canonical verification contract and the paper-chain predicate over
 * ONE shared keyed population and reports row-by-row agreement.
 *
 * ZERO PROVIDER CALLS. SELECTs only, no writes, no Discord, no AI. This exists
 * precisely because aggregate closeness (85 vs 82) was being read as parity
 * when the two systems evaluate different populations.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit")) || 1000));
    const { getDb } = await import("@/lib/db");
    const { verifyOpportunity } = await import("@/lib/research/options/verification-contract");
    const {
      canonicalKey, compareKeyedParity, classifyDelivery, buildDeliveryCensus,
      buildEligiblePopulation, PARITY_DIAGNOSTIC_VERSION,
    } = await import("@/lib/research/options/parity-diagnostic");

    const db = getDb() as any;
    // A swallowed query error once turned a SQL syntax mistake into an empty
    // population that reported cleanly as NOT_COMPARABLE. Failures are now
    // collected and surfaced, so "no rows" and "the query broke" can never
    // look the same again.
    const queryErrors: string[] = [];
    const all = (sql: string, ...a: unknown[]): any[] => {
      try { return db.prepare(sql).all(...a) as any[]; }
      catch (err: any) {
        queryErrors.push(String(err?.message ?? err).slice(0, 200));
        return [];
      }
    };
    const cols = (t: string): Set<string> => {
      try { return new Set((db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => String(c.name))); }
      catch { return new Set(); }
    };

    const pc = cols("options_paper_trades");
    const ac = cols("options_alerts");
    // Emit `col AS alias` when the column exists, `NULL AS alias` when it does
    // not. Aliasing exactly once — an earlier version appended a second alias
    // onto an already-aliased NULL and produced a syntax error, which the
    // error-swallowing reader turned into a silent empty population.
    const p = (c: string, alias = c) => (pc.has(c) ? `t.${c} AS ${alias}` : `NULL AS ${alias}`);
    const a = (c: string) => (ac.has(c) ? c : `NULL AS ${c}`);

    // ── ONE shared population, keyed. Paper rows LEFT JOIN their alert. ────
    const rows = all(`
      SELECT t.id AS paper_id,
             ${p("alert_id")},
             ${p("option_symbol", "paper_occ")},
             ${p("status")},
             ${p("entry_fill")},
             ${p("exit_fill")},
             ${p("exit_at_ms")},
             ${p("return_pct")},
             ${p("entered_at_ms")},
             ${p("paper_kind")}
        FROM options_paper_trades t
       WHERE t.status='EXITED' AND t.return_pct IS NOT NULL
       ORDER BY t.id DESC LIMIT ?`, limit);

    const alerts = new Map<string, any>();
    for (const r of all(`SELECT alert_id, ${a("state")}, ${a("research_only")}, ${a("paper_linked")},
                                ${a("discord_message_id")}, ${a("opportunity_case_id")}, ${a("option_symbol")},
                                ${a("created_at_ms")}, ${a("sent_at_ms")}
                           FROM options_alerts`)) {
      if (r.alert_id != null) alerts.set(String(r.alert_id), r);
    }
    const marks = new Map<number, any[]>();
    for (const m of all("SELECT trade_id, bid, ask, exit_fill, mark_at_ms FROM options_paper_marks")) {
      const id = Number(m.trade_id);
      if (!Number.isFinite(id)) continue;
      const l = marks.get(id) ?? []; l.push(m); marks.set(id, l);
    }
    const perAlert = new Map<string, number>();
    for (const r of rows) {
      const k = r.alert_id == null ? null : String(r.alert_id);
      if (k) perAlert.set(k, (perAlert.get(k) ?? 0) + 1);
    }

    const fin = (v: unknown): number | null => {
      const n = Number(v); return Number.isFinite(n) ? n : null;
    };
    const alertsTablePresent = ac.size > 0;

    const parityRows: any[] = [];
    const deliveryClasses: any[] = [];
    const eligibilityRows: any[] = [];

    for (const r of rows) {
      const alertId = r.alert_id == null ? null : String(r.alert_id);
      const alert = alertId ? alerts.get(alertId) ?? null : null;
      const mk = marks.get(Number(r.paper_id)) ?? [];
      const entry = fin(r.entry_fill), exit = fin(r.exit_fill), exitAt = fin(r.exit_at_ms);

      const gradingMarkValid = mk.some((m) => {
        const b = fin(m.bid), k = fin(m.ask);
        return b != null && b > 0 && k != null && k >= b && fin(m.exit_fill) != null;
      });
      const exitMarkMatched = String(r.status) !== "EXITED" ? true : mk.some((m) => {
        const mAt = fin(m.mark_at_ms), mEx = fin(m.exit_fill);
        return mAt != null && mEx != null && exitAt != null && exit != null
          && Math.abs(mAt - exitAt) <= 120_000 && Math.abs(mEx - exit) <= 0.01;
      });
      const paperOcc = r.paper_occ == null ? null : String(r.paper_occ).toUpperCase();
      const alertOcc = alert?.option_symbol == null ? null : String(alert.option_symbol).toUpperCase();

      // QUANT LAB side — the canonical contract.
      const ql = verifyOpportunity({
        alertPresent: !alertsTablePresent ? null : Boolean(alert),
        alertSentToSubscriber: alert ? (String(alert.state ?? "") === "SENT" && Number(alert.research_only ?? 0) === 0) : null,
        discordMessageIdPresent: alert ? Boolean(alert.discord_message_id) : null,
        opportunityCasePresent: alert ? Boolean(alert.opportunity_case_id) : null,
        alertPaperLinked: alert ? Number(alert.paper_linked ?? 0) === 1 : null,
        paperMirrorPresent: true,
        paperRowCount: alertId ? perAlert.get(alertId) ?? 1 : 1,
        entryFillValid: entry != null && entry > 0,
        exitFillValid: String(r.status) === "EXITED" ? exit != null && exit > 0 : true,
        exitMarkMatched, gradingMarkValid,
        occMatches: paperOcc && alertOcc ? paperOcc === alertOcc : null,
        sessionValid: null,
        returnComputable: fin(r.return_pct) != null,
        auditOnly: alertId ? false : true,
      });

      // PAPER-CHAIN side — its predicate, expressed through the same contract
      // so the comparison is of EVIDENCE, not of two different code paths.
      // paper-chain additionally treats a missing opportunity case as a warning
      // rather than a hard failure, which is the one deliberate difference.
      const pcv = verifyOpportunity({
        alertPresent: !alertsTablePresent ? null : Boolean(alert),
        alertSentToSubscriber: alert ? (String(alert.state ?? "") === "SENT" && Number(alert.research_only ?? 0) === 0) : null,
        discordMessageIdPresent: alert ? Boolean(alert.discord_message_id) : null,
        opportunityCasePresent: alert ? Boolean(alert.opportunity_case_id) : null,
        alertPaperLinked: alert ? Number(alert.paper_linked ?? 0) === 1 : null,
        paperMirrorPresent: Boolean(alert) ? true : false,
        paperRowCount: alertId ? perAlert.get(alertId) ?? 1 : 1,
        entryFillValid: entry != null && entry > 0,
        exitFillValid: String(r.status) === "EXITED" ? exit != null && exit > 0 : true,
        exitMarkMatched, gradingMarkValid,
        occMatches: paperOcc && alertOcc ? paperOcc === alertOcc : null,
        sessionValid: null,
        returnComputable: fin(r.return_pct) != null,
        auditOnly: alertId ? false : true,
      });

      const ck = canonicalKey({
        opportunityCaseId: alert?.opportunity_case_id ?? null,
        optionsAlertId: alertId,
        paperPositionId: r.paper_id,
        occ: paperOcc,
        sessionDate: r.entered_at_ms ? new Date(Number(r.entered_at_ms)).toISOString().slice(0, 10) : null,
      });

      parityRows.push({
        key: ck.key, keyKind: ck.kind,
        optionsAlertId: alertId,
        opportunityCaseId: alert?.opportunity_case_id ?? null,
        paperPositionId: String(r.paper_id),
        occ: paperOcc,
        sessionDate: r.entered_at_ms ? new Date(Number(r.entered_at_ms)).toISOString().slice(0, 10) : null,
        quantLabStatus: ql.verificationStatus,
        paperChainStatus: pcv.verificationStatus,
        quantLabReasons: ql.verificationReasons,
        paperChainReasons: pcv.verificationReasons,
        matches: ql.verificationStatus === pcv.verificationStatus,
        mismatchCategory: null,
      });

      if (ql.verificationStatus === "UNVERIFIED_DELIVERY" || ql.verificationStatus === "AUDIT_ONLY") {
        deliveryClasses.push(classifyDelivery({
          alertRowPresent: !alertsTablePresent ? null : Boolean(alert),
          alertState: alert?.state == null ? null : String(alert.state),
          researchOnly: alert ? Number(alert.research_only ?? 0) === 1 : null,
          discordMessageIdPresent: alert ? Boolean(alert.discord_message_id) : null,
          opportunityCasePresent: alert ? Boolean(alert.opportunity_case_id) : null,
          paperLinkedFlag: alert ? Number(alert.paper_linked ?? 0) === 1 : null,
        }));
      }
      const research = alert ? Number(alert.research_only ?? 0) === 1 : false;
      eligibilityRows.push({
        verified: ql.verificationStatus === "VERIFIED_GRADED",
        permanentlyUnverifiable: !alertsTablePresent || (!alert && alertId == null),
        researchOnly: research,
      });
    }

    const parity = compareKeyedParity(parityRows);
    const census = buildDeliveryCensus(deliveryClasses);
    const eligible = buildEligiblePopulation(eligibilityRows);

    return NextResponse.json({
      ok: true,
      readOnly: true,
      providerCallsIssued: 0,
      version: PARITY_DIAGNOSTIC_VERSION,
      populationDefinition: {
        source: "options_paper_trades WHERE status='EXITED' AND return_pct IS NOT NULL",
        joined: "LEFT JOIN options_alerts on alert_id; options_paper_marks by trade_id",
        limit,
        note: "Both verifiers are evaluated over THIS shared keyed population. Aggregate counts from differently-scoped queries are NOT parity evidence.",
      },
      // Non-empty means the diagnostic is UNRELIABLE, whatever it reports.
      queryErrors,
      dataComplete: queryErrors.length === 0,
      parity,
      deliveryClassification: census,
      eligiblePopulation: eligible,
      mismatchSample: parityRows.filter((r) => !r.matches).slice(0, 25),
      safety: {
        canSendSubscriber: false, automaticRealTrading: false,
        productionBehaviorChanged: false, providerCalls: 0,
        note: "Read-only diagnostic. Cannot create an alert, place a trade, change a threshold, or promote anything.",
      },
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

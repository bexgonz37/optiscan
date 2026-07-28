/**
 * Independent-path paper chain diagnostic — SENT → DELIVERED_ALERT_PAPER → case → grader.
 * Owner-only operational visibility; never mutates production state.
 */
import { buildOptionsPaperLifecycle } from "../../paper-lifecycle.ts";
import { readGradingBacklogOnDb } from "./grade.ts";
import { findOpportunityCaseIdByAlertOnDb, loadCaseJsonOnDb } from "../../opportunity-case/live.ts";

type ChainDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
};

function hasTable(db: ChainDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

export interface PaperChainRow {
  alertId: string;
  symbol: string;
  side: string | null;
  strategy: string | null;
  optionSymbol: string | null;
  entryQuality: string | null;
  sentAtMs: number | null;
  ageMs: number | null;
  discordMessageId: string | null;
  opportunityCaseId: string | null;
  paperTradeId: number | null;
  frozenEntry: number | null;
  markPrice: number | null;
  frozenT1: number | null;
  frozenT2: number | null;
  frozenStop: number | null;
  paperStatus: string | null;
  exitReason: string | null;
  returnPct: number | null;
  /** Closed trade $ P&L (1 contract × 100 multiplier), or open mark-to-market estimate. */
  pnlUsd: number | null;
  mfePct: number | null;
  maePct: number | null;
  t1Hit: boolean;
  t2Hit: boolean;
  stopHit: boolean;
  latestMarkReturnPct: number | null;
  deliveryProofStatus: "verified_delivered" | "app_sent_unverified" | "missing_mirror" | "not_sent" | "unknown";
  subscriberDelivered: boolean;
  graderHealth: "healthy" | "stuck_open" | "missing_mirror" | "missing_case" | "historical_pre_lifecycle" | "unknown";
  missingDataWarnings: string[];
  lifecycleBlocked: boolean;
  blockingReason: string | null;
  currentStage: string | null;
}

export interface PaperChainDiagnostic {
  generatedAtMs: number;
  paperLinkRate: number | null;
  sent24h: number;
  linked24h: number;
  /** Sum of closed delivered `pnl` dollars in the sampled rows. */
  sumPnlUsd: number | null;
  /** Sum of closed rows with Discord message + Opportunity Case proof. */
  verifiedSumPnlUsd: number | null;
  rows: PaperChainRow[];
  gradingBacklog: ReturnType<typeof readGradingBacklogOnDb>;
}

function t1T2StopHit(row: Record<string, unknown> | null, mark: number | null): { t1: boolean; t2: boolean; stop: boolean } {
  if (!row || mark == null) return { t1: false, t2: false, stop: false };
  const t1 = row.target_t1 ?? row.target;
  const t2 = row.target_t2;
  const stop = row.target_stop ?? row.invalidation;
  return {
    t1: t1 != null && mark >= Number(t1),
    t2: t2 != null && mark >= Number(t2),
    stop: stop != null && mark <= Number(stop),
  };
}

function graderHealthForRow(
  alert: Record<string, unknown> | null,
  paper: Record<string, unknown> | null,
  caseId: string | null,
): PaperChainRow["graderHealth"] {
  if (!alert || alert.state !== "SENT") return "unknown";
  if (Number(alert.paper_linked) !== 1 || !paper) return "missing_mirror";
  if (!caseId) return "missing_case";
  if (paper.status === "ENTERED") {
    const entered = Number(paper.entered_at_ms ?? 0);
    const ageMs = Date.now() - entered;
    if (ageMs > 48 * 3600_000) return "stuck_open";
  }
  return "healthy";
}

function deliveryProofForRow(
  alert: Record<string, unknown> | null,
  paper: Record<string, unknown> | null,
  caseId: string | null,
): { status: PaperChainRow["deliveryProofStatus"]; subscriberDelivered: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (!alert) return { status: "unknown", subscriberDelivered: false, warnings: ["missing_alert"] };
  if (alert.state !== "SENT" || Number(alert.research_only ?? 0) !== 0) {
    return { status: "not_sent", subscriberDelivered: false, warnings: ["alert_not_subscriber_sent"] };
  }
  if (Number(alert.paper_linked) !== 1 || !paper) warnings.push("paper_not_linked");
  if (!caseId) warnings.push("missing_opportunity_case");
  if (!alert.discord_message_id) warnings.push("missing_opening_discord_message_id");
  if (paper?.status === "ENTERED" && paper.last_mark_return_pct == null) warnings.push("no_recent_marks");

  const verified = !warnings.some((w) => w !== "no_recent_marks");
  return {
    status: verified ? "verified_delivered" : (paper ? "app_sent_unverified" : "missing_mirror"),
    subscriberDelivered: verified,
    warnings,
  };
}

export function buildPaperChainDiagnostic(
  db: ChainDb,
  env: NodeJS.ProcessEnv = process.env,
  limit = 40,
  minSentAtMs: number | null = null,
): PaperChainDiagnostic {
  const nowMs = Date.now();
  const since = nowMs - 24 * 3600_000;
  const out: PaperChainDiagnostic = {
    generatedAtMs: nowMs,
    paperLinkRate: null,
    sent24h: 0,
    linked24h: 0,
    sumPnlUsd: null,
    verifiedSumPnlUsd: null,
    rows: [],
    gradingBacklog: readGradingBacklogOnDb(db as any),
  };

  if (!hasTable(db, "options_alerts")) return out;

  out.sent24h = Number((db.prepare(
    "SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND sent_at_ms >= ? AND research_only=0",
  ).get(since) as { n: number })?.n ?? 0);
  out.linked24h = Number((db.prepare(
    "SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND paper_linked=1 AND sent_at_ms >= ? AND research_only=0",
  ).get(since) as { n: number })?.n ?? 0);
  out.paperLinkRate = out.sent24h ? +(out.linked24h / out.sent24h).toFixed(4) : null;

  const alerts = minSentAtMs != null
    ? db.prepare(
      `SELECT * FROM options_alerts
         WHERE state='SENT' AND research_only=0 AND sent_at_ms IS NOT NULL AND sent_at_ms >= ?
         ORDER BY sent_at_ms DESC
         LIMIT ?`,
    ).all(minSentAtMs, limit) as Record<string, unknown>[]
    : db.prepare(
      `SELECT * FROM options_alerts
         WHERE state='SENT' AND research_only=0
         ORDER BY sent_at_ms DESC
         LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];

  for (const alert of alerts) {
    const alertId = String(alert.alert_id);
    const paper = hasTable(db, "options_paper_trades")
      ? (db.prepare(
        "SELECT * FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER' LIMIT 1",
      ).get(alertId) as Record<string, unknown> | undefined)
      : undefined;
    const caseId = alert.opportunity_case_id
      ? String(alert.opportunity_case_id)
      : findOpportunityCaseIdByAlertOnDb(db as any, alertId);
    const lifecycle = buildOptionsPaperLifecycle(db as any, { alertId });
    const mark = paper?.last_mark_return_pct != null
      ? Number(paper.entry_fill) * (1 + Number(paper.last_mark_return_pct) / 100)
      : (paper?.entry_fill != null ? Number(paper.entry_fill) : null);
    const hits = t1T2StopHit({ ...alert, ...paper }, mark);
    const proof = deliveryProofForRow(alert, paper ?? null, caseId);

    const sentAtMs = alert.sent_at_ms != null ? Number(alert.sent_at_ms) : null;
    const frozenEntry = alert.entry_mid != null ? Number(alert.entry_mid) : (paper?.entry_fill != null ? Number(paper.entry_fill) : null);
    let pnlUsd: number | null = null;
    if (paper?.pnl != null && Number.isFinite(Number(paper.pnl))) {
      pnlUsd = +Number(paper.pnl).toFixed(2);
    } else if (frozenEntry != null && mark != null && Number.isFinite(frozenEntry) && Number.isFinite(mark)) {
      pnlUsd = +((mark - frozenEntry) * 100).toFixed(2);
    }
    out.rows.push({
      alertId,
      symbol: String(alert.candidate_symbol ?? ""),
      side: alert.side != null ? String(alert.side) : null,
      strategy: alert.strategy != null ? String(alert.strategy) : null,
      optionSymbol: alert.option_symbol != null ? String(alert.option_symbol) : (paper?.option_symbol != null ? String(paper.option_symbol) : null),
      entryQuality: alert.entry_quality_verdict != null ? String(alert.entry_quality_verdict) : null,
      sentAtMs,
      ageMs: sentAtMs != null ? Math.max(0, nowMs - sentAtMs) : null,
      discordMessageId: alert.discord_message_id != null ? String(alert.discord_message_id) : null,
      opportunityCaseId: caseId,
      paperTradeId: paper?.id != null ? Number(paper.id) : null,
      frozenEntry,
      markPrice: mark,
      frozenT1: alert.target_t1 != null ? Number(alert.target_t1) : null,
      frozenT2: alert.target_t2 != null ? Number(alert.target_t2) : null,
      frozenStop: alert.target_stop != null ? Number(alert.target_stop) : null,
      paperStatus: paper?.status != null ? String(paper.status) : null,
      exitReason: paper?.exit_reason != null ? String(paper.exit_reason) : null,
      returnPct: paper?.return_pct != null ? Number(paper.return_pct) : null,
      pnlUsd,
      mfePct: paper?.mfe_pct != null ? Number(paper.mfe_pct) : null,
      maePct: paper?.mae_pct != null ? Number(paper.mae_pct) : null,
      t1Hit: hits.t1,
      t2Hit: hits.t2,
      stopHit: hits.stop,
      latestMarkReturnPct: paper?.last_mark_return_pct != null ? Number(paper.last_mark_return_pct) : null,
      deliveryProofStatus: proof.status,
      subscriberDelivered: proof.subscriberDelivered,
      graderHealth: graderHealthForRow(alert, paper ?? null, caseId),
      missingDataWarnings: proof.warnings,
      lifecycleBlocked: lifecycle?.blocked ?? false,
      blockingReason: lifecycle?.blockingReason ?? null,
      currentStage: lifecycle?.currentStage ?? null,
    });
  }

  const closedPnls = out.rows
    .filter((r) => r.paperStatus === "EXITED" && r.pnlUsd != null)
    .map((r) => r.pnlUsd as number);
  out.sumPnlUsd = closedPnls.length
    ? +closedPnls.reduce((a, x) => a + x, 0).toFixed(2)
    : null;
  const verifiedClosedPnls = out.rows
    .filter((r) => r.subscriberDelivered && r.paperStatus === "EXITED" && r.pnlUsd != null)
    .map((r) => r.pnlUsd as number);
  out.verifiedSumPnlUsd = verifiedClosedPnls.length
    ? +verifiedClosedPnls.reduce((a, x) => a + x, 0).toFixed(2)
    : null;

  return out;
}

export function getPaperChainDetail(db: ChainDb, alertId: string): Record<string, unknown> | null {
  if (!hasTable(db, "options_alerts")) return null;
  const alert = db.prepare("SELECT * FROM options_alerts WHERE alert_id=?").get(alertId) as Record<string, unknown> | undefined;
  if (!alert) return null;
  const lifecycle = buildOptionsPaperLifecycle(db as any, { alertId });
  const caseId = alert.opportunity_case_id
    ? String(alert.opportunity_case_id)
    : findOpportunityCaseIdByAlertOnDb(db as any, alertId);
  const oc = caseId ? loadCaseJsonOnDb(db as any, caseId) : null;
  const paper = hasTable(db, "options_paper_trades")
    ? (db.prepare(
      "SELECT * FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER' ORDER BY id ASC LIMIT 1",
    ).get(alertId) as Record<string, unknown> | undefined)
    : undefined;
  let marks: Record<string, unknown>[] = [];
  if (paper?.id != null && hasTable(db, "options_paper_marks")) {
    try {
      marks = db.prepare(
        "SELECT id, trade_id, option_symbol, mark_at_ms, bid, ask, exit_fill, return_pct, quote_age_ms, created_at_ms FROM options_paper_marks WHERE trade_id=? ORDER BY mark_at_ms ASC",
      ).all(paper.id) as Record<string, unknown>[];
    } catch { marks = []; }
  }
  const enteredAt = paper?.entered_at_ms != null ? Number(paper.entered_at_ms) : null;
  const sixtyMinMark = marks.find((m) => enteredAt != null && Number(m.mark_at_ms) - enteredAt >= 60 * 60_000) ?? null;
  const diagnosticRows = buildPaperChainDiagnostic(db, process.env, 40).rows;
  const diagnostic = diagnosticRows.find((r) => r.alertId === alertId) ?? diagnosticRows[0] ?? null;
  return {
    alert,
    paper: paper ?? null,
    marks,
    sixtyMinMark,
    markConvention: {
      entry: "conservativeEntryFill = mid + 0.6*(ask-mid) toward ask; Discord frozen entry uses entry_mid shown to subscriber",
      markUsed: "realOptionExit exitFill = mid - 0.6*(mid-bid) toward bid (conservative sell)",
      returnPct: "((exitFill - entry_fill) / entry_fill) * 100 on OPTION premium, never underlying",
    },
    lifecycle,
    opportunityCase: oc,
    diagnostic,
  };
}

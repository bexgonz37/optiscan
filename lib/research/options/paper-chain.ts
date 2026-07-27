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
  sentAtMs: number | null;
  discordMessageId: string | null;
  opportunityCaseId: string | null;
  paperTradeId: number | null;
  frozenEntry: number | null;
  frozenT1: number | null;
  frozenT2: number | null;
  frozenStop: number | null;
  paperStatus: string | null;
  exitReason: string | null;
  returnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  t1Hit: boolean;
  t2Hit: boolean;
  stopHit: boolean;
  latestMarkReturnPct: number | null;
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
    const warnings: string[] = [];
    if (Number(alert.paper_linked) !== 1) warnings.push("paper_not_linked");
    if (!caseId) warnings.push("missing_opportunity_case");
    if (!alert.discord_message_id) warnings.push("missing_opening_discord_message_id");
    if (paper?.status === "ENTERED" && paper.last_mark_return_pct == null) warnings.push("no_recent_marks");

    out.rows.push({
      alertId,
      symbol: String(alert.candidate_symbol ?? ""),
      sentAtMs: alert.sent_at_ms != null ? Number(alert.sent_at_ms) : null,
      discordMessageId: alert.discord_message_id != null ? String(alert.discord_message_id) : null,
      opportunityCaseId: caseId,
      paperTradeId: paper?.id != null ? Number(paper.id) : null,
      frozenEntry: alert.entry_mid != null ? Number(alert.entry_mid) : (paper?.entry_fill != null ? Number(paper.entry_fill) : null),
      frozenT1: alert.target_t1 != null ? Number(alert.target_t1) : null,
      frozenT2: alert.target_t2 != null ? Number(alert.target_t2) : null,
      frozenStop: alert.target_stop != null ? Number(alert.target_stop) : null,
      paperStatus: paper?.status != null ? String(paper.status) : null,
      exitReason: paper?.exit_reason != null ? String(paper.exit_reason) : null,
      returnPct: paper?.return_pct != null ? Number(paper.return_pct) : null,
      mfePct: paper?.mfe_pct != null ? Number(paper.mfe_pct) : null,
      maePct: paper?.mae_pct != null ? Number(paper.mae_pct) : null,
      t1Hit: hits.t1,
      t2Hit: hits.t2,
      stopHit: hits.stop,
      latestMarkReturnPct: paper?.last_mark_return_pct != null ? Number(paper.last_mark_return_pct) : null,
      graderHealth: graderHealthForRow(alert, paper ?? null, caseId),
      missingDataWarnings: warnings,
      lifecycleBlocked: lifecycle?.blocked ?? false,
      blockingReason: lifecycle?.blockingReason ?? null,
      currentStage: lifecycle?.currentStage ?? null,
    });
  }

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
  return {
    alert,
    lifecycle,
    opportunityCase: oc,
    diagnostic: buildPaperChainDiagnostic(db, process.env, 1).rows[0] ?? null,
  };
}

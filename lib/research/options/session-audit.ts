/**
 * Deterministic ET-session audit for the independent options pipeline.
 *
 * This is an observability read model only. It deliberately reads persisted
 * records and never imports scanner, delivery, or paper-entry execution.
 */
import { etCloseMs, isMarketHoliday } from "../../trading-session.ts";

interface AuditDb {
  prepare(sql: string): { get: (...args: any[]) => any; all: (...args: any[]) => any[] };
}

export interface OptionsSessionAudit {
  sessionDate: string;
  sessionBounds: { regularOpenMs: number; regularCloseMs: number; marketClosed: boolean };
  funnel: {
    candidatesDetected: number;
    candidatesWithExactOcc: number;
    readyCandidates: number;
    candidatesRanked: number;
    subscriberSelected: number;
    optionsAlertsSent: number;
    verifiedDiscordOpeningProof: number;
    paperPositionLinked: number;
  };
  classifications: {
    deduplicated: number;
    blocked: number;
    researchOnly: number;
    paperLinkFailure: number;
    deliveryFailure: number;
    unverifiedSent: number;
  };
  blockedReasons: Array<{ reason: string; count: number }>;
  candidateTerminalReasons: Array<{ reason: string; count: number }>;
  deliveryReconciliation: {
    sentWithoutDiscordMessageProof: number;
    sentWithoutPaperLink: number;
    proofDefinition: string;
  };
  warnings: string[];
  dataCompleteness: { complete: boolean; missingTables: string[]; queryFailures: string[] };
  productionBehaviorChanged: false;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function etOpenMs(day: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
  for (const offset of ["-04:00", "-05:00"]) {
    const value = Date.parse(`${day}T09:30:00${offset}`);
    if (Number.isFinite(value) && fmt.format(new Date(value)) === "09:30") return value;
  }
  return Date.parse(`${day}T09:30:00-05:00`);
}

function hasTable(db: AuditDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name));
  } catch {
    return false;
  }
}

function scalar(db: AuditDb, sql: string, args: any[], failures: string[], label: string): number {
  try {
    return Number(db.prepare(sql).get(...args)?.n ?? 0);
  } catch {
    failures.push(label);
    return 0;
  }
}

function grouped(db: AuditDb, sql: string, args: any[], failures: string[], label: string): Array<{ reason: string; count: number }> {
  try {
    return db.prepare(sql).all(...args).map((row: any) => ({ reason: String(row.reason ?? "unspecified"), count: Number(row.n ?? 0) }));
  } catch {
    failures.push(label);
    return [];
  }
}

/** Build a bounded regular-session audit. Dates must be ET YYYY-MM-DD. */
export function buildOptionsSessionAuditOnDb(db: AuditDb, sessionDate: string): OptionsSessionAudit {
  if (!DAY.test(sessionDate)) throw new Error("sessionDate must be YYYY-MM-DD");
  const regularOpenMs = etOpenMs(sessionDate);
  const regularCloseMs = etCloseMs(sessionDate);
  const start = regularOpenMs;
  const end = regularCloseMs;
  const missingTables = ["options_candidates", "options_delivery_decisions", "options_alerts", "options_paper_trades"]
    .filter((name) => !hasTable(db, name));
  const queryFailures: string[] = [];
  const warnings: string[] = [];
  const available = (name: string) => !missingTables.includes(name);
  const q = (table: string, label: string, sql: string, args: any[] = [start, end]) =>
    available(table) ? scalar(db, sql, args, queryFailures, label) : 0;

  const candidatesDetected = q("options_candidates", "candidates_detected", "SELECT COUNT(*) n FROM options_candidates WHERE created_at_ms>=? AND created_at_ms<?");
  const candidatesWithExactOcc = q("options_candidates", "candidates_with_exact_occ", "SELECT COUNT(*) n FROM options_candidates WHERE created_at_ms>=? AND created_at_ms<? AND option_symbol IS NOT NULL AND TRIM(option_symbol)<>''");
  const readyCandidates = q("options_candidates", "ready_candidates", "SELECT COUNT(*) n FROM options_candidates WHERE created_at_ms>=? AND created_at_ms<? AND state='READY'");
  const candidatesRanked = q("options_delivery_decisions", "candidates_ranked", "SELECT COUNT(*) n FROM options_delivery_decisions WHERE created_at_ms>=? AND created_at_ms<?");
  const subscriberSelected = q("options_delivery_decisions", "subscriber_selected", "SELECT COUNT(*) n FROM options_delivery_decisions WHERE created_at_ms>=? AND created_at_ms<? AND outcome='DELIVER_TO_DISCORD'");
  const optionsAlertsSent = q("options_alerts", "options_alerts_sent", "SELECT COUNT(*) n FROM options_alerts WHERE created_at_ms>=? AND created_at_ms<? AND state='SENT' AND COALESCE(research_only,0)=0");

  // A SENT state alone is intentionally insufficient: preserve all four hard links.
  const proofSql = `
    SELECT COUNT(*) n FROM options_alerts oa
    WHERE oa.created_at_ms>=? AND oa.created_at_ms<?
      AND oa.state='SENT' AND COALESCE(oa.research_only,0)=0
      AND oa.discord_message_id IS NOT NULL AND TRIM(oa.discord_message_id)<>''
      AND oa.opportunity_case_id IS NOT NULL AND TRIM(oa.opportunity_case_id)<>''
      AND oa.entry_mid IS NOT NULL AND oa.entry_mid>0
      AND COALESCE(oa.paper_linked,0)=1
      AND oa.option_symbol IS NOT NULL AND TRIM(oa.option_symbol)<>''
      AND EXISTS (
        SELECT 1 FROM options_paper_trades p
        WHERE p.alert_id=oa.alert_id
          AND p.paper_kind='DELIVERED_ALERT_PAPER'
          AND p.option_symbol=oa.option_symbol
      )`;
  const verifiedDiscordOpeningProof = available("options_alerts") && available("options_paper_trades")
    ? scalar(db, proofSql, [start, end], queryFailures, "verified_discord_opening_proof") : 0;
  const paperPositionLinked = q("options_alerts", "paper_position_linked", `SELECT COUNT(*) n FROM options_alerts oa WHERE oa.created_at_ms>=? AND oa.created_at_ms<? AND oa.state='SENT' AND COALESCE(oa.research_only,0)=0 AND oa.option_symbol IS NOT NULL AND EXISTS (SELECT 1 FROM options_paper_trades p WHERE p.alert_id=oa.alert_id AND p.paper_kind='DELIVERED_ALERT_PAPER' AND p.option_symbol=oa.option_symbol)`);

  const deduplicated = q("options_delivery_decisions", "deduplicated", `SELECT COUNT(*) n FROM options_delivery_decisions WHERE created_at_ms>=? AND created_at_ms<? AND (LOWER(COALESCE(reason,'')) LIKE '%duplicate%' OR LOWER(COALESCE(final_delivery_reason,'')) LIKE '%duplicate%' OR LOWER(COALESCE(final_delivery_reason,'')) LIKE '%matching_active%')`);
  const blocked = q("options_delivery_decisions", "blocked", "SELECT COUNT(*) n FROM options_delivery_decisions WHERE created_at_ms>=? AND created_at_ms<? AND outcome='REJECT'");
  const researchOnly = q("options_delivery_decisions", "research_only", "SELECT COUNT(*) n FROM options_delivery_decisions WHERE created_at_ms>=? AND created_at_ms<? AND outcome='RESEARCH_ONLY'");
  const paperLinkFailure = q("options_alerts", "paper_link_failure", "SELECT COUNT(*) n FROM options_alerts WHERE created_at_ms>=? AND created_at_ms<? AND LOWER(COALESCE(failure_reason,'')) LIKE 'paper_%'");
  const deliveryFailure = q("options_alerts", "delivery_failure", "SELECT COUNT(*) n FROM options_alerts WHERE created_at_ms>=? AND created_at_ms<? AND state='SEND_FAILED'");
  const unverifiedSent = Math.max(0, optionsAlertsSent - verifiedDiscordOpeningProof);

  const blockedReasons = available("options_delivery_decisions")
    ? grouped(db, `SELECT COALESCE(NULLIF(final_delivery_reason,''), NULLIF(reason,''), 'unspecified') reason, COUNT(*) n FROM options_delivery_decisions WHERE created_at_ms>=? AND created_at_ms<? AND outcome IN ('REJECT','RESEARCH_ONLY') GROUP BY reason ORDER BY n DESC, reason ASC LIMIT 20`, [start, end], queryFailures, "blocked_reasons")
    : [];
  const candidateTerminalReasons = available("options_candidates")
    ? grouped(db, `SELECT COALESCE(NULLIF(why,''), state, 'unspecified') reason, COUNT(*) n FROM options_candidates WHERE created_at_ms>=? AND created_at_ms<? AND state<>'READY' GROUP BY reason ORDER BY n DESC, reason ASC LIMIT 20`, [start, end], queryFailures, "candidate_terminal_reasons")
    : [];

  if (isMarketHoliday(sessionDate)) warnings.push("Selected date is a US market holiday; regular-session counts should be zero.");
  if (missingTables.length) warnings.push(`Missing audit tables: ${missingTables.join(", ")}.`);
  if (queryFailures.length) warnings.push("One or more audit queries could not run; affected counts are zero rather than inferred.");
  if (optionsAlertsSent > verifiedDiscordOpeningProof) warnings.push("Some SENT rows lack complete Discord, opportunity, frozen-entry, and delivered-paper proof; they are unverified, not subscriber-delivered performance.");

  return {
    sessionDate,
    sessionBounds: { regularOpenMs, regularCloseMs, marketClosed: isMarketHoliday(sessionDate) },
    funnel: { candidatesDetected, candidatesWithExactOcc, readyCandidates, candidatesRanked, subscriberSelected, optionsAlertsSent, verifiedDiscordOpeningProof, paperPositionLinked },
    classifications: { deduplicated, blocked, researchOnly, paperLinkFailure, deliveryFailure, unverifiedSent },
    blockedReasons,
    candidateTerminalReasons,
    deliveryReconciliation: {
      sentWithoutDiscordMessageProof: unverifiedSent,
      sentWithoutPaperLink: Math.max(0, optionsAlertsSent - paperPositionLinked),
      proofDefinition: "SENT non-research row with Discord message ID, opportunity case ID, frozen entry, exact OCC, and matching DELIVERED_ALERT_PAPER mirror",
    },
    warnings,
    dataCompleteness: { complete: missingTables.length === 0 && queryFailures.length === 0, missingTables, queryFailures },
    productionBehaviorChanged: false,
  };
}

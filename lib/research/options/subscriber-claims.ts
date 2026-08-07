/**
 * Subscriber claim integrity — only DELIVERED_ALERT_PAPER with frozen entry may appear in marketing.
 */
import { computeReturnPercent } from "../../opportunity-case/milestones.ts";

export interface SubscriberClaimPacket {
  ok: boolean;
  reason: string | null;
  alertId: string | null;
  opportunityCaseId: string | null;
  symbol: string | null;
  optionSymbol: string | null;
  side: string | null;
  strike: number | null;
  expiration: string | null;
  sentAtMs: number | null;
  frozenEntry: number | null;
  targetT1: number | null;
  targetT2: number | null;
  targetStop: number | null;
  targetMethod: string | null;
  discordMessageId: string | null;
  paperTradeId: number | null;
  currentReturnPct: number | null;
  realizedReturnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  status: string | null;
  exitReason: string | null;
  milestoneHistory: Array<{ percent: number | null; label: string; reachedAtMs: number; deliveredAtMs: number | null }>;
}

interface ClaimDb {
  prepare(sql: string): { get: (...args: any[]) => any; all: (...args: any[]) => any[] };
}

function hasTable(db: ClaimDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

const ENTRY_TOLERANCE = 0.01;

/** Case/whitespace only — never rewrites a symbol, never fuzzy-matches a strike. */
function normalizeOcc(occ: unknown): string | null {
  const s = String(occ ?? "").trim().toUpperCase();
  return s.length > 0 ? s : null;
}

export function buildSubscriberClaimPacket(db: ClaimDb, alertId: string): SubscriberClaimPacket {
  const fail = (reason: string, partial: Partial<SubscriberClaimPacket> = {}): SubscriberClaimPacket => ({
    ok: false,
    reason,
    alertId,
    opportunityCaseId: null,
    symbol: null,
    optionSymbol: null,
    side: null,
    strike: null,
    expiration: null,
    sentAtMs: null,
    frozenEntry: null,
    targetT1: null,
    targetT2: null,
    targetStop: null,
    targetMethod: null,
    discordMessageId: null,
    paperTradeId: null,
    currentReturnPct: null,
    realizedReturnPct: null,
    mfePct: null,
    maePct: null,
    status: null,
    exitReason: null,
    milestoneHistory: [],
    ...partial,
  });

  if (!hasTable(db, "options_alerts")) return fail("options_alerts table missing");
  const alert = db.prepare(`SELECT * FROM options_alerts WHERE alert_id=?`).get(alertId) as Record<string, any> | undefined;
  if (!alert) return fail("alert not found");
  if (String(alert.state) !== "SENT") return fail(`alert state is ${alert.state}, not SENT`);

  const frozenEntry = alert.entry_mid != null ? Number(alert.entry_mid) : null;
  if (frozenEntry == null || !(frozenEntry > 0)) return fail("missing frozen entry_mid on SENT alert");

  let paper: Record<string, any> | undefined;
  if (hasTable(db, "options_paper_trades")) {
    paper = db
      .prepare(`SELECT * FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER' ORDER BY id DESC LIMIT 1`)
      .get(alertId) as Record<string, any> | undefined;
  }
  if (!paper) return fail("no DELIVERED_ALERT_PAPER mirror linked to alert", {
    symbol: alert.candidate_symbol ?? null,
    frozenEntry,
    sentAtMs: alert.sent_at_ms != null ? Number(alert.sent_at_ms) : null,
    discordMessageId: alert.discord_message_id ?? null,
    opportunityCaseId: alert.opportunity_case_id ?? null,
  });

  const entryFill = paper.entry_fill != null ? Number(paper.entry_fill) : null;
  if (entryFill == null || Math.abs(entryFill - frozenEntry) > ENTRY_TOLERANCE) {
    return fail("paper entry_fill does not match frozen alert entry_mid", {
      symbol: alert.candidate_symbol ?? null,
      frozenEntry,
      paperTradeId: paper.id,
    });
  }

  // The mirror must be the SAME CONTRACT the alert named, not merely a position that
  // happens to have cost the same. Matching entry price alone let a different strike
  // or expiration stand in for the alerted trade, and every number below — the
  // realized return, the MFE, the MAE — would then describe that other instrument.
  const alertOcc = normalizeOcc(alert.option_symbol);
  const paperOcc = normalizeOcc(paper.option_symbol);
  if (alertOcc && paperOcc && alertOcc !== paperOcc) {
    return fail(`paper mirror is on ${paperOcc}, but the alert named ${alertOcc}`, {
      symbol: alert.candidate_symbol ?? null,
      frozenEntry,
      optionSymbol: alertOcc,
      paperTradeId: paper.id,
    });
  }

  const milestones: SubscriberClaimPacket["milestoneHistory"] = [];
  const caseId = alert.opportunity_case_id ? String(alert.opportunity_case_id) : null;
  if (caseId && hasTable(db, "opportunity_milestones")) {
    const rows = db
      .prepare(
        `SELECT milestone_percent, label, reached_at_ms, delivered_at_ms FROM opportunity_milestones
         WHERE opportunity_case_id=? AND event_type='RETURN_MILESTONE' ORDER BY reached_at_ms ASC`,
      )
      .all(caseId) as Array<Record<string, any>>;
    for (const r of rows) {
      milestones.push({
        percent: r.milestone_percent != null ? Number(r.milestone_percent) : null,
        label: String(r.label ?? ""),
        reachedAtMs: Number(r.reached_at_ms),
        deliveredAtMs: r.delivered_at_ms != null ? Number(r.delivered_at_ms) : null,
      });
    }
  }

  const status = String(paper.status ?? "");
  const realized = status === "EXITED" && paper.return_pct != null ? Number(paper.return_pct) : null;
  const currentMark = paper.last_mark_return_pct != null ? Number(paper.last_mark_return_pct) : realized;

  return {
    ok: true,
    reason: null,
    alertId,
    opportunityCaseId: caseId,
    symbol: alert.candidate_symbol ?? null,
    // Proven equal above when both are present, so this no longer masks a mismatch.
    optionSymbol: alertOcc ?? paperOcc,
    side: alert.side ?? paper.side ?? null,
    strike: paper.strike != null ? Number(paper.strike) : null,
    expiration: paper.expiration ?? null,
    sentAtMs: alert.sent_at_ms != null ? Number(alert.sent_at_ms) : null,
    frozenEntry,
    targetT1: alert.target_t1 != null ? Number(alert.target_t1) : null,
    targetT2: alert.target_t2 != null ? Number(alert.target_t2) : null,
    targetStop: alert.target_stop != null ? Number(alert.target_stop) : null,
    targetMethod: alert.target_method ?? null,
    discordMessageId: alert.discord_message_id ?? null,
    paperTradeId: Number(paper.id),
    currentReturnPct: currentMark,
    realizedReturnPct: realized,
    mfePct: paper.mfe_pct != null ? Number(paper.mfe_pct) : null,
    maePct: paper.mae_pct != null ? Number(paper.mae_pct) : null,
    status,
    exitReason: paper.exit_reason ?? null,
    milestoneHistory: milestones,
  };
}

/** Recompute return from frozen entry — used to verify displayed percentages. */
export function verifiedReturnFromFrozenEntry(frozenEntry: number, mark: number): number | null {
  return computeReturnPercent(frozenEntry, mark);
}

export function isDeliveredOnlyPaperKind(paperKind: string | null | undefined): boolean {
  return String(paperKind ?? "") === "DELIVERED_ALERT_PAPER";
}

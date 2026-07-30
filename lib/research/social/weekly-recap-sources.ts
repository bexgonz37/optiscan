/**
 * weekly-recap-sources.ts — assembles recap input rows from canonical surfaces.
 *
 * READ-ONLY. Reads the paper-chain diagnostic (which already enforces verified
 * delivery proof, entry validity, and mark validity), plus options_alerts for the
 * entry bid/ask evidence the diagnostic does not surface, plus research-only alerts
 * as a SEPARATE cohort.
 *
 * The verified-subscriber lane and the research-only lane are queried separately and
 * never merged, because research rows have no subscriber delivery proof and must
 * never be presented as subscriber callouts.
 */
import type { CalloutLane, RecapInputRow } from "./weekly-recap.ts";

type SourceDb = any;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function hasTable(db: SourceDb, table: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  } catch {
    return false;
  }
}

interface EntryEvidenceRow {
  alert_id: string;
  delivered_bid: number | null;
  delivered_ask: number | null;
  quote_ts_ms: number | null;
  discord_message_id: string | null;
  thesis_fingerprint: string | null;
  opportunity_case_id: string | null;
  research_only: number | null;
  sent_at_ms: number | null;
  candidate_symbol: string | null;
  option_symbol: string | null;
  entry_mid: number | null;
  message: string | null;
}

/** Entry bid/ask + thesis identity keyed by alert id. */
function entryEvidence(db: SourceDb): Map<string, EntryEvidenceRow> {
  const out = new Map<string, EntryEvidenceRow>();
  if (!hasTable(db, "options_alerts")) return out;
  try {
    const rows = db.prepare(`
      SELECT alert_id, delivered_bid, delivered_ask, quote_ts_ms, discord_message_id,
             thesis_fingerprint, opportunity_case_id, research_only, sent_at_ms,
             candidate_symbol, option_symbol, entry_mid, message
      FROM options_alerts
    `).all() as EntryEvidenceRow[];
    for (const r of rows) out.set(String(r.alert_id), r);
  } catch { /* pre-migration DB ⇒ no entry evidence ⇒ rows are excluded, never assumed */ }
  return out;
}

/**
 * Verified marks per paper trade, needed to reconcile the peak against the exit on
 * the SAME executable convention. Fetched in one pass rather than per row.
 */
function marksByTrade(db: SourceDb): Map<number, Array<{
  markAtMs: number; bid: number | null; ask: number | null;
  quoteAgeMs: number | null; createdAtMs: number | null;
}>> {
  const out = new Map<number, Array<any>>();
  if (!hasTable(db, "options_paper_marks")) return out;
  try {
    const rows = db.prepare(`
      SELECT trade_id, mark_at_ms, bid, ask, quote_age_ms, created_at_ms
      FROM options_paper_marks
      ORDER BY trade_id ASC, mark_at_ms ASC
    `).all() as any[];
    for (const r of rows) {
      const id = Number(r.trade_id);
      if (!Number.isFinite(id)) continue;
      const list = out.get(id) ?? [];
      list.push({
        markAtMs: Number(r.mark_at_ms),
        bid: num(r.bid),
        ask: num(r.ask),
        quoteAgeMs: num(r.quote_age_ms),
        createdAtMs: num(r.created_at_ms),
      });
      out.set(id, list);
    }
  } catch { /* no marks ⇒ rows reconcile as INSUFFICIENT_EVIDENCE, never assumed */ }
  return out;
}

/** Canonical exit price and timestamp per paper trade. */
function exitEvidenceByTrade(db: SourceDb): Map<number, { exit_fill: number | null; exit_at_ms: number | null }> {
  const out = new Map<number, { exit_fill: number | null; exit_at_ms: number | null }>();
  if (!hasTable(db, "options_paper_trades")) return out;
  try {
    const rows = db.prepare("SELECT id, exit_fill, exit_at_ms FROM options_paper_trades").all() as any[];
    for (const r of rows) {
      const id = Number(r.id);
      if (Number.isFinite(id)) out.set(id, { exit_fill: num(r.exit_fill), exit_at_ms: num(r.exit_at_ms) });
    }
  } catch { /* absent ⇒ closed rows reconcile as INVALID_EXIT */ }
  return out;
}

/** First sentence of the delivered message, used only as a setup description. */
function setupReasonFrom(message: string | null | undefined): string | null {
  const clean = String(message ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const sentence = clean.split(/(?<=[.!?])\s+/).find((s) => s.length >= 20 && !/^https?:/i.test(s));
  return sentence ? sentence.slice(0, 180) : null;
}

/**
 * Verified-subscriber rows from the paper-chain diagnostic.
 *
 * The diagnostic is asked for the FULL cohort (its row cap is display-only) so a
 * week is never silently truncated.
 */
export function loadVerifiedSubscriberRows(db: SourceDb, env: NodeJS.ProcessEnv = process.env): RecapInputRow[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildPaperChainDiagnostic } = require("@/lib/research/options/paper-chain");
  const chain = buildPaperChainDiagnostic(db, env, 100_000);
  const evidence = entryEvidence(db);
  const marks = marksByTrade(db);
  const paperExits = exitEvidenceByTrade(db);
  const rows: RecapInputRow[] = [];
  for (const r of chain?.rows ?? []) {
    const ev = evidence.get(String(r.alertId));
    const happened = r.whatHappened;
    const tradeId = num(r.paperTradeId);
    const exit = tradeId != null ? paperExits.get(tradeId) : undefined;
    rows.push({
      lane: "VERIFIED_SUBSCRIBER",
      alertId: String(r.alertId),
      opportunityCaseId: r.opportunityCaseId ?? null,
      symbol: String(r.symbol ?? ev?.candidate_symbol ?? ""),
      optionSymbol: r.optionSymbol ?? ev?.option_symbol ?? null,
      thesisKey: ev?.thesis_fingerprint ?? null,
      frozenEntry: num(r.frozenEntry),
      entryBid: num(ev?.delivered_bid),
      entryAsk: num(ev?.delivered_ask),
      entryQuoteTsMs: num(ev?.quote_ts_ms),
      discordMessageId: ev?.discord_message_id ?? r.discordMessageId ?? null,
      subscriberDelivered: Boolean(r.subscriberDelivered),
      paperStatus: r.paperStatus ?? null,
      paperTradeId: num(r.paperTradeId),
      trackedPct: num(r.returnPct),
      exitReason: r.exitReason ?? null,
      // Bid-convention peak from the shadow exit research, kept for transparency.
      // The PUBLISHED peak is reconciled onto the executable convention downstream so
      // it is directly comparable to the canonical exit.
      peakPct: happened != null ? num(happened.bestGainPct) : null,
      marks: tradeId != null ? (marks.get(tradeId) ?? []) : [],
      exitFill: num(exit?.exit_fill),
      exitAtMs: num(exit?.exit_at_ms),
      markCount: tradeId != null ? (marks.get(tradeId)?.length ?? 0) : 0,
      gaveBackProfit: Boolean(happened?.gaveBackProfit),
      verifiedPnlEligible: Boolean(r.verifiedPnlEligible),
      pnlClassification: r.pnlClassification ?? null,
      pnlExclusionReasons: Array.isArray(r.pnlExclusionReasons) ? r.pnlExclusionReasons : [],
      openedAtMs: num(r.sentAtMs),
      setupReason: setupReasonFrom(ev?.message),
    });
  }
  return rows;
}

/**
 * Research-only rows. These have no subscriber delivery proof by definition, so they
 * are marked as such and can never satisfy the verified-subscriber gate.
 */
export function loadResearchOnlyRows(db: SourceDb): RecapInputRow[] {
  if (!hasTable(db, "options_alerts")) return [];
  const rows: RecapInputRow[] = [];
  try {
    const alerts = db.prepare(`
      SELECT a.alert_id, a.candidate_symbol, a.option_symbol, a.delivered_bid, a.delivered_ask,
             a.quote_ts_ms, a.discord_message_id, a.thesis_fingerprint, a.opportunity_case_id,
             a.sent_at_ms, a.created_at_ms, a.entry_mid, a.message, a.paper_trade_id
      FROM options_alerts a
      WHERE a.research_only = 1
    `).all() as any[];
    for (const a of alerts) {
      let paper: any = null;
      if (hasTable(db, "options_paper_trades") && a.paper_trade_id != null) {
        paper = db.prepare("SELECT * FROM options_paper_trades WHERE id=?").get(Number(a.paper_trade_id));
      }
      rows.push({
        lane: "RESEARCH_ONLY",
        alertId: String(a.alert_id),
        opportunityCaseId: a.opportunity_case_id ?? null,
        symbol: String(a.candidate_symbol ?? ""),
        optionSymbol: a.option_symbol ?? null,
        thesisKey: a.thesis_fingerprint ?? null,
        frozenEntry: num(paper?.entry_fill) ?? num(a.entry_mid),
        entryBid: num(a.delivered_bid),
        entryAsk: num(a.delivered_ask),
        entryQuoteTsMs: num(a.quote_ts_ms),
        discordMessageId: a.discord_message_id ?? null,
        // Research rows are never subscriber-delivered, regardless of any other field.
        subscriberDelivered: false,
        paperStatus: paper?.status ?? null,
        paperTradeId: num(a.paper_trade_id),
        trackedPct: num(paper?.return_pct),
        exitReason: paper?.exit_reason ?? null,
        peakPct: num(paper?.mfe_pct),
        markCount: null,
        gaveBackProfit: isNum(num(paper?.mfe_pct)) && isNum(num(paper?.return_pct))
          ? (num(paper?.mfe_pct) as number) >= 10 && (num(paper?.return_pct) as number) <= 0
          : false,
        verifiedPnlEligible: false,
        pnlClassification: "RESEARCH_ONLY",
        pnlExclusionReasons: ["research_only_lane"],
        openedAtMs: num(a.sent_at_ms) ?? num(a.created_at_ms),
        setupReason: setupReasonFrom(a.message),
      });
    }
  } catch { /* research lane unavailable ⇒ empty section, never inferred */ }
  return rows;
}

/**
 * Watchlist observations.
 *
 * There is no outcome tracking for Watchlist plans, so nothing here invents a price
 * result. A Watchlist row is surfaced ONLY when the same symbol later produced a
 * verified subscriber callout inside the window — a link that is actually provable.
 * Its numbers come from that verified callout and are reported in the Watchlist
 * section for context, never added to the subscriber totals.
 */
export function loadWatchlistRows(
  db: SourceDb,
  verifiedRows: RecapInputRow[],
  windowStartMs: number,
  windowEndMs: number,
): RecapInputRow[] {
  if (!hasTable(db, "watchlist_version_symbols")) return [];
  let planned: Set<string>;
  try {
    const rows = db.prepare(`
      SELECT DISTINCT s.symbol AS symbol
      FROM watchlist_version_symbols s
      JOIN watchlist_versions v ON v.version_id = s.version_id
      WHERE v.built_at_ms >= ? AND v.built_at_ms < ?
    `).all(windowStartMs - 7 * 86_400_000, windowEndMs) as Array<{ symbol: string }>;
    planned = new Set(rows.map((r) => String(r.symbol).toUpperCase()));
  } catch {
    return [];
  }
  if (planned.size === 0) return [];
  return verifiedRows
    .filter((r) => planned.has(String(r.symbol).toUpperCase()))
    .map((r) => ({ ...r, lane: "WATCHLIST" as CalloutLane }));
}

export interface LoadedRecapRows {
  rows: RecapInputRow[];
  laneCounts: Record<CalloutLane, number>;
}

/** Assemble every lane. Reads only; performs no arithmetic. */
export function loadRecapRows(
  db: SourceDb,
  windowStartMs: number,
  windowEndMs: number,
  opts: { verifiedSubscriberOnly?: boolean; includeWatchlist?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): LoadedRecapRows {
  const verified = loadVerifiedSubscriberRows(db, env);
  const research = opts.verifiedSubscriberOnly ? [] : loadResearchOnlyRows(db);
  const watchlist = opts.verifiedSubscriberOnly || opts.includeWatchlist === false
    ? []
    : loadWatchlistRows(db, verified, windowStartMs, windowEndMs);
  return {
    rows: [...verified, ...research, ...watchlist],
    laneCounts: {
      VERIFIED_SUBSCRIBER: verified.length,
      RESEARCH_ONLY: research.length,
      WATCHLIST: watchlist.length,
    },
  };
}

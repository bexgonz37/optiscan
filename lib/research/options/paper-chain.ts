/**
 * Independent-path paper chain diagnostic — SENT → DELIVERED_ALERT_PAPER → case → grader.
 * Owner-only operational visibility; never mutates production state.
 */
import { buildOptionsPaperLifecycle } from "../../paper-lifecycle.ts";
import { readGradingBacklogOnDb } from "./grade.ts";
import { findOpportunityCaseIdByAlertOnDb, loadCaseJsonOnDb } from "../../opportunity-case/live.ts";
import { isOptionsQuoteSession } from "../../market-session-guard.ts";
import {
  analyzeExitPolicies,
  type ExitPolicyResearchReport,
  type ExitResearchTrade,
  type TradeExitResearch,
} from "./exit-policy-research.ts";

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
  markQuoteAgeMs: number | null;
  verifiedPnlEligible: boolean;
  pnlExclusionReasons: string[];
  deliveryProofStatus: "verified_delivered" | "app_sent_unverified" | "missing_mirror" | "not_sent" | "unknown";
  subscriberDelivered: boolean;
  graderHealth: "healthy" | "stuck_open" | "missing_mirror" | "missing_case" | "historical_pre_lifecycle" | "unknown";
  missingDataWarnings: string[];
  lifecycleBlocked: boolean;
  blockingReason: string | null;
  currentStage: string | null;
  pnlClassification:
    | "VERIFIED_REALIZED"
    | "VERIFIED_OPEN_MARK"
    | "MISSING_MIRROR"
    | "AUDIT_ONLY"
    | "INVALID_ENTRY"
    | "INVALID_EXIT"
    | "STALE_MARK"
    | "DUPLICATE_POSITION"
    | "UNLINKED_DELIVERY";
  whatHappened: TradeExitResearch | null;
}

export interface PaperChainDiagnostic {
  generatedAtMs: number;
  dataSourceLabel: "Production database";
  /**
   * FULL — every SENT alert in the window, and the aggregates below describe it.
   * OPEN_POSITIONS_ONLY — only the currently-open delivered mirrors, and every
   * aggregate is deliberately left null because summing the trades that happen to be
   * open right now is a survivorship-biased number, not a smaller true one.
   */
  scope: "FULL" | "OPEN_POSITIONS_ONLY";
  selectedWindow: {
    label: string;
    days: number | null;
    minSentAtMs: number | null;
  };
  paperLinkRate: number | null;
  sent24h: number;
  linked24h: number;
  /** Sum of closed delivered `pnl` dollars in the sampled rows. */
  sumPnlUsd: number | null;
  /** Sum of closed rows with Discord message + Opportunity Case proof. */
  verifiedSumPnlUsd: number | null;
  verifiedPnlBreakdown: {
    realizedClosedPnlUsd: number;
    openMarkToMarketPnlUsd: number;
    feesAndSlippageUsd: number;
    verifiedTotalPnlUsd: number;
    auditOnlyRowsExcluded: number;
    missingMirrorRowsExcluded: number;
    invalidOrStaleMarkRowsExcluded: number;
    duplicatePositionsExcluded: number;
    unverifiedEntryOrExitRowsExcluded: number;
    excludedPnlUsd: number;
    validTrades: number;
    excludedTrades: number;
  } | null;
  /** Null under OPEN_POSITIONS_ONLY: unfinished trades cannot support exit research. */
  exitPolicyResearch: ExitPolicyResearchReport | null;
  rows: PaperChainRow[];
  gradingBacklog: ReturnType<typeof readGradingBacklogOnDb>;
  account: {
    identifier: "delivered_options";
    label: "Delivered Options Paper";
    startingBalanceUsd: number;
    /** Null under OPEN_POSITIONS_ONLY — see `scope`. */
    currentEquityUsd: number | null;
  };
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

function validStoredMark(
  mark: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv,
  maxMarkAgeMs: number,
): boolean {
  if (!mark) return false;
  const markAtMs = mark.mark_at_ms != null ? Number(mark.mark_at_ms) : null;
  const createdAtMs = mark.created_at_ms != null ? Number(mark.created_at_ms) : null;
  const quoteAgeMs = mark.quote_age_ms != null ? Number(mark.quote_age_ms) : null;
  const persistedDelayMs = markAtMs != null && createdAtMs != null ? createdAtMs - markAtMs : null;
  return Boolean(
    mark.bid != null
    && Number.isFinite(Number(mark.bid))
    && Number(mark.bid) > 0
    && mark.ask != null
    && Number.isFinite(Number(mark.ask))
    && Number(mark.ask) >= Number(mark.bid)
    && mark.exit_fill != null
    && Number.isFinite(Number(mark.exit_fill))
    && mark.return_pct != null
    && Number.isFinite(Number(mark.return_pct))
    && quoteAgeMs != null
    && Number.isFinite(quoteAgeMs)
    && quoteAgeMs >= 0
    && quoteAgeMs <= maxMarkAgeMs
    && markAtMs != null
    && isOptionsQuoteSession(markAtMs, env)
    && persistedDelayMs != null
    && persistedDelayMs >= 0
    && persistedDelayMs <= maxMarkAgeMs
  );
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
  /**
   * OPEN_POSITIONS_ONLY (2026-08-18 audit) — the homepage needs the handful of
   * currently-open delivered mirrors and nothing else, but the full diagnostic walks
   * EVERY alert ever SENT (three to five queries each) and only slices to `limit` at
   * the very end. That cost the homepage five to nine seconds per load, twice.
   *
   * This scope does NOT introduce a second definition of an open position: the driving
   * set is narrowed to alerts that already have an ENTERED DELIVERED_ALERT_PAPER mirror,
   * and every row is then built by the SAME code below. What it deliberately does NOT do
   * is publish aggregates: a profit factor, an equity figure or an exit-policy study over
   * "only the trades that happen to be open right now" is a survivorship-biased number, so
   * those fields are left null and `scope` says why. Callers that need evidence must ask
   * for the full diagnostic.
   */
  scope: "FULL" | "OPEN_POSITIONS_ONLY" = "FULL",
): PaperChainDiagnostic {
  const nowMs = Date.now();
  const since = nowMs - 24 * 3600_000;
  const configuredStart = Number(env.PAPER_DELIVERED_OPTIONS_STARTING_BALANCE_USD ?? "100000");
  const startingBalanceUsd = Number.isFinite(configuredStart) && configuredStart > 0 ? configuredStart : 100_000;
  const selectedDays = minSentAtMs == null
    ? null
    : Math.max(1, Math.round((nowMs - minSentAtMs) / 86_400_000));
  const out: PaperChainDiagnostic = {
    generatedAtMs: nowMs,
    dataSourceLabel: "Production database",
    scope,
    selectedWindow: {
      label: selectedDays == null ? "All available history" : `Last ${selectedDays} days`,
      days: selectedDays,
      minSentAtMs,
    },
    paperLinkRate: null,
    sent24h: 0,
    linked24h: 0,
    sumPnlUsd: null,
    verifiedSumPnlUsd: null,
    verifiedPnlBreakdown: {
      realizedClosedPnlUsd: 0,
      openMarkToMarketPnlUsd: 0,
      feesAndSlippageUsd: 0,
      verifiedTotalPnlUsd: 0,
      auditOnlyRowsExcluded: 0,
      missingMirrorRowsExcluded: 0,
      invalidOrStaleMarkRowsExcluded: 0,
      duplicatePositionsExcluded: 0,
      unverifiedEntryOrExitRowsExcluded: 0,
      excludedPnlUsd: 0,
      validTrades: 0,
      excludedTrades: 0,
    },
    exitPolicyResearch: analyzeExitPolicies([]),
    rows: [],
    gradingBacklog: readGradingBacklogOnDb(db as any),
    account: {
      identifier: "delivered_options",
      label: "Delivered Options Paper",
      startingBalanceUsd,
      currentEquityUsd: startingBalanceUsd,
    },
  };

  if (!hasTable(db, "options_alerts")) return out;

  out.sent24h = Number((db.prepare(
    "SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND sent_at_ms >= ? AND research_only=0",
  ).get(since) as { n: number })?.n ?? 0);
  out.linked24h = Number((db.prepare(
    "SELECT COUNT(*) n FROM options_alerts WHERE state='SENT' AND paper_linked=1 AND sent_at_ms >= ? AND research_only=0",
  ).get(since) as { n: number })?.n ?? 0);
  out.paperLinkRate = out.sent24h ? +(out.linked24h / out.sent24h).toFixed(4) : null;

  const alerts = scope === "OPEN_POSITIONS_ONLY"
    // Driven from the mirror side: `idx_options_paper_kind_status` answers this
    // directly, so the walk below visits only currently-open positions instead of
    // every alert in history.
    ? (db.prepare(
      `SELECT a.* FROM options_alerts a
         JOIN options_paper_trades p ON p.alert_id = a.alert_id
        WHERE p.paper_kind='DELIVERED_ALERT_PAPER' AND p.status='ENTERED'
          AND a.state='SENT' AND a.research_only=0
        GROUP BY a.alert_id
        ORDER BY a.sent_at_ms DESC`,
    ).all() as Record<string, unknown>[])
    : minSentAtMs != null
      ? db.prepare(
        `SELECT * FROM options_alerts
         WHERE state='SENT' AND research_only=0 AND sent_at_ms IS NOT NULL AND sent_at_ms >= ?
         ORDER BY sent_at_ms DESC`,
      ).all(minSentAtMs) as Record<string, unknown>[]
      : db.prepare(
        `SELECT * FROM options_alerts
         WHERE state='SENT' AND research_only=0
         ORDER BY sent_at_ms DESC`,
      ).all() as Record<string, unknown>[];

  const researchTrades: ExitResearchTrade[] = [];

  for (const alert of alerts) {
    const alertId = String(alert.alert_id);
    const linkedPaperId = alert.paper_trade_id != null ? Number(alert.paper_trade_id) : null;
    const alertPaperRows = hasTable(db, "options_paper_trades")
      ? db.prepare(
        "SELECT * FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER' ORDER BY id ASC",
      ).all(alertId) as Record<string, unknown>[]
      : [];
    const linkedPaper = hasTable(db, "options_paper_trades") && linkedPaperId != null && Number.isFinite(linkedPaperId)
      ? db.prepare(
        "SELECT * FROM options_paper_trades WHERE id=? AND paper_kind='DELIVERED_ALERT_PAPER'",
      ).get(linkedPaperId) as Record<string, unknown> | undefined
      : undefined;
    const paper = linkedPaper ?? alertPaperRows[0];
    // Mirrors attributable to THIS alert only. thesis_fingerprint is deliberately broad
    // (symbol|direction|optionType|sessionDate), so it is shared by legitimate sequential
    // re-entries on the same session thesis — joining on it would flag those distinct,
    // correctly-mirrored owner alerts as duplicates of each other.
    const paperRows = [...new Map(
      [...alertPaperRows, ...(linkedPaper ? [linkedPaper] : [])]
        .map((row) => [Number(row.id), row]),
    ).values()];
    const paperMarks = paper?.id != null && hasTable(db, "options_paper_marks")
      ? db.prepare(
        `SELECT bid, ask, exit_fill, return_pct, quote_age_ms, mark_at_ms, created_at_ms
         FROM options_paper_marks WHERE trade_id=? ORDER BY mark_at_ms ASC`,
      ).all(paper.id) as Record<string, unknown>[]
      : [];
    const latestMark = paperMarks.at(-1);
    const caseId = alert.opportunity_case_id
      ? String(alert.opportunity_case_id)
      : findOpportunityCaseIdByAlertOnDb(db as any, alertId);
    const lifecycle = buildOptionsPaperLifecycle(db as any, { alertId });
    const proof = deliveryProofForRow(alert, paper ?? null, caseId);
    const maxMarkAgeMs = Math.max(1_000, Number(env.OPTIONS_GRADE_MAX_QUOTE_AGE_MS ?? 900_000));
    const entryFill = paper?.entry_fill != null ? Number(paper.entry_fill) : null;
    const entryValid = entryFill != null && Number.isFinite(entryFill) && entryFill > 0;
    const exitAtMs = paper?.exit_at_ms != null ? Number(paper.exit_at_ms) : null;
    const exitFill = paper?.exit_fill != null ? Number(paper.exit_fill) : null;
    const matchingExitMark = paper?.status === "EXITED"
      ? paperMarks.find((candidate) => {
        if (exitAtMs == null || exitFill == null) return false;
        const markAt = Number(candidate.mark_at_ms);
        const markExit = Number(candidate.exit_fill);
        return Number.isFinite(markAt)
          && Number.isFinite(markExit)
          && Math.abs(markAt - exitAtMs) <= 120_000
          && Math.abs(markExit - exitFill) <= 0.01;
      })
      : null;
    const exitValid = paper?.status !== "EXITED"
      || (
        exitAtMs != null
        && Number.isFinite(exitAtMs)
        && exitFill != null
        && Number.isFinite(exitFill)
        && validStoredMark(matchingExitMark, env, maxMarkAgeMs)
      );
    const gradingMark = paper?.status === "EXITED" ? matchingExitMark : latestMark;
    const mark = gradingMark?.exit_fill != null && Number.isFinite(Number(gradingMark.exit_fill))
      ? Number(gradingMark.exit_fill)
      : paper?.last_mark_return_pct != null
        ? Number(paper.entry_fill) * (1 + Number(paper.last_mark_return_pct) / 100)
        : (paper?.entry_fill != null ? Number(paper.entry_fill) : null);
    const hits = t1T2StopHit({ ...alert, ...paper }, mark);
    const markQuoteAgeMs = gradingMark?.quote_age_ms != null ? Number(gradingMark.quote_age_ms) : null;
    const markValid = validStoredMark(gradingMark, env, maxMarkAgeMs);
    const pnlExclusionReasons: string[] = [];
    if (!proof.subscriberDelivered) pnlExclusionReasons.push("delivery_proof_incomplete");
    if (!paper) pnlExclusionReasons.push("missing_paper_mirror");
    if (paper && !entryValid) pnlExclusionReasons.push("invalid_entry");
    if (paper && !markValid) pnlExclusionReasons.push("missing_or_invalid_grading_mark");
    if (paperRows.length > 1) pnlExclusionReasons.push("duplicate_position");
    if (paper?.status === "EXITED" && !exitValid) {
      pnlExclusionReasons.push("missing_exit_proof");
    }
    const verifiedPnlEligible = proof.subscriberDelivered
      && Boolean(paper)
      && entryValid
      && markValid
      && exitValid
      && paperRows.length === 1;

    const sentAtMs = alert.sent_at_ms != null ? Number(alert.sent_at_ms) : null;
    const frozenEntry = entryValid ? entryFill : (alert.entry_mid != null ? Number(alert.entry_mid) : null);
    let pnlUsd: number | null = null;
    if (paper?.pnl != null && Number.isFinite(Number(paper.pnl))) {
      pnlUsd = +Number(paper.pnl).toFixed(2);
    } else if (frozenEntry != null && mark != null && Number.isFinite(frozenEntry) && Number.isFinite(mark)) {
      pnlUsd = +((mark - frozenEntry) * 100).toFixed(2);
    }
    const pnlClassification: PaperChainRow["pnlClassification"] = !paper
      ? "MISSING_MIRROR"
      : !proof.subscriberDelivered
        ? (caseId ? "AUDIT_ONLY" : "UNLINKED_DELIVERY")
        : !entryValid
          ? "INVALID_ENTRY"
          : paperRows.length > 1
            ? "DUPLICATE_POSITION"
            : !markValid
              ? "STALE_MARK"
              : !exitValid
                ? "INVALID_EXIT"
                : paper.status === "EXITED"
                  ? "VERIFIED_REALIZED"
                  : "VERIFIED_OPEN_MARK";
    if (paper?.id != null && verifiedPnlEligible && paper.entered_at_ms != null) {
      researchTrades.push({
        tradeId: Number(paper.id),
        alertId,
        symbol: String(alert.candidate_symbol ?? ""),
        side: String(paper.side ?? alert.side ?? ""),
        optionSymbol: String(paper.option_symbol ?? alert.option_symbol ?? ""),
        dte: paper.dte != null ? Number(paper.dte) : null,
        strategyFamily: paper.strategy_family != null
          ? String(paper.strategy_family)
          : (paper.strategy != null ? String(paper.strategy) : null),
        marketRegime: paper.market_regime != null ? String(paper.market_regime) : null,
        timeBucket: paper.time_bucket != null ? String(paper.time_bucket) : null,
        entryQuality: alert.entry_quality_verdict != null ? String(alert.entry_quality_verdict) : null,
        entryFill: entryFill as number,
        enteredAtMs: Number(paper.entered_at_ms),
        targetT1: alert.target_t1 != null ? Number(alert.target_t1) : (paper.target != null ? Number(paper.target) : null),
        targetT2: alert.target_t2 != null ? Number(alert.target_t2) : null,
        stop: alert.target_stop != null ? Number(alert.target_stop) : (paper.invalidation != null ? Number(paper.invalidation) : null),
        status: String(paper.status ?? ""),
        exitFill,
        exitAtMs,
        canonicalReturnPct: paper.return_pct != null ? Number(paper.return_pct) : null,
        exitReason: paper.exit_reason != null ? String(paper.exit_reason) : null,
        marks: paperMarks.map((candidate) => ({
          markAtMs: Number(candidate.mark_at_ms),
          bid: candidate.bid != null ? Number(candidate.bid) : null,
          ask: candidate.ask != null ? Number(candidate.ask) : null,
          quoteAgeMs: candidate.quote_age_ms != null ? Number(candidate.quote_age_ms) : null,
          createdAtMs: candidate.created_at_ms != null ? Number(candidate.created_at_ms) : null,
        })),
      });
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
      markQuoteAgeMs,
      verifiedPnlEligible,
      pnlExclusionReasons,
      deliveryProofStatus: proof.status,
      subscriberDelivered: proof.subscriberDelivered,
      graderHealth: graderHealthForRow(alert, paper ?? null, caseId),
      missingDataWarnings: proof.warnings,
      lifecycleBlocked: lifecycle?.blocked ?? false,
      blockingReason: lifecycle?.blockingReason ?? null,
      currentStage: lifecycle?.currentStage ?? null,
      pnlClassification,
      whatHappened: null,
    });
  }

  const activeKeys = new Set<string>();
  let duplicatePositionsExcluded = out.rows.filter((row) => row.pnlClassification === "DUPLICATE_POSITION").length;
  for (const row of out.rows) {
    if (row.paperStatus !== "ENTERED") continue;
    const key = row.opportunityCaseId ?? `alert:${row.alertId}`;
    if (activeKeys.has(key)) {
      if (row.pnlClassification !== "DUPLICATE_POSITION") duplicatePositionsExcluded += 1;
      row.verifiedPnlEligible = false;
      row.pnlExclusionReasons.push("duplicate_active_position");
      row.pnlClassification = "DUPLICATE_POSITION";
    } else {
      activeKeys.add(key);
    }
  }

  if (scope === "OPEN_POSITIONS_ONLY") {
    // Stop here on purpose. Everything below aggregates the rows into evidence —
    // realized P&L, account equity and the exit-policy study — and this scope holds
    // only the positions that are open at this instant. Summing those would report a
    // profit figure computed from the trades that have not finished yet, which is a
    // survivorship-biased number wearing the same field name as the real one. The
    // fields stay at their null/zero initial values and `scope` records why.
    out.selectedWindow = {
      label: "Currently-open delivered mirrors",
      days: null,
      minSentAtMs: null,
    };
    // Explicitly null rather than left at their zero initial values. A
    // `verifiedTotalPnlUsd: 0` reads as "this book made nothing", which is a claim;
    // null is the absence of one, and it is what a consumer must be forced to handle.
    out.verifiedPnlBreakdown = null;
    out.exitPolicyResearch = null;
    out.account.currentEquityUsd = null;
    out.rows = out.rows.slice(0, Math.max(1, limit));
    return out;
  }

  const eligibleTradeIds = new Set(
    out.rows
      .filter((row) => row.verifiedPnlEligible && row.paperTradeId != null)
      .map((row) => row.paperTradeId as number),
  );
  out.exitPolicyResearch = analyzeExitPolicies(
    researchTrades.filter((trade) => eligibleTradeIds.has(trade.tradeId)),
    {
      maxQuoteAgeMs: Math.max(1_000, Number(env.OPTIONS_GRADE_MAX_QUOTE_AGE_MS ?? 900_000)),
      minimumSupportedSample: Math.max(5, Number(env.EXIT_POLICY_MIN_SAMPLE ?? 30)),
    },
  );
  const exitResearchByTrade = new Map(
    out.exitPolicyResearch.trades.map((trade) => [trade.tradeId, trade]),
  );
  for (const row of out.rows) {
    row.whatHappened = row.paperTradeId != null
      ? exitResearchByTrade.get(row.paperTradeId) ?? null
      : null;
  }

  const closedPnls = out.rows
    .filter((r) => r.paperStatus === "EXITED" && r.pnlUsd != null)
    .map((r) => r.pnlUsd as number);
  out.sumPnlUsd = closedPnls.length
    ? +closedPnls.reduce((a, x) => a + x, 0).toFixed(2)
    : null;
  const verifiedClosedPnls = out.rows
    .filter((r) => r.verifiedPnlEligible && r.paperStatus === "EXITED" && r.pnlUsd != null)
    .map((r) => r.pnlUsd as number);
  out.verifiedSumPnlUsd = verifiedClosedPnls.length
    ? +verifiedClosedPnls.reduce((a, x) => a + x, 0).toFixed(2)
    : null;
  const verifiedOpenPnl = out.rows
    .filter((r) => r.verifiedPnlEligible && r.paperStatus === "ENTERED" && r.pnlUsd != null)
    .reduce((sum, row) => sum + Number(row.pnlUsd), 0);
  const excludedPnlUsd = out.rows
    .filter((row) => !row.verifiedPnlEligible && row.pnlUsd != null)
    .reduce((sum, row) => sum + Number(row.pnlUsd), 0);
  const validTrades = out.rows.filter((row) => row.verifiedPnlEligible).length;
  const excludedTrades = out.rows.length - validTrades;
  out.verifiedPnlBreakdown = {
    realizedClosedPnlUsd: +(out.verifiedSumPnlUsd ?? 0).toFixed(2),
    openMarkToMarketPnlUsd: +verifiedOpenPnl.toFixed(2),
    feesAndSlippageUsd: 0,
    verifiedTotalPnlUsd: +((out.verifiedSumPnlUsd ?? 0) + verifiedOpenPnl).toFixed(2),
    auditOnlyRowsExcluded: out.rows.filter((r) => !r.subscriberDelivered).length,
    missingMirrorRowsExcluded: out.rows.filter((r) => r.deliveryProofStatus === "missing_mirror").length,
    invalidOrStaleMarkRowsExcluded: out.rows.filter((r) => r.pnlExclusionReasons.includes("missing_or_invalid_grading_mark")).length,
    duplicatePositionsExcluded,
    unverifiedEntryOrExitRowsExcluded: out.rows.filter((r) =>
      r.pnlExclusionReasons.includes("delivery_proof_incomplete")
      || r.pnlExclusionReasons.includes("missing_exit_proof")
    ).length,
    excludedPnlUsd: +excludedPnlUsd.toFixed(2),
    validTrades,
    excludedTrades,
  };
  out.account.currentEquityUsd = +(startingBalanceUsd + (out.verifiedSumPnlUsd ?? 0) + verifiedOpenPnl).toFixed(2);
  out.rows = out.rows.slice(0, Math.max(1, limit));

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
  const linkedPaperId = alert.paper_trade_id != null ? Number(alert.paper_trade_id) : null;
  const paper = hasTable(db, "options_paper_trades")
    ? (linkedPaperId != null && Number.isFinite(linkedPaperId)
      ? db.prepare(
        "SELECT * FROM options_paper_trades WHERE id=? AND paper_kind='DELIVERED_ALERT_PAPER'",
      ).get(linkedPaperId) as Record<string, unknown> | undefined
      : db.prepare(
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
  const diagnosticRows = buildPaperChainDiagnostic(db, process.env, 10_000).rows;
  const diagnostic = diagnosticRows.find((r) => r.alertId === alertId) ?? null;
  const lifecycleObservations = hasTable(db, "options_lifecycle_observations") && paper?.id != null
    ? db.prepare(
      `SELECT event_type, decision, reason, quote_ts_ms, observed_at_ms, bid, ask, created_at_ms
       FROM options_lifecycle_observations WHERE paper_trade_id=? ORDER BY created_at_ms ASC`,
    ).all(paper.id)
    : [];
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
    exitPolicyResearch: diagnostic?.whatHappened ?? null,
    lifecycleObservations,
  };
}

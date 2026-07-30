/**
 * professional-publication.ts — the ONE path by which a professional Watchlist
 * plan reaches Discord.
 *
 * Boundaries this module enforces, in order:
 *   1. FLAG      — nothing happens unless PROFESSIONAL_WATCHLIST_ENABLED=1.
 *   2. BUILD     — the bounded runner produces and persists the plan.
 *   3. SCREEN    — every outgoing message passes screenWatchlistCopy. Rejected
 *                  copy is NEVER sent; the violations are recorded instead.
 *   4. DEDUPE    — an unchanged payload for the same day+phase is suppressed, so
 *                  a repeated scheduler beat cannot double-publish.
 *   5. SEND      — via sendOwnerResearchNotify to the OWNER/PRIVATE watchlist
 *                  destination only. This is not a subscriber alert path: it
 *                  cannot create an alert, select a contract, or touch paper.
 *
 * Every step is contained. A build, screen, dedupe, or send failure returns a
 * result with a reason — it never throws — so it can never abort the caller's
 * scheduled job or the legacy plan that runs beside it.
 */
import { researchFlags } from "../flags.ts";
import { formatOvernightWatchlist, formatPremarketWatchlistUpdate, screenWatchlistCopy } from "./professional-discord.ts";
import { runProfessionalWatchlistOnDb, type ProfessionalWatchlistDeps } from "./professional-runner.ts";
import type { WatchlistPhase, WatchlistPlan } from "./professional-plan.ts";

type PublicationDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

/** The owner-notify kind each phase publishes under. Private destinations only. */
const NOTIFY_KIND: Record<WatchlistPhase, "next_session_watchlist" | "premarket_watchlist_update"> = {
  OVERNIGHT_PLAN: "next_session_watchlist",
  PREMARKET_UPDATE: "premarket_watchlist_update",
};

export type PublicationOutcome =
  | "DISABLED"
  | "BUILD_FAILED"
  | "COPY_REJECTED"
  | "SUPPRESSED_UNCHANGED"
  | "SENT"
  | "SEND_FAILED"
  | "SEND_SKIPPED";

export interface ProfessionalPublicationResult {
  ranAtMs: number;
  tradingDay: string;
  phase: WatchlistPhase;
  flagEnabled: boolean;
  outcome: PublicationOutcome;
  reason: string | null;
  /** Universe symbols the build considered. */
  rowsConsidered: number;
  /** Rows that passed the publication gate. */
  rowsPublished: number;
  /** Rows withheld by the publication gate. */
  rowsWithheld: number;
  /** Rows that never reached Discord because copy screening rejected the message. */
  rowsRejectedByCopyScreen: number;
  copyViolations: string[];
  /** True when this exact payload had already been published for this day+phase. */
  duplicateSuppressed: boolean;
  payloadHash: string | null;
  messageId: string | null;
  derivedFromPlanVersion: string | null;
  premarketEvidenceExcluded: Array<{ symbol: string; reason: string }>;
  errors: string[];
}

export interface PublishDeps {
  runner: ProfessionalWatchlistDeps;
  /** Injected so the publication path is testable without Discord. */
  sendNotify?: (opts: {
    db: PublicationDb;
    kind: "next_session_watchlist" | "premarket_watchlist_update";
    content: string;
    symbol?: string;
    nowMs?: number;
    env?: NodeJS.ProcessEnv;
  }) => Promise<{ sent: boolean; skipped: boolean; reason: string; messageId?: string | null }>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function ensureLog(db: PublicationDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist_professional_publications (
      trading_day TEXT NOT NULL,
      phase TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      outcome TEXT NOT NULL,
      rows_published INTEGER NOT NULL DEFAULT 0,
      message_id TEXT,
      published_at_ms INTEGER NOT NULL,
      PRIMARY KEY (trading_day, phase, payload_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_pro_publications_day
      ON watchlist_professional_publications(trading_day, phase, published_at_ms);
  `);
}

/**
 * Has this exact payload already been PUBLISHED for this day and phase?
 * Only a SENT row suppresses: a previous rejection or failure must not stop a
 * later corrected attempt.
 */
function alreadyPublished(db: PublicationDb, day: string, phase: WatchlistPhase, hash: string): boolean {
  try {
    ensureLog(db);
    return Boolean(db.prepare(
      `SELECT 1 FROM watchlist_professional_publications
        WHERE trading_day = ? AND phase = ? AND payload_hash = ? AND outcome = 'SENT'`,
    ).get(day, phase, hash));
  } catch {
    // A log failure must never cause a double-send, so fail CLOSED: treat an
    // unreadable log as "already published" and skip this beat.
    return true;
  }
}

function recordPublication(
  db: PublicationDb,
  day: string,
  phase: WatchlistPhase,
  hash: string,
  outcome: PublicationOutcome,
  rowsPublished: number,
  messageId: string | null,
  nowMs: number,
): void {
  try {
    ensureLog(db);
    db.prepare(
      `INSERT OR REPLACE INTO watchlist_professional_publications
        (trading_day, phase, payload_hash, outcome, rows_published, message_id, published_at_ms)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(day, phase, hash, outcome, rowsPublished, messageId, nowMs);
  } catch { /* diagnostics only — never fail the run over the log */ }
}

/** Read the most recent publication rows, for read-only diagnostics. */
export function loadRecentPublicationsOnDb(
  db: PublicationDb,
  limit = 20,
): Array<{
  tradingDay: string; phase: string; payloadHash: string; outcome: string;
  rowsPublished: number; messageId: string | null; publishedAtMs: number;
}> {
  try {
    ensureLog(db);
    const rows = db.prepare(
      `SELECT trading_day, phase, payload_hash, outcome, rows_published, message_id, published_at_ms
         FROM watchlist_professional_publications
        ORDER BY published_at_ms DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(200, limit))) as any[];
    return rows.map((r) => ({
      tradingDay: String(r.trading_day),
      phase: String(r.phase),
      payloadHash: String(r.payload_hash),
      outcome: String(r.outcome),
      rowsPublished: Number(r.rows_published ?? 0),
      // The message id is a Discord message identifier, not a webhook or secret.
      messageId: r.message_id == null ? null : String(r.message_id),
      publishedAtMs: Number(r.published_at_ms ?? 0),
    }));
  } catch {
    return [];
  }
}

function emptyResult(
  nowMs: number, day: string, phase: WatchlistPhase, flagEnabled: boolean,
  outcome: PublicationOutcome, reason: string | null,
): ProfessionalPublicationResult {
  return {
    ranAtMs: nowMs, tradingDay: day, phase, flagEnabled, outcome, reason,
    rowsConsidered: 0, rowsPublished: 0, rowsWithheld: 0, rowsRejectedByCopyScreen: 0,
    copyViolations: [], duplicateSuppressed: false, payloadHash: null, messageId: null,
    derivedFromPlanVersion: null, premarketEvidenceExcluded: [], errors: [],
  };
}

/** Render one phase's message. Kept beside the screen so neither can drift. */
export function renderPlanMessage(plan: WatchlistPlan): string {
  return plan.phase === "PREMARKET_UPDATE"
    ? formatPremarketWatchlistUpdate(plan)
    : formatOvernightWatchlist(plan);
}

/**
 * Build, screen, dedupe, and publish one phase. Never throws.
 */
export async function publishProfessionalWatchlist(
  db: PublicationDb,
  deps: PublishDeps,
  phase: WatchlistPhase,
): Promise<ProfessionalPublicationResult> {
  const nowMs = deps.now?.() ?? Date.now();
  const env = deps.env ?? process.env;
  const flagEnabled = researchFlags(env).professionalWatchlist;

  try {
    if (!flagEnabled) {
      // Hard stop: no build, no provider call, no write, no send.
      const { tradingDay } = await import("../../trading-session.ts");
      return emptyResult(nowMs, tradingDay(nowMs), phase, false, "DISABLED", "PROFESSIONAL_WATCHLIST_ENABLED is not set");
    }

    const run = await runProfessionalWatchlistOnDb(
      db as any,
      { ...deps.runner, now: () => nowMs, env },
      { phase },
    );
    if (!run.ran || !run.plan) {
      const res = emptyResult(nowMs, run.tradingDay, phase, flagEnabled, "BUILD_FAILED", run.reason ?? "build produced no plan");
      res.errors = run.errors;
      return res;
    }

    const plan = run.plan;
    const base: ProfessionalPublicationResult = {
      ranAtMs: nowMs,
      tradingDay: plan.tradingDay,
      phase,
      flagEnabled,
      outcome: "SENT",
      reason: null,
      rowsConsidered: run.symbolsConsidered,
      rowsPublished: plan.rows.length,
      rowsWithheld: plan.needsMoreData.length,
      rowsRejectedByCopyScreen: 0,
      copyViolations: [],
      duplicateSuppressed: false,
      payloadHash: null,
      messageId: null,
      derivedFromPlanVersion: plan.derivedFromPlanVersion,
      premarketEvidenceExcluded: plan.diagnostics.premarketEvidenceExcluded,
      errors: run.errors.slice(),
    };

    const content = renderPlanMessage(plan);
    const hash = djb2(content);
    base.payloadHash = hash;

    // SCREEN BEFORE ANYTHING ELSE CAN SEND. Rejected copy stops here.
    const screen = screenWatchlistCopy(content);
    if (!screen.ok) {
      base.outcome = "COPY_REJECTED";
      base.reason = `copy screen rejected: ${screen.violations.join("; ")}`;
      base.copyViolations = screen.violations;
      base.rowsRejectedByCopyScreen = plan.rows.length;
      recordPublication(db, plan.tradingDay, phase, hash, "COPY_REJECTED", 0, null, nowMs);
      return base;
    }

    if (alreadyPublished(db, plan.tradingDay, phase, hash)) {
      base.outcome = "SUPPRESSED_UNCHANGED";
      base.reason = "identical payload already published for this trading day and phase";
      base.duplicateSuppressed = true;
      return base;
    }

    const send = deps.sendNotify
      ?? (async (opts: any) => {
        const { sendOwnerResearchNotify } = await import("../../notifications/owner-research-notify.ts");
        return sendOwnerResearchNotify(opts) as any;
      });

    const sent = await send({
      db,
      kind: NOTIFY_KIND[phase],
      content,
      symbol: `pro_${hash}`,
      nowMs,
      env,
    });

    if (sent.sent) {
      base.outcome = "SENT";
      base.reason = null;
      base.messageId = sent.messageId ?? null;
      recordPublication(db, plan.tradingDay, phase, hash, "SENT", plan.rows.length, base.messageId, nowMs);
      return base;
    }
    base.outcome = sent.skipped ? "SEND_SKIPPED" : "SEND_FAILED";
    base.reason = sent.reason;
    recordPublication(db, plan.tradingDay, phase, hash, base.outcome, 0, null, nowMs);
    return base;
  } catch (err: any) {
    // Total containment: a publication failure is data, never an exception the
    // scheduler or the legacy plan has to survive.
    const res = emptyResult(nowMs, "", phase, flagEnabled, "BUILD_FAILED", String(err?.message ?? err));
    res.errors = [String(err?.message ?? err)];
    return res;
  }
}

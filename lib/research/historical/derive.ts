/**
 * derive.ts — HIST_DERIVE_V1. Turn the stored raw history into durable derived rows.
 *
 * Two derivations, one contract:
 *
 *   PRE_MOVE_DISCOVERY_REPLAY_V1  →  historical_pre_move_replay
 *   HIST_CONTEXT_V1               →  historical_market_context
 *
 * ── Zero provider cost ───────────────────────────────────────────────────────
 *
 * Everything here reads the local store. Nothing fetches. That is what makes it safe to
 * run repeatedly and safe to run beside the live scanner — the off-peak gate exists for
 * PROVIDER contention, and a derivation that issues no request is not competing for it.
 * It is still run off-peak by default, because it holds the database.
 *
 * ── Derived is never observed ────────────────────────────────────────────────
 *
 * Every row is stamped REPLAY_DERIVED or DERIVED_FROM_HISTORICAL_BARS, and the origin is
 * part of the primary key rather than a column beside it. A reconstruction that can
 * satisfy a lookup meant for a measurement contaminates every forward statistic
 * downstream of it, and the contamination is invisible once the row is written.
 *
 * ── Repeat-safe by identity, not by bookkeeping ──────────────────────────────
 *
 * Both writers upsert on a deterministic key. Re-running the same version over the same
 * moment UPDATES; running a new version ADDS. Nothing depends on remembering what a
 * previous run did, because a crashed run does not get to remember anything.
 *
 * ── No hindsight ─────────────────────────────────────────────────────────────
 *
 * Every input is read through `replay.ts`, which fences in SQL at the decision instant.
 * A derived row for 10:30 cannot see 10:31. The one thing this module must never do is
 * derive a context row for an instant using bars that arrived later, and the fence — not
 * this module's own care — is what prevents it.
 */
import {
  deriveHistoricalMarketContext,
  persistHistoricalMarketContextOnDb,
  HISTORICAL_CONTEXT_VERSION,
} from "./market-context.ts";
import { PRE_MOVE_REPLAY_VERSION, replayPreMoveDiscoveryOnDb, type PreMoveReplayResult } from "./pre-move-replay.ts";
import { sessionDateOf } from "./replay.ts";
import type { StoreDb } from "./store.ts";
import { classifySessionDate, tradingSessionsBetween } from "./trading-sessions.ts";

export const DERIVE_VERSION = "HIST_DERIVE_V1" as const;

/** Default sampling cadence for context rows within a session. */
export const CONTEXT_SAMPLE_MS = 30 * 60_000;
/** ET clock bounds for sampling: premarket open through the close. */
const SAMPLE_FROM_ET_HOUR = 9;
const SAMPLE_TO_ET_HOUR = 16;

function hasTable(db: StoreDb, name: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name);
  } catch {
    return false;
  }
}

// ── replay pre-move persistence ──────────────────────────────────────────────

export interface PreMoveReplayPersistInput extends PreMoveReplayResult {
  opportunityCaseId?: string | null;
  eventId?: string | null;
  sourceQuoteRows?: number | null;
  sourceBarRows?: number | null;
}

/**
 * Persist one replay discovery row.
 *
 * The upsert deliberately does NOT touch `created_at_ms`, so a row remembers when it was
 * first derived even after a re-run rewrites its values. That is the only way to tell a
 * stable reconstruction from one that changed the moment more history arrived.
 */
export function persistPreMoveReplayOnDb(
  db: StoreDb,
  row: PreMoveReplayPersistInput,
  nowMs: number,
): boolean {
  if (!hasTable(db, "historical_pre_move_replay")) return false;
  try {
    db.prepare(
      `INSERT INTO historical_pre_move_replay
         (occ, decision_at_ms, replay_version, origin, opportunity_case_id, event_id, symbol, side,
          session_date, detected_at_ms, stage, underlying_move_consumed_pct,
          premium_expansion_consumed_pct, move_consumed_fraction, reward_remaining_fraction,
          reward_remaining_band, entry_ask, spread_pct, dte, moneyness_pct, regime,
          market_alignment, underlying_bars_used, missing_fields_json, evidence_quality,
          source_quote_rows, source_bar_rows, reason, created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(occ, decision_at_ms, replay_version, origin) DO UPDATE SET
         opportunity_case_id=excluded.opportunity_case_id, event_id=excluded.event_id,
         symbol=excluded.symbol, side=excluded.side, session_date=excluded.session_date,
         detected_at_ms=excluded.detected_at_ms, stage=excluded.stage,
         underlying_move_consumed_pct=excluded.underlying_move_consumed_pct,
         premium_expansion_consumed_pct=excluded.premium_expansion_consumed_pct,
         move_consumed_fraction=excluded.move_consumed_fraction,
         reward_remaining_fraction=excluded.reward_remaining_fraction,
         reward_remaining_band=excluded.reward_remaining_band, entry_ask=excluded.entry_ask,
         spread_pct=excluded.spread_pct, dte=excluded.dte, moneyness_pct=excluded.moneyness_pct,
         regime=excluded.regime, market_alignment=excluded.market_alignment,
         underlying_bars_used=excluded.underlying_bars_used,
         missing_fields_json=excluded.missing_fields_json,
         evidence_quality=excluded.evidence_quality,
         source_quote_rows=excluded.source_quote_rows, source_bar_rows=excluded.source_bar_rows,
         reason=excluded.reason, updated_at_ms=excluded.updated_at_ms`,
    ).run?.(
      row.occ, row.decisionAtMs, row.version, row.origin,
      row.opportunityCaseId ?? null, row.eventId ?? null,
      row.symbol, row.side, row.sessionDate, row.detectedAtMs,
      row.stage, row.underlyingMoveConsumedPct, row.premiumExpansionConsumedPct,
      row.moveConsumedFraction, row.rewardRemainingFraction, row.rewardRemainingBand,
      row.entryAsk, row.spreadPct, row.dte, row.moneynessPct,
      row.regime, row.marketAlignment, row.underlyingBarsUsed,
      JSON.stringify(row.missingFields ?? []), row.evidenceQuality,
      row.sourceQuoteRows ?? null, row.sourceBarRows ?? null,
      row.reason, nowMs, nowMs,
    );
    return true;
  } catch {
    return false;
  }
}

export interface DeriveReplayResult {
  version: typeof DERIVE_VERSION;
  replayVersion: typeof PRE_MOVE_REPLAY_VERSION;
  origin: string;
  examined: number;
  persisted: number;
  skippedNotTradingSession: number;
  failed: number;
  byStage: Record<string, number>;
  byEvidenceQuality: Record<string, number>;
  note: string;
}

/**
 * Derive and persist replay discovery rows for a batch of historical anchors.
 *
 * A candidate whose instant is not a trading session is skipped rather than classified:
 * reconstructing a discovery stage for a closed market produces an UNGRADABLE row that
 * looks like a failed classification instead of a nonsensical question.
 */
export function deriveAndPersistPreMoveReplay(
  db: StoreDb,
  anchors: ReadonlyArray<{
    occ: string;
    symbol: string;
    side: "CALL" | "PUT";
    detectedAtMs: number;
    decisionAtMs?: number;
    triggerLevel?: number | null;
    opportunityCaseId?: string | null;
    eventId?: string | null;
  }>,
  opts: { nowMs?: number } = {},
): DeriveReplayResult {
  const nowMs = opts.nowMs ?? Date.now();
  const byStage: Record<string, number> = {};
  const byEvidenceQuality: Record<string, number> = {};
  let persisted = 0;
  let failed = 0;
  let skipped = 0;

  for (const a of anchors) {
    const at = a.decisionAtMs ?? a.detectedAtMs;
    if (!classifySessionDate(sessionDateOf(at)).isTradingSession) { skipped += 1; continue; }
    let result: PreMoveReplayResult;
    try {
      result = replayPreMoveDiscoveryOnDb(db, {
        occ: a.occ, symbol: a.symbol, side: a.side,
        detectedAtMs: a.detectedAtMs, decisionAtMs: a.decisionAtMs,
        triggerLevel: a.triggerLevel ?? null,
      });
    } catch {
      failed += 1;
      continue;
    }
    byStage[result.stage] = (byStage[result.stage] ?? 0) + 1;
    byEvidenceQuality[result.evidenceQuality] = (byEvidenceQuality[result.evidenceQuality] ?? 0) + 1;

    const ok = persistPreMoveReplayOnDb(db, {
      ...result,
      opportunityCaseId: a.opportunityCaseId ?? null,
      eventId: a.eventId ?? null,
      sourceQuoteRows: countQuotesForOcc(db, result.occ),
      sourceBarRows: result.underlyingBarsUsed,
    }, nowMs);
    if (ok) persisted += 1; else failed += 1;
  }

  return {
    version: DERIVE_VERSION,
    replayVersion: PRE_MOVE_REPLAY_VERSION,
    origin: "REPLAY_DERIVED",
    examined: anchors.length,
    persisted,
    skippedNotTradingSession: skipped,
    failed,
    byStage,
    byEvidenceQuality,
    note:
      "Every row is REPLAY_DERIVED and says so in its primary key, so a reconstruction can never "
      + "satisfy a lookup meant for a live observation. Re-running the same replay version updates "
      + "in place; a new version adds rows. Zero provider requests were issued.",
  };
}

function countQuotesForOcc(db: StoreDb, occ: string): number | null {
  if (!hasTable(db, "historical_option_quotes")) return null;
  try {
    const r = db.prepare("SELECT COUNT(*) AS n FROM historical_option_quotes WHERE occ=?").get?.(occ);
    return r == null ? null : Number((r as { n?: number }).n ?? 0);
  } catch {
    return null;
  }
}

// ── market context derivation ────────────────────────────────────────────────

/**
 * Sample instants inside one session, in Eastern clock terms.
 *
 * Built from the session DATE rather than by stepping a fixed epoch offset, so a session
 * that crosses a DST boundary still samples 09:30-16:00 local rather than drifting an hour.
 */
function sampleInstantsForSession(sessionDate: string, everyMs: number): number[] {
  const out: number[] = [];
  // Eastern offset for this date, discovered by asking what UTC hour renders as noon ET.
  const probe = Date.parse(`${sessionDate}T12:00:00Z`);
  if (!Number.isFinite(probe)) return out;
  const etHourAtNoonUtc = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })
      .format(new Date(probe)),
  );
  // 12 UTC renders as 7 ET at -5, 8 ET at -4.
  const offsetHours = etHourAtNoonUtc - 12;
  const startUtc = probe + (SAMPLE_FROM_ET_HOUR - 12 - offsetHours) * 3600_000 + 30 * 60_000;
  const endUtc = probe + (SAMPLE_TO_ET_HOUR - 12 - offsetHours) * 3600_000;
  for (let t = startUtc; t <= endUtc; t += Math.max(60_000, everyMs)) out.push(t);
  return out;
}

export interface DeriveContextResult {
  version: typeof DERIVE_VERSION;
  contextVersion: typeof HISTORICAL_CONTEXT_VERSION;
  origin: string;
  sessionsExamined: number;
  instantsExamined: number;
  persisted: number;
  skippedInsufficientBars: number;
  failed: number;
  sessions: string[];
  byQuality: Record<string, number>;
  note: string;
}

/**
 * Derive context rows across every trading session the bars actually cover.
 *
 * Only sessions with stored bars are visited, and an instant whose reconstruction is
 * INSUFFICIENT is NOT persisted. A context row that knows nothing is worse than no row:
 * `readHistoricalMarketContextOnDb` would return it as the context in force and an
 * UNKNOWN regime would start looking like a measured one.
 */
export function deriveAndPersistMarketContext(
  db: StoreDb,
  opts: { fromDate?: string | null; toDate?: string | null; everyMs?: number; nowMs?: number; maxInstants?: number } = {},
): DeriveContextResult {
  const nowMs = opts.nowMs ?? Date.now();
  const everyMs = opts.everyMs ?? CONTEXT_SAMPLE_MS;
  const maxInstants = Math.max(1, Math.min(20_000, opts.maxInstants ?? 5000));
  const byQuality: Record<string, number> = {};
  let persisted = 0;
  let failed = 0;
  let skipped = 0;
  let instants = 0;

  // Sessions that actually have bars. Deriving a regime for a session with no bars would
  // write an UNKNOWN row and make absence look like a reading.
  const sessionsWithBars = new Set<string>();
  try {
    const rows = (db.prepare(
      "SELECT DISTINCT ts_ms FROM historical_underlying_bars WHERE symbol IN ('SPY','QQQ')",
    ).all?.() ?? []) as Array<{ ts_ms: number }>;
    for (const r of rows) {
      const d = sessionDateOf(Number(r.ts_ms));
      if (d) sessionsWithBars.add(d);
    }
  } catch {
    // Leave empty: nothing derivable.
  }

  const from = opts.fromDate ?? [...sessionsWithBars].sort()[0] ?? null;
  const to = opts.toDate ?? [...sessionsWithBars].sort().slice(-1)[0] ?? null;
  const candidateSessions = from && to
    ? tradingSessionsBetween(from, to).filter((d) => sessionsWithBars.has(d))
    : [];

  for (const sessionDate of candidateSessions) {
    for (const at of sampleInstantsForSession(sessionDate, everyMs)) {
      if (instants >= maxInstants) break;
      instants += 1;
      let ctx;
      try {
        ctx = deriveHistoricalMarketContext(db, at);
      } catch {
        failed += 1;
        continue;
      }
      byQuality[ctx.quality] = (byQuality[ctx.quality] ?? 0) + 1;
      if (ctx.quality === "INSUFFICIENT") { skipped += 1; continue; }
      if (persistHistoricalMarketContextOnDb(db, ctx, nowMs)) persisted += 1;
      else failed += 1;
    }
    if (instants >= maxInstants) break;
  }

  return {
    version: DERIVE_VERSION,
    contextVersion: HISTORICAL_CONTEXT_VERSION,
    origin: "DERIVED_FROM_HISTORICAL_BARS",
    sessionsExamined: candidateSessions.length,
    instantsExamined: instants,
    persisted,
    skippedInsufficientBars: skipped,
    failed,
    sessions: candidateSessions,
    byQuality,
    note:
      "Stamped DERIVED_FROM_HISTORICAL_BARS, with origin in the primary key so a reconstruction "
      + "cannot be read as a live measurement. Every instant is reconstructed under the SQL time "
      + "fence, so a 10:30 row cannot see 10:31. An INSUFFICIENT reconstruction is NOT written: a "
      + "row that knows nothing would be returned as the context in force and an UNKNOWN regime "
      + "would start looking like a measured one. Zero provider requests were issued.",
  };
}

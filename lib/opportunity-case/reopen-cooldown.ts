/**
 * Post-close re-open cooldown for an outward session thesis.
 *
 * Closing an Opportunity Case (target hit, stop, time stop, expiration) deletes the
 * thesis active-index row so the case stops being tracked. Without a cooldown that
 * deletion also re-arms the outward opening path: the same symbol + direction +
 * option type could immediately win a fresh claim and send a SECOND "AAPL PUT"
 * opening alert minutes after the subscriber was told the first one reached T1.
 *
 * This module records a durable cooldown at close time and blocks a re-open claim
 * until it expires. Deterministic, env-tunable, no AI authority, no provider calls.
 */
import type { LiveDb } from "./live.ts";

export const DEFAULT_THESIS_REOPEN_COOLDOWN_MS = 45 * 60_000;
const MAX_THESIS_REOPEN_COOLDOWN_MS = 6 * 60 * 60_000;

/** Cooldown window in ms. `0` disables the gate (explicit opt-out only). */
export function thesisReopenCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.OPPORTUNITY_THESIS_REOPEN_COOLDOWN_MS ?? "").trim();
  if (!raw) return DEFAULT_THESIS_REOPEN_COOLDOWN_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_THESIS_REOPEN_COOLDOWN_MS;
  return Math.min(Math.floor(parsed), MAX_THESIS_REOPEN_COOLDOWN_MS);
}

export interface ThesisReopenCooldown {
  thesisFingerprint: string;
  opportunityCaseId: string;
  symbol: string;
  direction: string;
  optionType: string;
  sessionDate: string;
  closedAtMs: number;
  closeReason: string | null;
  returnPercent: number | null;
  cooldownUntilMs: number;
}

function hasTable(db: LiveDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/**
 * Record the cooldown for a thesis that just closed. Idempotent per fingerprint —
 * a later close of the same thesis extends the window rather than duplicating it.
 * Never throws: a cooldown write must not break the close path.
 */
export function recordThesisReopenCooldownOnDb(
  db: LiveDb,
  input: {
    thesisFingerprint: string;
    opportunityCaseId: string;
    symbol: string;
    direction: string;
    optionType: string;
    sessionDate: string;
    closedAtMs: number;
    closeReason?: string | null;
    returnPercent?: number | null;
    env?: NodeJS.ProcessEnv;
  },
): boolean {
  if (!input.thesisFingerprint) return false;
  if (!hasTable(db, "opportunity_thesis_reopen_cooldown")) return false;
  const windowMs = thesisReopenCooldownMs(input.env);
  if (windowMs <= 0) return false;
  const cooldownUntilMs = input.closedAtMs + windowMs;
  try {
    db.prepare(
      `INSERT INTO opportunity_thesis_reopen_cooldown
        (thesis_fingerprint, opportunity_case_id, symbol, direction, option_type, session_date,
         closed_at_ms, close_reason, return_percent, cooldown_until_ms, created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(thesis_fingerprint) DO UPDATE SET
         opportunity_case_id=excluded.opportunity_case_id,
         closed_at_ms=excluded.closed_at_ms,
         close_reason=excluded.close_reason,
         return_percent=excluded.return_percent,
         cooldown_until_ms=MAX(opportunity_thesis_reopen_cooldown.cooldown_until_ms, excluded.cooldown_until_ms),
         updated_at_ms=excluded.updated_at_ms`,
    ).run(
      input.thesisFingerprint,
      input.opportunityCaseId,
      input.symbol,
      input.direction,
      input.optionType,
      input.sessionDate,
      input.closedAtMs,
      input.closeReason ?? null,
      input.returnPercent ?? null,
      cooldownUntilMs,
      input.closedAtMs,
      input.closedAtMs,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The active cooldown for a thesis fingerprint, or null when none applies.
 * Read-only — expired rows stay for diagnostics and are swept elsewhere.
 */
export function findThesisReopenCooldownOnDb(
  db: LiveDb,
  thesisFingerprint: string,
  nowMs: number,
): ThesisReopenCooldown | null {
  if (!thesisFingerprint) return null;
  if (!hasTable(db, "opportunity_thesis_reopen_cooldown")) return null;
  try {
    const row = db.prepare(
      `SELECT thesis_fingerprint, opportunity_case_id, symbol, direction, option_type, session_date,
              closed_at_ms, close_reason, return_percent, cooldown_until_ms
       FROM opportunity_thesis_reopen_cooldown
       WHERE thesis_fingerprint=?`,
    ).get(thesisFingerprint) as Record<string, unknown> | undefined;
    if (!row) return null;
    const cooldownUntilMs = Number(row.cooldown_until_ms ?? 0);
    if (!Number.isFinite(cooldownUntilMs) || cooldownUntilMs <= nowMs) return null;
    return {
      thesisFingerprint,
      opportunityCaseId: String(row.opportunity_case_id ?? ""),
      symbol: String(row.symbol ?? ""),
      direction: String(row.direction ?? ""),
      optionType: String(row.option_type ?? ""),
      sessionDate: String(row.session_date ?? ""),
      closedAtMs: Number(row.closed_at_ms ?? 0),
      closeReason: row.close_reason == null ? null : String(row.close_reason),
      returnPercent: row.return_percent == null ? null : Number(row.return_percent),
      cooldownUntilMs,
    };
  } catch {
    return null;
  }
}

/** Clear a cooldown (used when a case is reopened administratively). Never throws. */
export function clearThesisReopenCooldownOnDb(db: LiveDb, thesisFingerprint: string): void {
  if (!thesisFingerprint) return;
  if (!hasTable(db, "opportunity_thesis_reopen_cooldown")) return;
  try {
    db.prepare("DELETE FROM opportunity_thesis_reopen_cooldown WHERE thesis_fingerprint=?").run(thesisFingerprint);
  } catch { /* isolated */ }
}

/** Read-only diagnostics: currently active cooldowns, newest close first. */
export function activeThesisReopenCooldownsOnDb(
  db: LiveDb,
  nowMs: number,
  limit = 50,
): ThesisReopenCooldown[] {
  if (!hasTable(db, "opportunity_thesis_reopen_cooldown")) return [];
  try {
    const rows = db.prepare(
      `SELECT thesis_fingerprint, opportunity_case_id, symbol, direction, option_type, session_date,
              closed_at_ms, close_reason, return_percent, cooldown_until_ms
       FROM opportunity_thesis_reopen_cooldown
       WHERE cooldown_until_ms > ?
       ORDER BY closed_at_ms DESC
       LIMIT ?`,
    ).all(nowMs, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      thesisFingerprint: String(row.thesis_fingerprint ?? ""),
      opportunityCaseId: String(row.opportunity_case_id ?? ""),
      symbol: String(row.symbol ?? ""),
      direction: String(row.direction ?? ""),
      optionType: String(row.option_type ?? ""),
      sessionDate: String(row.session_date ?? ""),
      closedAtMs: Number(row.closed_at_ms ?? 0),
      closeReason: row.close_reason == null ? null : String(row.close_reason),
      returnPercent: row.return_percent == null ? null : Number(row.return_percent),
      cooldownUntilMs: Number(row.cooldown_until_ms ?? 0),
    }));
  } catch {
    return [];
  }
}

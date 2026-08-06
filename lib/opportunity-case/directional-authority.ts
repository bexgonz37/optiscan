/**
 * Symbol-level directional authority.
 *
 * WHY THIS EXISTS
 *
 * Every pre-existing exclusion key in the opening path encodes DIRECTION:
 *   - `clusterKey(symbol, side)` yields `index:call` and `index:put` as separate
 *     correlation clusters, so a call and a put for one symbol never contend.
 *   - `opportunityThesisFingerprint` is `symbol|direction|optionType|sessionDate`,
 *     and that fingerprint is the PRIMARY KEY of `opportunity_thesis_active_index` —
 *     the table whose entire job is "one open thesis at a time". Being per-direction,
 *     a CALL claim and a PUT claim for the same symbol BOTH succeed.
 *
 * The consequence was observed in production on 2026-08-06: SPY selected
 * `breakout_forming` (call, expirations incl. 2026-08-11) and `lower_high_continuation`
 * (put, `O:SPY260807P00770000`, bid 2.21 / ask 2.22) inside one 15-minute window, and
 * both were treated as independently deliverable. The delivery reason recorded for the
 * put was literally `cluster index:put`. The case's own `auditAnswers.strategiesConflicted`
 * was `[]` while `strategiesApplicable` contained BOTH `breakout_forming` and
 * `lower_high_continuation` — the conflict existed and nothing was watching for it.
 *
 * WHAT THIS ADDS
 *
 * One authority, scoped to (symbol, sessionDate) and deliberately IGNORING direction, so
 * that a symbol can hold at most ONE subscriber-facing actionable direction at a time.
 * An opposite-direction opening is refused unless it arrives as an explicit, evidenced
 * reversal that supersedes the prior case.
 *
 * This gate can only ever REDUCE what is sent. It never creates, promotes, or widens an
 * alert, which is why it defaults to `enforce` rather than hiding behind an opt-in flag.
 * `DIRECTIONAL_AUTHORITY_MODE=shadow` observes and records without blocking;
 * `off` disables it entirely. Both are escape hatches, not the intended state.
 *
 * Research, shadow, paper and owner-watch lanes are unaffected: they do not claim a
 * thesis, so they never reach this code. Different strategies and directions may still
 * coexist in research. Only the outward actionable lane is made single-directional.
 */
import type { LiveDb } from "./live.ts";
import { isActiveLifecycleStatus } from "./identity.ts";

export type ThesisDirection = "BULLISH" | "BEARISH";

export type DirectionalAuthorityMode = "enforce" | "shadow" | "off";

export type DirectionalAuthorityState =
  /** Nothing actionable is open for this symbol this session. */
  | "NO_ACTIVE_DIRECTION"
  /** Same direction already open — the existing same-thesis rules own this case. */
  | "SAME_DIRECTION_ACTIVE"
  /** Opposite direction is open and no valid reversal was presented. Refuse. */
  | "OPPOSITE_DIRECTION_ACTIVE"
  /** Opposite direction is open and a valid, evidenced reversal supersedes it. */
  | "REVERSAL_AUTHORIZED";

export interface ActiveDirectionRow {
  thesisFingerprint: string;
  opportunityCaseId: string;
  symbol: string;
  direction: ThesisDirection;
  optionType: "CALL" | "PUT";
  sessionDate: string;
  lifecycleStatus: string;
  openingSource: string;
  discordMessageId: string | null;
  openedAtMs: number;
}

/**
 * Proof that the prior direction is genuinely finished and that the new direction has
 * its own fresh evidence. Every field is required — a reversal is never inferred.
 */
export interface ReversalAuthorization {
  /** The case this reversal explicitly supersedes. Must be the active opposite case. */
  supersedesCaseId: string;
  /** Deterministic, evidence-backed statement of what changed. Non-empty. */
  whatChanged: string;
  /** How the prior thesis ended. Inference is not accepted. */
  priorInvalidation: "INVALIDATED" | "EXPIRED" | "CLOSED" | "EXPLICITLY_SUPERSEDED";
  /** Timestamp of the opposite-direction evidence that motivates the reversal. */
  freshEvidenceAtMs: number;
}

export interface DirectionalAuthorityDecision {
  allowed: boolean;
  state: DirectionalAuthorityState;
  mode: DirectionalAuthorityMode;
  /** The direction that currently owns the symbol, if any. */
  authoritativeDirection: ThesisDirection | null;
  /** Active rows in the OPPOSITE direction to the request. */
  conflicting: ActiveDirectionRow[];
  /** Active rows in the SAME direction as the request. */
  sameDirection: ActiveDirectionRow[];
  reasonCode: string;
  detail: string;
}

export function directionalAuthorityMode(
  env: NodeJS.ProcessEnv = process.env,
): DirectionalAuthorityMode {
  const raw = String(env.DIRECTIONAL_AUTHORITY_MODE ?? "").trim().toLowerCase();
  if (raw === "shadow") return "shadow";
  if (raw === "off" || raw === "0") return "off";
  return "enforce";
}

function hasTable(db: LiveDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/**
 * Every ACTIVE actionable thesis for one symbol in one session, in ALL directions.
 *
 * Uses `idx_opportunity_thesis_symbol`, whose leading column is `symbol`, so this adds
 * an index seek and no migration.
 */
export function findActiveDirectionsForSymbolOnDb(
  db: LiveDb,
  symbol: string,
  sessionDate: string,
): ActiveDirectionRow[] {
  if (!hasTable(db, "opportunity_thesis_active_index")) return [];
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym || !sessionDate) return [];
  try {
    const rows = db.prepare(
      `SELECT thesis_fingerprint, opportunity_case_id, symbol, direction, option_type,
              session_date, lifecycle_status, opening_source, discord_message_id, opened_at_ms
         FROM opportunity_thesis_active_index
        WHERE symbol=? AND session_date=?`,
    ).all(sym, sessionDate) as any[];
    return rows
      .filter((r) => isActiveLifecycleStatus(r?.lifecycle_status))
      .map((r) => ({
        thesisFingerprint: String(r.thesis_fingerprint),
        opportunityCaseId: String(r.opportunity_case_id),
        symbol: String(r.symbol).toUpperCase(),
        direction: String(r.direction).toUpperCase() === "BEARISH" ? "BEARISH" as const : "BULLISH" as const,
        optionType: String(r.option_type).toUpperCase() === "PUT" ? "PUT" as const : "CALL" as const,
        sessionDate: String(r.session_date),
        lifecycleStatus: String(r.lifecycle_status),
        openingSource: String(r.opening_source ?? "canonical"),
        discordMessageId: r.discord_message_id == null ? null : String(r.discord_message_id),
        openedAtMs: Number(r.opened_at_ms ?? 0),
      }))
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
  } catch {
    return [];
  }
}

/**
 * Does `authorization` genuinely license replacing `conflicting` with `direction`?
 *
 * Deliberately strict: the authorization must name one of the actually-active opposite
 * cases, carry a non-empty explanation, and carry fresh evidence no older than the case
 * it replaces. A reversal that cannot point at what it supersedes is not a reversal.
 */
function reversalIsValid(
  authorization: ReversalAuthorization | null | undefined,
  conflicting: ActiveDirectionRow[],
): { ok: boolean; detail: string } {
  if (!authorization) return { ok: false, detail: "no reversal authorization presented" };
  const target = conflicting.find((c) => c.opportunityCaseId === authorization.supersedesCaseId);
  if (!target) {
    return {
      ok: false,
      detail: `supersedesCaseId ${authorization.supersedesCaseId} is not an active opposite-direction case`
        + ` (active: ${conflicting.map((c) => c.opportunityCaseId).join(", ") || "none"})`,
    };
  }
  if (!String(authorization.whatChanged ?? "").trim()) {
    return { ok: false, detail: "reversal requires a non-empty whatChanged explanation" };
  }
  if (!Number.isFinite(authorization.freshEvidenceAtMs)) {
    return { ok: false, detail: "reversal requires freshEvidenceAtMs" };
  }
  if (authorization.freshEvidenceAtMs < target.openedAtMs) {
    return {
      ok: false,
      detail: "reversal evidence predates the case it supersedes"
        + ` (evidence ${authorization.freshEvidenceAtMs} < opened ${target.openedAtMs})`,
    };
  }
  return { ok: true, detail: `supersedes ${target.opportunityCaseId} (${authorization.priorInvalidation})` };
}

/**
 * The single deterministic answer to "may this symbol open in this direction right now?"
 */
export function evaluateDirectionalAuthority(
  db: LiveDb | null,
  input: {
    symbol: string;
    sessionDate: string;
    direction: ThesisDirection;
    reversal?: ReversalAuthorization | null;
    env?: NodeJS.ProcessEnv;
  },
): DirectionalAuthorityDecision {
  const mode = directionalAuthorityMode(input.env ?? process.env);
  const base = {
    mode,
    authoritativeDirection: null as ThesisDirection | null,
    conflicting: [] as ActiveDirectionRow[],
    sameDirection: [] as ActiveDirectionRow[],
  };
  if (mode === "off" || !db) {
    return {
      ...base,
      allowed: true,
      state: "NO_ACTIVE_DIRECTION",
      reasonCode: mode === "off" ? "DIRECTIONAL_AUTHORITY_OFF" : "DIRECTIONAL_AUTHORITY_NO_DB",
      detail: mode === "off" ? "disabled by DIRECTIONAL_AUTHORITY_MODE" : "no database handle",
    };
  }

  const active = findActiveDirectionsForSymbolOnDb(db, input.symbol, input.sessionDate);
  const sameDirection = active.filter((r) => r.direction === input.direction);
  const conflicting = active.filter((r) => r.direction !== input.direction);
  // First mover owns the symbol. Ties are impossible in practice and resolved by the
  // stable `openedAtMs` sort applied in findActiveDirectionsForSymbolOnDb.
  const authoritativeDirection = active.length ? active[0].direction : null;

  if (!conflicting.length) {
    return {
      mode,
      authoritativeDirection,
      conflicting,
      sameDirection,
      allowed: true,
      state: sameDirection.length ? "SAME_DIRECTION_ACTIVE" : "NO_ACTIVE_DIRECTION",
      reasonCode: sameDirection.length ? "SAME_DIRECTION_ACTIVE" : "NO_ACTIVE_DIRECTION",
      detail: sameDirection.length
        ? `same-direction thesis already active (${sameDirection.map((c) => c.opportunityCaseId).join(", ")})`
        : "no active actionable direction for this symbol this session",
    };
  }

  const reversal = reversalIsValid(input.reversal, conflicting);
  if (reversal.ok) {
    return {
      mode,
      authoritativeDirection,
      conflicting,
      sameDirection,
      allowed: true,
      state: "REVERSAL_AUTHORIZED",
      reasonCode: "REVERSAL_AUTHORIZED",
      detail: reversal.detail,
    };
  }

  const detail = `${input.symbol} already has an active ${conflicting[0].direction} thesis`
    + ` (${conflicting.map((c) => `${c.opportunityCaseId}/${c.optionType}`).join(", ")});`
    + ` ${reversal.detail}`;
  return {
    mode,
    authoritativeDirection,
    conflicting,
    sameDirection,
    // Shadow mode records the conflict but does not block, so the rate can be measured
    // before enforcement is trusted.
    allowed: mode === "shadow",
    state: "OPPOSITE_DIRECTION_ACTIVE",
    reasonCode: mode === "shadow"
      ? "OPPOSITE_DIRECTION_ACTIVE_SHADOW"
      : "OPPOSITE_DIRECTION_ACTIVE",
    detail,
  };
}

/**
 * The subscriber-facing reversal message.
 *
 * A reversal is the ONLY way a symbol changes direction outwardly, so it must say what
 * it replaces and why. A new standalone opposite-direction opening is never a substitute.
 */
export function formatReversalMessage(input: {
  symbol: string;
  priorCaseId: string;
  priorDirection: ThesisDirection;
  newDirection: ThesisDirection;
  whatChanged: string;
  optionSymbol: string;
  entryEvidence: string;
}): string {
  const sym = String(input.symbol).toUpperCase();
  const priorSide = input.priorDirection === "BEARISH" ? "PUT" : "CALL";
  const newSide = input.newDirection === "BEARISH" ? "PUT" : "CALL";
  return [
    `${sym} REVERSAL — ${priorSide} THESIS INVALIDATED`,
    "",
    "Previous case:",
    `${input.priorCaseId} (${input.priorDirection})`,
    "",
    "New authoritative direction:",
    newSide,
    "",
    "What changed:",
    input.whatChanged,
    "",
    "New contract:",
    `${input.optionSymbol} — ${input.entryEvidence}`,
  ].join("\n");
}

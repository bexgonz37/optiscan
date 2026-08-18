/**
 * pre-move-v2-store.ts — the PROSPECTIVE capture and read side of
 * PRE_MOVE_DISCOVERY_V2.
 *
 * A classifier with no capture site is a function, not a measurement. This is the
 * capture, and it lives on the SAME row as V1 rather than in a parallel table: one
 * callout, one row, two versioned readings of it. V1's columns are never written
 * here and never rewritten anywhere — its rows keep their V1 stage forever, and a
 * V1/V2 disagreement is a finding to read, not a conflict to resolve.
 *
 * ── The one invariant ─────────────────────────────────────────────────────────
 *
 *     THE V2 SNAPSHOT IS TAKEN AT THE SEND, ONCE, AND IS NEVER REVISED.
 *
 * V1 already learned half of this: its detection columns are COALESCE'd so the first
 * observation wins. V2 needs the other half. Its denominator is the session's
 * high-to-low range, and the V1 row maintains that range as a running MAX/MIN for the
 * entire life of the case — so it KEEPS WIDENING AFTER THE ALERT. Classifying a
 * 10:04 decision against a range that grew until 16:00 would let the rest of the day
 * enlarge the denominator of a decision made before any of it happened, and every
 * callout would look earlier the longer its session ran. That is hindsight wearing a
 * decision-time column's name, so V2 refuses those columns and captures its own.
 *
 * ── What "prospective" means here, exactly ────────────────────────────────────
 *
 * A row whose `v2_captured` is 0 is UNGRADABLE in V2 and stays that way. Every row
 * written before this capture site went live is such a row. Nothing is back-filled,
 * no session extent is reconstructed from marks, and no post-alert observation is
 * ever admitted as though it had been in hand at the time. The V2 population
 * therefore starts empty and grows only forward, which is the whole point: V1's
 * numbers looked like a measurement from the day it shipped and were never one.
 *
 * No provider call is ever made from here. Every value comes from evidence the
 * delivery path already had in hand; a field the caller could not supply is stored
 * as null and named in the row's missing list. Fetching to fill a gap would change
 * what a callout costs in order to measure it.
 *
 * Diagnostic only. No gate, threshold, ranking weight, contract choice, target, stop,
 * exit or delivery decision reads a single column written by this module.
 */
import {
  PRE_MOVE_DISCOVERY_V2_VERSION,
  PRE_MOVE_DISCOVERY_V2_DEFINITION_HASH,
  classifyDiscoveryV2,
  type DiscoveryClassificationV2,
  type DiscoveryStageV2,
  type OptionSideV2,
  type TriggerStateV2,
} from "./pre-move-discovery-v2.ts";

const TABLE = "opportunity_pre_move_discovery";

export interface PreMoveV2Db {
  prepare(sql: string): {
    run?: (...a: any[]) => { changes: number };
    get?: (...a: any[]) => any;
    all?: (...a: any[]) => any[];
  };
}

/** How much of the V2 observation the evidence actually supports. */
export type PreMoveV2EvidenceQuality = "COMPLETE" | "PARTIAL" | "INSUFFICIENT";

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const boolCol = (v: boolean | null | undefined): number | null =>
  v == null ? null : v ? 1 : 0;

function hasV2Columns(db: PreMoveV2Db): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${TABLE})`).all?.() ?? [];
    return rows.some((r: any) => r?.name === "v2_captured");
  } catch {
    return false;
  }
}

/**
 * Everything the delivery path knows at the moment the owner opening is sent.
 *
 * Deliberately explicit rather than "pass me the feature snapshot": a capture site
 * that digs fields out of a loosely typed blob is a capture site that silently
 * records nulls when the blob's shape drifts, and a null here is indistinguishable
 * downstream from a market that offered nothing.
 */
export interface PreMoveV2AlertCapture {
  /** The CLAIM case minted at delivery. */
  opportunityCaseId: string;
  /** The PENDING audit case the scanner wrote — where the observation actually lives. */
  preMoveCaseId?: string | null;

  side: OptionSideV2;
  ownerNotifiedAtMs: number;

  underlyingAtAlert: number | null;
  sessionHighAtAlert: number | null;
  sessionLowAtAlert: number | null;
  sessionOpenAtAlert?: number | null;
  vwapAtAlert?: number | null;
  triggerLevelAtAlert?: number | null;
  triggerTakenAtAlert?: boolean | null;

  optionAtAlert?: number | null;
  optionAtFirstDetection?: number | null;
  underlyingAtFirstDetection?: number | null;

  firstSetupObservedAtMs?: number | null;
  firstPartialConfirmationAtMs?: number | null;
  firstFullConfirmationAtMs?: number | null;

  /** The frozen premiums the owner was actually shown. Never a later, better level. */
  entryPremium?: number | null;
  target1Premium?: number | null;
  target2Premium?: number | null;
  stopPremium?: number | null;
}

function evidenceQuality(c: DiscoveryClassificationV2): PreMoveV2EvidenceQuality {
  if (c.stage === "UNGRADABLE") return "INSUFFICIENT";
  // A stage reached without the timeline or the premium pair is a real answer, but it
  // is not the full picture and must not read as one.
  return c.missingInputs.length > 0 ? "PARTIAL" : "COMPLETE";
}

/**
 * Record the V2 alert-instant snapshot and its classification.
 *
 * Write-once on `v2_captured`: a re-sent or retried alert must not move the snapshot,
 * because a later session range is a different — and always more flattering —
 * denominator than the one the decision was actually made against.
 *
 * Returns the stage that was stored, or null when nothing was written. Never throws:
 * this runs after a Discord send that has already happened, and a measurement must
 * never be able to retract or fail an alert.
 */
export function recordPreMoveV2AlertOnDb(
  db: PreMoveV2Db,
  input: PreMoveV2AlertCapture,
): { stored: boolean; stage: DiscoveryStageV2 | null; caseId: string | null } {
  if (!hasV2Columns(db)) return { stored: false, stage: null, caseId: null };

  const classification = classifyDiscoveryV2({
    side: input.side,
    underlyingAtAlert: num(input.underlyingAtAlert),
    sessionHighAtAlert: num(input.sessionHighAtAlert),
    sessionLowAtAlert: num(input.sessionLowAtAlert),
    sessionOpen: num(input.sessionOpenAtAlert),
    vwapAtAlert: num(input.vwapAtAlert),
    triggerLevelAtAlert: num(input.triggerLevelAtAlert),
    triggerTakenAtAlert: input.triggerTakenAtAlert ?? null,
    optionAtAlert: num(input.optionAtAlert),
    optionAtFirstDetection: num(input.optionAtFirstDetection),
    underlyingAtFirstDetection: num(input.underlyingAtFirstDetection),
    timeline: {
      firstSetupObservedAtMs: num(input.firstSetupObservedAtMs),
      firstPartialConfirmationAtMs: num(input.firstPartialConfirmationAtMs),
      firstFullConfirmationAtMs: num(input.firstFullConfirmationAtMs),
      ownerCalloutAtMs: input.ownerNotifiedAtMs,
      firstExpansionAtMs: null,
    },
  });

  // The pending audit case first, for the same reason V1 promotes that way: it is the
  // row the scanner wrote and the only one holding the pre-alert observation. The
  // claim case is the fallback for callouts captured after the thesis went active.
  const candidates = [input.preMoveCaseId, input.opportunityCaseId]
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  for (const caseId of candidates) {
    try {
      const res = db.prepare(
        `UPDATE ${TABLE} SET
           v2_captured=1,
           session_high_at_alert=COALESCE(session_high_at_alert, ?),
           session_low_at_alert=COALESCE(session_low_at_alert, ?),
           session_open_at_alert=COALESCE(session_open_at_alert, ?),
           vwap_at_alert=COALESCE(vwap_at_alert, ?),
           trigger_level_at_alert=COALESCE(trigger_level_at_alert, ?),
           trigger_taken_at_alert=COALESCE(trigger_taken_at_alert, ?),
           first_partial_confirmation_at_ms=COALESCE(first_partial_confirmation_at_ms, ?),
           entry_premium=COALESCE(entry_premium, ?),
           target1_premium=COALESCE(target1_premium, ?),
           target2_premium=COALESCE(target2_premium, ?),
           stop_premium=COALESCE(stop_premium, ?),
           v2_model_version=?,
           v2_definition_hash=?,
           v2_discovery_stage=?,
           v2_trigger_state=?,
           v2_session_move_consumed_fraction=?,
           v2_reward_remaining_fraction=?,
           v2_underlying_move_consumed_pct=?,
           v2_premium_expansion_consumed_pct=?,
           v2_distance_to_trigger_pct=?,
           v2_extension_from_vwap_pct=?,
           v2_evidence_quality=?,
           v2_missing_fields_json=?,
           v2_reason=?,
           updated_at_ms=?
         WHERE opportunity_case_id=? AND v2_captured=0`,
      ).run?.(
        num(input.sessionHighAtAlert), num(input.sessionLowAtAlert),
        num(input.sessionOpenAtAlert), num(input.vwapAtAlert),
        num(input.triggerLevelAtAlert), boolCol(input.triggerTakenAtAlert),
        num(input.firstPartialConfirmationAtMs),
        num(input.entryPremium), num(input.target1Premium),
        num(input.target2Premium), num(input.stopPremium),
        PRE_MOVE_DISCOVERY_V2_VERSION, PRE_MOVE_DISCOVERY_V2_DEFINITION_HASH,
        classification.stage, classification.triggerState,
        classification.sessionMoveConsumedFraction, classification.rewardRemainingFraction,
        classification.underlyingMoveConsumedPct, classification.premiumExpansionConsumedPct,
        classification.distanceToTriggerPct, classification.extensionFromVwapPct,
        evidenceQuality(classification), JSON.stringify(classification.missingInputs),
        classification.reason,
        input.ownerNotifiedAtMs, caseId,
      );
      if (res && res.changes > 0) {
        return { stored: true, stage: classification.stage, caseId };
      }
    } catch {
      // Fall through to the next candidate; an audit write may never break a send.
    }
  }
  return { stored: false, stage: null, caseId: null };
}

/**
 * Record the first tick on which the contract's premium had visibly expanded.
 *
 * Separate from the alert capture because it is, by construction, later. Write-once:
 * the FIRST expansion is the one that answers "how long until it started paying", and
 * a later one would make every callout look slower than it was.
 */
export function recordPreMoveV2ExpansionOnDb(
  db: PreMoveV2Db,
  input: { opportunityCaseId: string; atMs: number },
): boolean {
  if (!hasV2Columns(db)) return false;
  try {
    const res = db.prepare(
      `UPDATE ${TABLE} SET first_expansion_at_ms=?, updated_at_ms=?
        WHERE opportunity_case_id=? AND v2_captured=1 AND first_expansion_at_ms IS NULL`,
    ).run?.(input.atMs, input.atMs, input.opportunityCaseId);
    return Boolean(res && res.changes > 0);
  } catch {
    return false;
  }
}

export interface PreMoveV2Row {
  opportunityCaseId: string;
  sessionDate: string | null;
  symbol: string | null;
  side: OptionSideV2 | null;
  optionSymbol: string | null;
  strategyKey: string | null;
  lane: string | null;

  captured: boolean;
  modelVersion: string | null;
  definitionHash: string | null;
  stage: DiscoveryStageV2 | null;
  triggerState: TriggerStateV2 | null;

  sessionMoveConsumedFraction: number | null;
  rewardRemainingFraction: number | null;
  underlyingMoveConsumedPct: number | null;
  premiumExpansionConsumedPct: number | null;
  distanceToTriggerPct: number | null;
  extensionFromVwapPct: number | null;

  underlyingAtAlert: number | null;
  sessionHighAtAlert: number | null;
  sessionLowAtAlert: number | null;
  entryPremium: number | null;
  target1Premium: number | null;
  target2Premium: number | null;
  stopPremium: number | null;

  firstSetupObservedAtMs: number | null;
  firstPartialConfirmationAtMs: number | null;
  firstFullConfirmationAtMs: number | null;
  ownerCalloutAtMs: number | null;
  firstExpansionAtMs: number | null;

  evidenceQuality: PreMoveV2EvidenceQuality | null;
  missingFields: string[];
  reason: string | null;
}

function toRow(r: Record<string, any>): PreMoveV2Row {
  let missing: string[] = [];
  try { missing = r.v2_missing_fields_json ? JSON.parse(r.v2_missing_fields_json) : []; } catch { missing = []; }
  return {
    opportunityCaseId: String(r.opportunity_case_id),
    sessionDate: r.session_date ?? null,
    symbol: r.symbol ?? null,
    side: (r.option_side as OptionSideV2 | null) ?? null,
    optionSymbol: r.option_symbol ?? null,
    strategyKey: r.strategy_key ?? null,
    lane: r.lane ?? null,
    captured: Number(r.v2_captured ?? 0) === 1,
    modelVersion: r.v2_model_version ?? null,
    definitionHash: r.v2_definition_hash ?? null,
    stage: (r.v2_discovery_stage as DiscoveryStageV2 | null) ?? null,
    triggerState: (r.v2_trigger_state as TriggerStateV2 | null) ?? null,
    sessionMoveConsumedFraction: num(r.v2_session_move_consumed_fraction),
    rewardRemainingFraction: num(r.v2_reward_remaining_fraction),
    underlyingMoveConsumedPct: num(r.v2_underlying_move_consumed_pct),
    premiumExpansionConsumedPct: num(r.v2_premium_expansion_consumed_pct),
    distanceToTriggerPct: num(r.v2_distance_to_trigger_pct),
    extensionFromVwapPct: num(r.v2_extension_from_vwap_pct),
    underlyingAtAlert: num(r.underlying_at_alert),
    sessionHighAtAlert: num(r.session_high_at_alert),
    sessionLowAtAlert: num(r.session_low_at_alert),
    entryPremium: num(r.entry_premium),
    target1Premium: num(r.target1_premium),
    target2Premium: num(r.target2_premium),
    stopPremium: num(r.stop_premium),
    firstSetupObservedAtMs: num(r.first_detected_at_ms),
    firstPartialConfirmationAtMs: num(r.first_partial_confirmation_at_ms),
    firstFullConfirmationAtMs: num(r.confirmation_completed_at_ms),
    ownerCalloutAtMs: num(r.owner_notified_at_ms),
    firstExpansionAtMs: num(r.first_expansion_at_ms),
    evidenceQuality: (r.v2_evidence_quality as PreMoveV2EvidenceQuality | null) ?? null,
    missingFields: missing,
    reason: r.v2_reason ?? null,
  };
}

/**
 * Every row that carries a V2 capture.
 *
 * Rows without one are NOT returned as UNGRADABLE members — they are not V2 rows at
 * all. Returning them would put a population that predates the measurement into the
 * measurement's own denominator, and every rate computed from it would be diluted by
 * trades V2 never observed.
 */
export function listPreMoveV2RowsOnDb(
  db: PreMoveV2Db,
  opts: { sinceMs?: number | null; lane?: string | null; limit?: number } = {},
): PreMoveV2Row[] {
  if (!hasV2Columns(db)) return [];
  const where: string[] = ["v2_captured=1"];
  const args: any[] = [];
  if (opts.sinceMs != null) { where.push("owner_notified_at_ms >= ?"); args.push(opts.sinceMs); }
  if (opts.lane) { where.push("lane = ?"); args.push(opts.lane); }
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 2000));
  try {
    const rows = db.prepare(
      `SELECT * FROM ${TABLE} WHERE ${where.join(" AND ")}
        ORDER BY owner_notified_at_ms DESC LIMIT ${limit}`,
    ).all?.(...args) ?? [];
    return rows.map(toRow);
  } catch {
    return [];
  }
}

/**
 * How many rows the V2 measurement actually covers, and how many it does not.
 *
 * Reported as two numbers rather than one rate, because "V2 has graded 0 of 70
 * callouts" and "V2 has graded 0 callouts" mean very different things while the
 * capture site is young, and only the first is honest.
 */
export function preMoveV2CoverageOnDb(db: PreMoveV2Db): {
  available: boolean;
  capturedRows: number;
  uncapturedRows: number;
  capturedOwnerRows: number;
  definitionHash: string;
  note: string;
} {
  const base = {
    available: false,
    capturedRows: 0,
    uncapturedRows: 0,
    capturedOwnerRows: 0,
    definitionHash: PRE_MOVE_DISCOVERY_V2_DEFINITION_HASH,
    note: "PRE_MOVE_DISCOVERY_V2 columns are not present on this database.",
  };
  if (!hasV2Columns(db)) return base;
  const n = (sql: string): number => {
    try { return Number(db.prepare(sql).get?.()?.n ?? 0); } catch { return 0; }
  };
  return {
    available: true,
    capturedRows: n(`SELECT COUNT(*) n FROM ${TABLE} WHERE v2_captured=1`),
    uncapturedRows: n(`SELECT COUNT(*) n FROM ${TABLE} WHERE v2_captured=0`),
    capturedOwnerRows: n(`SELECT COUNT(*) n FROM ${TABLE} WHERE v2_captured=1 AND owner_notified_at_ms IS NOT NULL`),
    definitionHash: PRE_MOVE_DISCOVERY_V2_DEFINITION_HASH,
    note:
      "Uncaptured rows are NOT V2 rows. They predate the V2 capture site and are excluded "
      + "from every V2 population rather than counted as UNGRADABLE members — including them "
      + "would dilute every rate with trades the measurement never observed. Nothing is "
      + "back-filled and no V1 row was reclassified.",
  };
}

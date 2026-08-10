/**
 * pre-move-store.ts — the PROSPECTIVE side of PRE_MOVE_DISCOVERY_V1.
 *
 * `pre-move-discovery.ts` can classify a discovery. Until this module existed nothing
 * called it, so it graded nothing: a classifier with no capture site is a function, not
 * a measurement. This is the capture.
 *
 * The single invariant that makes the whole thing honest:
 *
 *     DETECTION-STAGE EVIDENCE IS WRITE-ONCE.
 *
 * "The underlying when we first saw this symbol" stops being true the moment a later
 * scan overwrites it, and the scanner re-evaluates the same living case many times a
 * session. A discovery stage computed from an overwritten detection price would compare
 * the alert price against itself and report every alert as perfectly early — a metric
 * that always says what we want to hear. Every detection column is therefore written
 * with COALESCE(existing, new): the first observation wins forever.
 *
 * Later stages are also write-once for the SAME reason, each at its own moment:
 * eligibility fields fill the first time a candidate is READY, alert fields the first
 * time an owner is notified. The classification itself is recomputed on every
 * observation, because it is a derived read of those frozen inputs.
 *
 * No provider call is ever made from here. Every value is taken from evidence the live
 * path already had in hand; a field the scanner did not compute is stored as null and
 * named in `missingFields`. Filling a gap with a fetch would change what the scanner
 * costs in order to measure it.
 *
 * Diagnostic only. Nothing here is read by a gate, a threshold, a ranking weight, a
 * stop or an exit.
 */
import {
  PRE_MOVE_DISCOVERY_VERSION,
  classifyDiscovery,
  computeRewardRemaining,
  type DiscoveryClassification,
  type DiscoveryStage,
  type OptionSide,
} from "./pre-move-discovery.ts";

export interface PreMoveDb {
  prepare(sql: string): {
    run?: (...a: any[]) => { changes: number };
    get?: (...a: any[]) => any;
    all?: (...a: any[]) => any[];
  };
}

/** Which population the opportunity belongs to. Never blended downstream. */
export type PreMoveLane = "OWNER" | "RESEARCH" | "SHADOW" | "EXPERIMENT";

/**
 * How much of the observation the evidence actually supports.
 *
 * Deliberately separate from `discoveryStage`. A stage of TOO_LATE computed from three
 * missing inputs and one computed from a complete picture are different claims, and
 * collapsing them would let a guess be read as a finding.
 */
export type PreMoveEvidenceQuality = "COMPLETE" | "PARTIAL" | "INSUFFICIENT";

export interface PreMoveDetectionInput {
  opportunityCaseId: string;
  sessionDate: string | null;
  symbol: string;
  direction: string | null;
  side: OptionSide;
  optionSymbol: string | null;
  strategyKey: string | null;
  deploymentSha: string | null;
  lane: PreMoveLane;
  nowMs: number;

  /** True the first time the candidate is READY — i.e. confirmation completed. */
  eligible: boolean;

  underlyingPrice: number | null;
  optionAsk: number | null;

  triggerLevel?: number | null;
  triggerTaken?: boolean | null;
  compressionPct?: number | null;
  volumeAcceleration?: number | null;
  sessionHigh?: number | null;
  sessionLow?: number | null;
  vwap?: number | null;
  aboveVwap?: boolean | null;
  breakoutState?: string | null;
  marketAlignment?: string | null;
  regime?: string | null;
  dte?: number | null;
  delta?: number | null;
  iv?: number | null;
  spreadPct?: number | null;
  openInterest?: number | null;
  contractVolume?: number | null;
  moneynessPct?: number | null;
}

export interface PreMoveAlertInput {
  opportunityCaseId: string;
  ownerNotifiedAtMs: number;
  underlyingAtAlert: number | null;
  optionAtAlert: number | null;
  lane?: PreMoveLane;
}

const TABLE = "opportunity_pre_move_discovery";

function hasTable(db: PreMoveDb): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(TABLE));
  } catch {
    return false;
  }
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const boolCol = (v: boolean | null | undefined): number | null =>
  v == null ? null : v ? 1 : 0;

/**
 * Which fields the classification WANTED and did not get.
 *
 * Reported alongside the stage rather than folded into it. `classifyDiscovery` already
 * names the inputs it could not read; this adds the ones the capture site itself could
 * not supply, so a reader can tell a thin observation from a complete one.
 */
function evidenceQuality(c: DiscoveryClassification, row: { sessionHigh: number | null; sessionLow: number | null }): PreMoveEvidenceQuality {
  if (c.stage === "UNGRADABLE") return "INSUFFICIENT";
  if (c.missingInputs.length > 0) return "PARTIAL";
  // A stage reached without a session extent fell back to premium expansion alone. That
  // is a real answer, but it is not the full picture and must not read as one.
  if (row.sessionHigh == null || row.sessionLow == null) return "PARTIAL";
  return "COMPLETE";
}

export interface PreMoveRow {
  opportunityCaseId: string;
  sessionDate: string | null;
  symbol: string | null;
  side: OptionSide | null;
  optionSymbol: string | null;
  strategyKey: string | null;
  lane: PreMoveLane | null;
  modelVersion: string;
  deploymentSha: string | null;

  firstDetectedAtMs: number | null;
  firstEligibleAtMs: number | null;
  confirmationStartedAtMs: number | null;
  confirmationCompletedAtMs: number | null;
  contractSelectedAtMs: number | null;
  ownerNotifiedAtMs: number | null;

  underlyingAtDetection: number | null;
  underlyingAtEligible: number | null;
  underlyingAtAlert: number | null;
  optionAtDetection: number | null;
  optionAtEligible: number | null;
  optionAtAlert: number | null;
  /** Most recent decision-time observation. Overwritten every scan, by design. */
  underlyingAtLatest: number | null;
  optionAtLatest: number | null;
  latestObservedAtMs: number | null;

  discoveryStage: DiscoveryStage | null;
  underlyingMoveConsumedPct: number | null;
  premiumExpansionConsumedPct: number | null;
  moveConsumedFraction: number | null;
  rewardRemainingFraction: number | null;
  rewardRemainingBand: string | null;
  evidenceQuality: PreMoveEvidenceQuality | null;
  missingFields: string[];
  classificationReason: string | null;
  observations: number;
}

function toRow(r: Record<string, any>): PreMoveRow {
  let missing: string[] = [];
  try { missing = r.missing_fields_json ? JSON.parse(r.missing_fields_json) : []; } catch { missing = []; }
  return {
    opportunityCaseId: String(r.opportunity_case_id),
    sessionDate: r.session_date == null ? null : String(r.session_date),
    symbol: r.symbol == null ? null : String(r.symbol),
    side: r.option_side == null ? null : (String(r.option_side) as OptionSide),
    optionSymbol: r.option_symbol == null ? null : String(r.option_symbol),
    strategyKey: r.strategy_key == null ? null : String(r.strategy_key),
    lane: r.lane == null ? null : (String(r.lane) as PreMoveLane),
    modelVersion: String(r.model_version ?? PRE_MOVE_DISCOVERY_VERSION),
    deploymentSha: r.deployment_sha == null ? null : String(r.deployment_sha),
    firstDetectedAtMs: num(r.first_detected_at_ms),
    firstEligibleAtMs: num(r.first_eligible_at_ms),
    confirmationStartedAtMs: num(r.confirmation_started_at_ms),
    confirmationCompletedAtMs: num(r.confirmation_completed_at_ms),
    contractSelectedAtMs: num(r.contract_selected_at_ms),
    ownerNotifiedAtMs: num(r.owner_notified_at_ms),
    underlyingAtDetection: num(r.underlying_at_detection),
    underlyingAtEligible: num(r.underlying_at_eligible),
    underlyingAtAlert: num(r.underlying_at_alert),
    optionAtDetection: num(r.option_at_detection),
    optionAtEligible: num(r.option_at_eligible),
    optionAtAlert: num(r.option_at_alert),
    underlyingAtLatest: num(r.underlying_at_latest),
    optionAtLatest: num(r.option_at_latest),
    latestObservedAtMs: num(r.latest_observed_at_ms),
    discoveryStage: r.discovery_stage == null ? null : (String(r.discovery_stage) as DiscoveryStage),
    underlyingMoveConsumedPct: num(r.underlying_move_consumed_pct),
    premiumExpansionConsumedPct: num(r.premium_expansion_consumed_pct),
    moveConsumedFraction: num(r.move_consumed_fraction),
    rewardRemainingFraction: num(r.reward_remaining_fraction),
    rewardRemainingBand: r.reward_remaining_band == null ? null : String(r.reward_remaining_band),
    evidenceQuality: r.evidence_quality == null ? null : (String(r.evidence_quality) as PreMoveEvidenceQuality),
    missingFields: Array.isArray(missing) ? missing : [],
    classificationReason: r.classification_reason == null ? null : String(r.classification_reason),
    observations: Number(r.observations ?? 0),
  };
}

export function readPreMoveDiscoveryOnDb(db: PreMoveDb, opportunityCaseId: string): PreMoveRow | null {
  if (!hasTable(db)) return null;
  try {
    const r = db.prepare(`SELECT * FROM ${TABLE} WHERE opportunity_case_id=?`).get?.(opportunityCaseId);
    return r ? toRow(r) : null;
  } catch {
    return null;
  }
}

/**
 * Re-derive the classification from whatever the row now holds and write it back.
 *
 * Reads only stored, decision-time columns — never the caller's fresher values — so the
 * stage always describes the frozen evidence rather than the moment it was recomputed.
 */
function reclassify(db: PreMoveDb, opportunityCaseId: string, nowMs: number): DiscoveryClassification | null {
  const row = readPreMoveDiscoveryOnDb(db, opportunityCaseId);
  if (!row || row.side == null) return null;
  const raw = db.prepare(`SELECT * FROM ${TABLE} WHERE opportunity_case_id=?`).get?.(opportunityCaseId) as Record<string, any>;

  const c = classifyDiscovery({
    side: row.side,
    underlyingAtFirstDetection: row.underlyingAtDetection,
    underlyingAtEligible: row.underlyingAtEligible,
    // The "current" end of the measurement. An alert, when one exists, is the only
    // endpoint that answers "how much had the move consumed BEFORE we told the owner".
    // Otherwise it is the LATEST observation — never detection, which would measure
    // detection against itself, score 0% consumed and report every unalerted research
    // row as maximally early forever.
    underlyingAtAlert: row.underlyingAtAlert ?? row.underlyingAtLatest,
    optionAtFirstDetection: row.optionAtDetection,
    optionAtEligible: row.optionAtEligible,
    optionAtAlert: row.optionAtAlert ?? row.optionAtLatest,
    triggerLevel: num(raw?.trigger_level),
    triggerTaken: raw?.trigger_taken == null ? null : Boolean(raw.trigger_taken),
    sessionHigh: num(raw?.session_high),
    sessionLow: num(raw?.session_low),
    compressionPct: num(raw?.compression_pct),
    volumeAcceleration: num(raw?.volume_acceleration),
    firstDetectedAtMs: row.firstDetectedAtMs,
    eligibleAtMs: row.firstEligibleAtMs,
    alertAtMs: row.ownerNotifiedAtMs,
  });

  const reward = computeRewardRemaining(c);
  const quality = evidenceQuality(c, { sessionHigh: num(raw?.session_high), sessionLow: num(raw?.session_low) });

  try {
    db.prepare(
      `UPDATE ${TABLE} SET
         discovery_stage=?, underlying_move_consumed_pct=?, premium_expansion_consumed_pct=?,
         move_consumed_fraction=?, reward_remaining_fraction=?, reward_remaining_band=?,
         evidence_quality=?, missing_fields_json=?, classification_reason=?, updated_at_ms=?
       WHERE opportunity_case_id=?`,
    ).run?.(
      c.stage, c.underlyingMoveConsumedPct, c.premiumExpansionConsumedPct,
      c.moveConsumedFraction, reward.fraction, reward.band,
      quality, JSON.stringify(c.missingInputs), c.reason, nowMs,
      opportunityCaseId,
    );
  } catch { /* classification is diagnostic; a write failure never blocks the scan */ }
  return c;
}

/**
 * Record one live observation of an opportunity.
 *
 * Safe to call on every scan of the same case — that is the expected usage. The first
 * call establishes detection; later calls can only ADD evidence that did not exist yet
 * (eligibility, a selected contract), never revise what was already observed.
 *
 * Returns false when the table is absent or the write failed. Never throws: this is an
 * audit path and must not be able to take down a scan.
 */
export function recordPreMoveObservationOnDb(db: PreMoveDb, input: PreMoveDetectionInput): boolean {
  if (!hasTable(db)) return false;
  const now = input.nowMs;
  const eligibleAt = input.eligible ? now : null;
  const contractAt = input.optionSymbol ? now : null;
  try {
    db.prepare(
      `INSERT INTO ${TABLE} (
         opportunity_case_id, session_date, symbol, direction, option_side, option_symbol,
         strategy_key, model_version, deployment_sha, lane,
         first_detected_at_ms, first_eligible_at_ms, confirmation_started_at_ms,
         confirmation_completed_at_ms, contract_selected_at_ms,
         underlying_at_detection, underlying_at_eligible,
         option_at_detection, option_at_eligible,
         underlying_at_latest, option_at_latest, latest_observed_at_ms,
         trigger_level, trigger_taken, compression_pct, volume_acceleration,
         session_high, session_low, vwap, above_vwap, breakout_state, market_alignment, regime,
         dte, delta, iv, spread_pct, open_interest, contract_volume, moneyness_pct,
         observations, created_at_ms, updated_at_ms
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
       ON CONFLICT(opportunity_case_id) DO UPDATE SET
         -- Identity may be filled in later but never rewritten.
         option_symbol=COALESCE(${TABLE}.option_symbol, excluded.option_symbol),
         strategy_key=COALESCE(${TABLE}.strategy_key, excluded.strategy_key),
         session_date=COALESCE(${TABLE}.session_date, excluded.session_date),
         direction=COALESCE(${TABLE}.direction, excluded.direction),
         -- Every timing and price column below is WRITE-ONCE. COALESCE keeps the FIRST
         -- observation: a later scan of the same living case must not be able to move
         -- "when we found it" forward, which would make every alert look early.
         first_eligible_at_ms=COALESCE(${TABLE}.first_eligible_at_ms, excluded.first_eligible_at_ms),
         confirmation_completed_at_ms=COALESCE(${TABLE}.confirmation_completed_at_ms, excluded.confirmation_completed_at_ms),
         contract_selected_at_ms=COALESCE(${TABLE}.contract_selected_at_ms, excluded.contract_selected_at_ms),
         underlying_at_eligible=COALESCE(${TABLE}.underlying_at_eligible, excluded.underlying_at_eligible),
         option_at_eligible=COALESCE(${TABLE}.option_at_eligible, excluded.option_at_eligible),
         -- The three deliberate exceptions to write-once: the CURRENT observation. Kept
         -- only when the new scan actually produced one, so a scan that could not price
         -- the symbol does not erase the last time we could.
         underlying_at_latest=COALESCE(excluded.underlying_at_latest, ${TABLE}.underlying_at_latest),
         option_at_latest=COALESCE(excluded.option_at_latest, ${TABLE}.option_at_latest),
         latest_observed_at_ms=excluded.latest_observed_at_ms,
         -- Contract descriptives belong to the contract that was actually selected, so
         -- they land with it and stay.
         dte=COALESCE(${TABLE}.dte, excluded.dte),
         delta=COALESCE(${TABLE}.delta, excluded.delta),
         iv=COALESCE(${TABLE}.iv, excluded.iv),
         spread_pct=COALESCE(${TABLE}.spread_pct, excluded.spread_pct),
         open_interest=COALESCE(${TABLE}.open_interest, excluded.open_interest),
         contract_volume=COALESCE(${TABLE}.contract_volume, excluded.contract_volume),
         moneyness_pct=COALESCE(${TABLE}.moneyness_pct, excluded.moneyness_pct),
         -- Session extremes are the ONE exception and the exception is deliberate: the
         -- day's favourable extent is the denominator the stage is measured against, and
         -- it can only be known as the session unfolds. MAX/MIN so it can widen but never
         -- narrow — a shrinking denominator would inflate the share already consumed.
         session_high=MAX(COALESCE(${TABLE}.session_high, excluded.session_high), COALESCE(excluded.session_high, ${TABLE}.session_high)),
         session_low=MIN(COALESCE(${TABLE}.session_low, excluded.session_low), COALESCE(excluded.session_low, ${TABLE}.session_low)),
         observations=${TABLE}.observations + 1,
         updated_at_ms=excluded.updated_at_ms`,
    ).run?.(
      input.opportunityCaseId, input.sessionDate, input.symbol, input.direction, input.side,
      input.optionSymbol, input.strategyKey, PRE_MOVE_DISCOVERY_VERSION, input.deploymentSha, input.lane,
      now, eligibleAt, now, eligibleAt, contractAt,
      num(input.underlyingPrice), input.eligible ? num(input.underlyingPrice) : null,
      num(input.optionAsk), input.eligible ? num(input.optionAsk) : null,
      num(input.underlyingPrice), num(input.optionAsk), now,
      num(input.triggerLevel), boolCol(input.triggerTaken), num(input.compressionPct), num(input.volumeAcceleration),
      num(input.sessionHigh), num(input.sessionLow), num(input.vwap), boolCol(input.aboveVwap),
      input.breakoutState ?? null, input.marketAlignment ?? null, input.regime ?? null,
      num(input.dte), num(input.delta), num(input.iv), num(input.spreadPct),
      num(input.openInterest), num(input.contractVolume), num(input.moneynessPct),
      now, now,
    );
  } catch {
    return false;
  }
  reclassify(db, input.opportunityCaseId, now);
  return true;
}

/**
 * Complete the alert-time evidence for a case an owner was actually notified about.
 *
 * Also write-once: a re-sent or retried alert must not move the moment the owner first
 * saw it, because lead time is measured from that moment and a later timestamp would
 * shorten every measured lead.
 */
export function recordPreMoveAlertOnDb(db: PreMoveDb, input: PreMoveAlertInput): boolean {
  if (!hasTable(db)) return false;
  try {
    const res = db.prepare(
      `UPDATE ${TABLE} SET
         owner_notified_at_ms=COALESCE(owner_notified_at_ms, ?),
         underlying_at_alert=COALESCE(underlying_at_alert, ?),
         option_at_alert=COALESCE(option_at_alert, ?),
         lane=COALESCE(?, lane),
         updated_at_ms=?
       WHERE opportunity_case_id=?`,
    ).run?.(
      input.ownerNotifiedAtMs, num(input.underlyingAtAlert), num(input.optionAtAlert),
      input.lane ?? null, input.ownerNotifiedAtMs, input.opportunityCaseId,
    );
    if (!res || res.changes === 0) return false;
  } catch {
    return false;
  }
  reclassify(db, input.opportunityCaseId, input.ownerNotifiedAtMs);
  return true;
}

// ── population reporting ─────────────────────────────────────────────────────

export interface PreMoveStageCensus {
  examined: number;
  byStage: Record<DiscoveryStage, number>;
  byQuality: Record<PreMoveEvidenceQuality, number>;
  /** Cases where an owner was actually notified — the only ones with a real lead time. */
  withOwnerAlert: number;
  /** PRE_TRIGGER + EARLY_CONFIRMATION + EARLY_EXPANSION, as a share of GRADABLE rows. */
  earlyRate: number | null;
  /** TOO_LATE as a share of GRADABLE rows. */
  tooLateRate: number | null;
  medianPremiumConsumedBeforeAlertPct: number | null;
  medianDetectionToAlertMs: number | null;
}

const EMPTY_STAGES: Record<DiscoveryStage, number> = {
  PRE_TRIGGER: 0, EARLY_CONFIRMATION: 0, EARLY_EXPANSION: 0,
  MATURE_MOVE: 0, TOO_LATE: 0, UNGRADABLE: 0,
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : +(((s[m - 1] + s[m]) / 2).toFixed(4));
}

/**
 * Census over a window, optionally one lane at a time.
 *
 * Rates are computed over GRADABLE rows only. Including UNGRADABLE in the denominator
 * would let a day of missing inputs read as a day of late discoveries, which is the
 * opposite finding and would send the investigation to the wrong place.
 */
export function summarizePreMoveDiscoveryOnDb(
  db: PreMoveDb,
  opts: { sinceMs?: number | null; lane?: PreMoveLane | null; limit?: number } = {},
): PreMoveStageCensus {
  const empty: PreMoveStageCensus = {
    examined: 0, byStage: { ...EMPTY_STAGES },
    byQuality: { COMPLETE: 0, PARTIAL: 0, INSUFFICIENT: 0 },
    withOwnerAlert: 0, earlyRate: null, tooLateRate: null,
    medianPremiumConsumedBeforeAlertPct: null, medianDetectionToAlertMs: null,
  };
  if (!hasTable(db)) return empty;
  const limit = Math.max(1, Math.min(20_000, opts.limit ?? 5000));
  const where: string[] = [];
  const params: any[] = [];
  if (opts.sinceMs != null) { where.push("first_detected_at_ms >= ?"); params.push(opts.sinceMs); }
  if (opts.lane) { where.push("lane = ?"); params.push(opts.lane); }
  let rows: Record<string, any>[] = [];
  try {
    rows = (db.prepare(
      `SELECT * FROM ${TABLE} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY first_detected_at_ms DESC LIMIT ?`,
    ).all?.(...params, limit) ?? []) as Record<string, any>[];
  } catch {
    return empty;
  }

  const out: PreMoveStageCensus = { ...empty, byStage: { ...EMPTY_STAGES }, byQuality: { COMPLETE: 0, PARTIAL: 0, INSUFFICIENT: 0 } };
  const expansions: number[] = [];
  const leads: number[] = [];
  let gradable = 0;
  let early = 0;
  let tooLate = 0;

  for (const r of rows) {
    out.examined += 1;
    const stage = (r.discovery_stage ?? "UNGRADABLE") as DiscoveryStage;
    if (stage in out.byStage) out.byStage[stage] += 1;
    const q = (r.evidence_quality ?? "INSUFFICIENT") as PreMoveEvidenceQuality;
    if (q in out.byQuality) out.byQuality[q] += 1;

    if (stage !== "UNGRADABLE") {
      gradable += 1;
      if (stage === "PRE_TRIGGER" || stage === "EARLY_CONFIRMATION" || stage === "EARLY_EXPANSION") early += 1;
      if (stage === "TOO_LATE") tooLate += 1;
    }
    if (r.owner_notified_at_ms != null) {
      out.withOwnerAlert += 1;
      const exp = num(r.premium_expansion_consumed_pct);
      if (exp != null) expansions.push(exp);
      const det = num(r.first_detected_at_ms);
      const alert = num(r.owner_notified_at_ms);
      if (det != null && alert != null && alert >= det) leads.push(alert - det);
    }
  }

  out.earlyRate = gradable ? +(early / gradable).toFixed(4) : null;
  out.tooLateRate = gradable ? +(tooLate / gradable).toFixed(4) : null;
  out.medianPremiumConsumedBeforeAlertPct = median(expansions);
  out.medianDetectionToAlertMs = median(leads);
  return out;
}

/** Every row for a session/lane, for the nightly and for Ask OptiScan grounding. */
export function listPreMoveDiscoveriesOnDb(
  db: PreMoveDb,
  opts: { sinceMs?: number | null; lane?: PreMoveLane | null; ownerAlertedOnly?: boolean; limit?: number } = {},
): PreMoveRow[] {
  if (!hasTable(db)) return [];
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 500));
  const where: string[] = [];
  const params: any[] = [];
  if (opts.sinceMs != null) { where.push("first_detected_at_ms >= ?"); params.push(opts.sinceMs); }
  if (opts.lane) { where.push("lane = ?"); params.push(opts.lane); }
  if (opts.ownerAlertedOnly) where.push("owner_notified_at_ms IS NOT NULL");
  try {
    const rows = (db.prepare(
      `SELECT * FROM ${TABLE} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY first_detected_at_ms DESC LIMIT ?`,
    ).all?.(...params, limit) ?? []) as Record<string, any>[];
    return rows.map(toRow);
  } catch {
    return [];
  }
}

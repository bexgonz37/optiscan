/**
 * reconstruct.ts — what OptiScan actually saw, read from persisted evidence only.
 *
 * ZERO PROVIDER CALLS. Every function here reads the database. That is deliberate:
 * the question "why was nothing called" is a question about decisions the system
 * already recorded, and answering it must never compete with live marking for the
 * saturated minute cap it may be about to blame.
 *
 * Every table read is hasTable-guarded and every query is bounded. A missing table
 * yields an empty lane, never an exception — this is research and is always the
 * thing that gives way.
 *
 * NO INFERENCE ABOUT ABSENCE. If a lane has no rows, that is reported as "no
 * recorded observation", not as "the lane did not run". Those are different claims
 * and only the first is supported by an empty result.
 */
import {
  emptyLaneDecision,
  type LaneDecision,
} from "./types.ts";

export type ReadDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
};

function hasTable(db: ReadDb, name: string): boolean {
  try {
    return Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
    );
  } catch {
    return false;
  }
}

function safeAll(db: ReadDb, table: string, sql: string, params: unknown[]): any[] {
  if (!hasTable(db, table)) return [];
  try {
    return (db.prepare(sql).all(...params) as any[]) ?? [];
  } catch {
    return [];
  }
}

/**
 * SQL NULL must stay null. `Number(null)` is 0, which would silently turn "this
 * case was never qualified by the subscriber pipeline" into "it was qualified at
 * epoch" — the exact misreport this subsystem exists to avoid.
 */
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Row cap per table. High enough to characterise a session, low enough to bound cost. */
const ROW_LIMIT = 4000;

/**
 * Contracts a candidate row evaluated. `considered_json` shape has varied across
 * versions, so every known shape is accepted and anything unrecognised is skipped
 * rather than guessed at.
 */
export function extractConsideredOccs(consideredJson: unknown): string[] {
  const raw = str(consideredJson);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 4 || v == null) return;
    if (typeof v === "string") {
      const s = v.trim().toUpperCase();
      if (/^O?:?[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(s.replace(/^O:/, "O:"))) out.add(s);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string" && /occ|option_?symbol|contract|ticker/i.test(k)) visit(val, depth + 1);
        else if (typeof val === "object") visit(val, depth + 1);
      }
    }
  };
  visit(parsed, 0);
  return [...out];
}

/**
 * The regular options scanner's view of one symbol on one session.
 *
 * `terminalReason` is the `why` of the LAST row that did not reach READY — the
 * reason the funnel actually ended on, not the most frequent one, because a
 * symbol rejected 40 times for one reason and once for the reason that mattered
 * would otherwise report the noise.
 */
export function reconstructRegularScanner(
  db: ReadDb,
  symbol: string,
  fromMs: number,
  toMs: number,
): LaneDecision {
  const sym = symbol.trim().toUpperCase();
  const lane = emptyLaneDecision();

  const rows = safeAll(
    db,
    "options_candidates",
    `SELECT symbol, direction, side, option_symbol, state, why, considered_json, score,
            research_only, freshness_state, earliness_phase, selected_strategy, created_at_ms
       FROM options_candidates
      WHERE symbol=? AND created_at_ms BETWEEN ? AND ?
      ORDER BY created_at_ms ASC LIMIT ${ROW_LIMIT}`,
    [sym, fromMs, toMs],
  );

  if (rows.length === 0) return lane;

  lane.observationCount = rows.length;
  lane.firstSeenAtMs = num(rows[0].created_at_ms);
  lane.candidateCount = rows.length;

  const considered = new Set<string>();
  let lastNonReady: any = null;
  let firstDirectional: any = null;

  for (const r of rows) {
    const state = str(r.state);
    if (state === "READY") lane.readyCount++;
    else {
      lane.rejectedCount++;
      lastNonReady = r;
    }
    const dir = str(r.direction) ?? str(r.side);
    if (dir && !firstDirectional) firstDirectional = r;
    for (const occ of extractConsideredOccs(r.considered_json)) considered.add(occ);
    const occ = str(r.option_symbol);
    if (occ) considered.add(occ.toUpperCase());
  }

  lane.consideredOccs = [...considered].slice(0, 200);
  lane.firstCandidateAtMs = firstDirectional ? num(firstDirectional.created_at_ms) : null;
  lane.direction = firstDirectional ? (str(firstDirectional.direction) ?? str(firstDirectional.side)) : null;
  lane.setupFamily = firstDirectional ? str(firstDirectional.selected_strategy) : null;

  // The selected contract is the one on the most advanced row: a READY row if any
  // exists, otherwise the latest row that named a contract at all.
  const ready = rows.filter((r) => str(r.state) === "READY" && str(r.option_symbol));
  const named = rows.filter((r) => str(r.option_symbol));
  const chosen = ready.length > 0 ? ready[ready.length - 1] : (named.length > 0 ? named[named.length - 1] : null);
  lane.selectedOcc = chosen ? String(chosen.option_symbol).toUpperCase() : null;
  lane.state = chosen ? str(chosen.state) : str(rows[rows.length - 1].state);
  lane.terminalReason = lastNonReady ? str(lastNonReady.why) : null;

  return lane;
}

/** The High-Asymmetry radar's view of one symbol on one session. */
export function reconstructHighAsymmetry(
  db: ReadDb,
  symbol: string,
  sessionDate: string,
): LaneDecision {
  const sym = symbol.trim().toUpperCase();
  const lane = emptyLaneDecision();

  const rows = safeAll(
    db,
    "asymmetry_cases",
    `SELECT symbol, direction, option_symbol, state, first_detected_at_ms,
            setup_family, early_ask, normal_qualified_at_ms
       FROM asymmetry_cases
      WHERE symbol=? AND session_date=?
      ORDER BY first_detected_at_ms ASC LIMIT ${ROW_LIMIT}`,
    [sym, sessionDate],
  );

  if (rows.length === 0) return lane;

  lane.observationCount = rows.length;
  lane.candidateCount = rows.length;
  lane.firstSeenAtMs = num(rows[0].first_detected_at_ms);
  lane.firstCandidateAtMs = lane.firstSeenAtMs;
  lane.direction = str(rows[0].direction);
  lane.setupFamily = str(rows[0].setup_family);
  lane.consideredOccs = rows.map((r) => String(r.option_symbol ?? "").toUpperCase()).filter(Boolean).slice(0, 200);
  lane.selectedOcc = lane.consideredOccs[0] ?? null;
  lane.state = str(rows[rows.length - 1].state);

  // A High-Asymmetry case that never reached the subscriber pipeline is the
  // "captured but not promoted" signature the root-cause pass looks for.
  const promoted = rows.filter((r) => num(r.normal_qualified_at_ms) != null).length;
  lane.readyCount = promoted;
  lane.rejectedCount = rows.length - promoted;
  lane.terminalReason = promoted === 0 && rows.length > 0
    ? "high_asymmetry_case_never_qualified_in_subscriber_pipeline"
    : null;

  return lane;
}

/** Delivered/attempted subscriber alerts for a symbol in the window. */
export function reconstructAlerts(
  db: ReadDb,
  symbol: string,
  fromMs: number,
  toMs: number,
): {
  alertId: string; occSymbol: string | null; side: string | null; state: string;
  sentAtMs: number | null; entryMid: number | null; deliveredAsk: number | null;
  researchOnly: boolean;
}[] {
  const sym = symbol.trim().toUpperCase();
  return safeAll(
    db,
    "options_alerts",
    `SELECT alert_id, option_symbol, side, state, sent_at_ms, entry_mid,
            delivered_ask, research_only, created_at_ms
       FROM options_alerts
      WHERE candidate_symbol=? AND created_at_ms BETWEEN ? AND ?
      ORDER BY created_at_ms ASC LIMIT 500`,
    [sym, fromMs, toMs],
  ).map((r) => ({
    alertId: String(r.alert_id),
    occSymbol: str(r.option_symbol),
    side: str(r.side),
    state: String(r.state ?? "UNKNOWN"),
    sentAtMs: num(r.sent_at_ms),
    entryMid: num(r.entry_mid),
    deliveredAsk: num(r.delivered_ask),
    researchOnly: Number(r.research_only) === 1,
  }));
}

/** Delivery-authority decisions (suppression, dedup, thresholds) for a symbol. */
export function reconstructDeliveryDecisions(
  db: ReadDb,
  symbol: string,
  fromMs: number,
  toMs: number,
): { outcome: string; reason: string | null; side: string | null; atMs: number | null }[] {
  const sym = symbol.trim().toUpperCase();
  return safeAll(
    db,
    "options_delivery_decisions",
    `SELECT outcome, reason, side, created_at_ms
       FROM options_delivery_decisions
      WHERE symbol=? AND created_at_ms BETWEEN ? AND ?
      ORDER BY created_at_ms ASC LIMIT 1000`,
    [sym, fromMs, toMs],
  ).map((r) => ({
    outcome: String(r.outcome ?? "UNKNOWN"),
    reason: str(r.reason),
    side: str(r.side),
    atMs: num(r.created_at_ms),
  }));
}

/**
 * Prospective research observations — the richest record of what the pipeline
 * believed about the underlying at each moment (VWAP, structure, momentum, and
 * the exact contract quote it was looking at).
 */
export function reconstructObservations(
  db: ReadDb,
  symbol: string,
  sessionDate: string,
): {
  atMs: number | null; direction: string | null; lane: string | null;
  candidateState: string | null; readinessState: string | null; blockers: string | null;
  underlyingPrice: number | null; vwapRelationship: string | null;
  structureState: string | null; momentumState: string | null;
  occSymbol: string | null; bid: number | null; ask: number | null;
  spreadPct: number | null; volume: number | null; openInterest: number | null;
  delta: number | null; dte: number | null; contractQuality: string | null;
  freshness: string | null;
}[] {
  const sym = symbol.trim().toUpperCase();
  return safeAll(
    db,
    "options_research_observations",
    `SELECT observed_at_ms, direction, scanner_lane, candidate_state, readiness_state,
            blockers_json, underlying_price, vwap_relationship, structure_state, momentum_state,
            option_symbol, option_bid, option_ask, spread_pct, volume, open_interest,
            delta, dte, contract_quality_state, freshness_state
       FROM options_research_observations
      WHERE symbol=? AND session_date=?
      ORDER BY observed_at_ms ASC LIMIT ${ROW_LIMIT}`,
    [sym, sessionDate],
  ).map((r) => ({
    atMs: num(r.observed_at_ms),
    direction: str(r.direction),
    lane: str(r.scanner_lane),
    candidateState: str(r.candidate_state),
    readinessState: str(r.readiness_state),
    blockers: str(r.blockers_json),
    underlyingPrice: num(r.underlying_price),
    vwapRelationship: str(r.vwap_relationship),
    structureState: str(r.structure_state),
    momentumState: str(r.momentum_state),
    occSymbol: str(r.option_symbol),
    bid: num(r.option_bid),
    ask: num(r.option_ask),
    spreadPct: num(r.spread_pct),
    volume: num(r.volume),
    openInterest: num(r.open_interest),
    delta: num(r.delta),
    dte: num(r.dte),
    contractQuality: str(r.contract_quality_state),
    freshness: str(r.freshness_state),
  }));
}

/** Everything the database knows about one symbol on one session. */
export interface SymbolReconstruction {
  symbol: string;
  sessionDate: string;
  regularScanner: LaneDecision;
  highAsymmetry: LaneDecision;
  alerts: ReturnType<typeof reconstructAlerts>;
  deliveryDecisions: ReturnType<typeof reconstructDeliveryDecisions>;
  observations: ReturnType<typeof reconstructObservations>;
  /** True when at least one table produced a row. Distinguishes "no data" from "no interest". */
  hasAnyEvidence: boolean;
}

export function reconstructSymbol(
  db: ReadDb,
  symbol: string,
  sessionDate: string,
  fromMs: number,
  toMs: number,
): SymbolReconstruction {
  const regularScanner = reconstructRegularScanner(db, symbol, fromMs, toMs);
  const highAsymmetry = reconstructHighAsymmetry(db, symbol, sessionDate);
  const alerts = reconstructAlerts(db, symbol, fromMs, toMs);
  const deliveryDecisions = reconstructDeliveryDecisions(db, symbol, fromMs, toMs);
  const observations = reconstructObservations(db, symbol, sessionDate);
  return {
    symbol: symbol.trim().toUpperCase(),
    sessionDate,
    regularScanner,
    highAsymmetry,
    alerts,
    deliveryDecisions,
    observations,
    hasAnyEvidence:
      regularScanner.observationCount > 0 ||
      highAsymmetry.observationCount > 0 ||
      alerts.length > 0 ||
      deliveryDecisions.length > 0 ||
      observations.length > 0,
  };
}

/**
 * owner-mirror-identity.ts — the ONE place that answers "which paper mirror belongs to
 * this owner callout".
 *
 * ── The defect this module exists to end ─────────────────────────────────────
 *
 * An owner callout never writes an `options_alerts` row. `sendOwnerPrivateOpening`
 * claims an Opportunity Case, sends the Discord opening, and mirrors the trade into
 * `options_paper_trades` with `paper_kind='OWNER_VALIDATION_PAPER'`. No alert row is
 * created anywhere on that path, so `opportunity_cases.alert_id` and
 * `options_paper_trades.alert_id` are BOTH null for every owner callout ever made.
 * Production at 801b7d0d: 0 of 106 owner cases carry an alert id, 0 of 74 owner mirrors
 * carry one.
 *
 * Five learning consumers nevertheless resolved owner evidence through `alert_id`. They
 * did not error — they returned the empty set, which reads exactly like "the owner made
 * no trades". Nightly research therefore received openings 0, closed 0, wins 0, losses 0,
 * PF null while the owner lane held dozens of exact-OCC tracked trades.
 *
 * ── The durable relationship ─────────────────────────────────────────────────
 *
 * The mirror records the case it was opened for, inside its own feature snapshot:
 *
 *     options_paper_trades.feature_snapshot_json -> { "opportunityCaseId": "oc_..." }
 *
 * That is written by `openOwnerValidationPaperOnDb` at the moment of the mirror and is
 * the only owner link that has ever existed. `owner-mirror-audit.ts` already used it and
 * is the reason the owner mirror rate was measurable at all; this module is that rule,
 * extracted, so a sixth consumer cannot reinvent the broken one.
 *
 * ── The second identity, and why it is derived rather than stored ────────────
 *
 * There are TWO Opportunity Case rows behind one owner callout.
 *
 *   - the CLAIM case (`oc_B`), minted by `claimOpportunityOpenOnDb` at delivery. It owns
 *     the Discord delivery, the frozen trade and the mirror.
 *   - the PENDING audit case (`oc_A`), written by the scanner adapter on the tick that
 *     first saw the setup. It owns the PRE_MOVE observation — the pre-alert evidence.
 *
 * They are different rows with different ids, which is why `recordPreMoveAlertOnDb`
 * (keyed on the claim id) has never once matched a row, why every PRE_MOVE row is still
 * labelled SHADOW/RESEARCH, and why `owner_notified_at_ms` is null across the table.
 *
 * The link is NOT missing — it is computable. The pending id is a pure function of the
 * opportunity fingerprint that both rows carry:
 *
 *     preMoveCaseIdForFingerprint(fp) === deterministicOpportunityId([fp, "pending"])
 *
 * Verified against production: owner case `oc_alfb24` (IWM `O:IWM260819P00301000`,
 * fingerprint `of_1d78kh2`) derives `oc_us70d7`, which exists, carries the same
 * fingerprint, the same exact OCC, and a detection instant 1.8s BEFORE the owner alert.
 *
 * ── Fail closed ──────────────────────────────────────────────────────────────
 *
 * Nothing here fabricates an alert id, invents an `options_alerts` row, or resolves an
 * ambiguous mirror. Two mirrors claiming one case is AMBIGUOUS and yields no mirror; a
 * mirror on a contract the case did not freeze is OCC_MISMATCH and is never treated as
 * exact evidence. Exact OCC identity stays authoritative throughout.
 *
 * Read-only. No provider call, no quota spend, no send authority, no writes.
 */

import { deterministicOpportunityId } from "./schema.ts";

export const OWNER_MIRROR_IDENTITY_VERSION = "OWNER_MIRROR_IDENTITY_V1" as const;

/** The owner lane's `paper_kind`. Never blended with any other lane. */
export const OWNER_VALIDATION_PAPER_KIND = "OWNER_VALIDATION_PAPER" as const;

export interface MirrorIdentityDb {
  prepare(sql: string): { get?: (...a: any[]) => any; all?: (...a: any[]) => any[] };
}

/**
 * The pending audit case id for an opportunity fingerprint.
 *
 * Pure, and deliberately re-derived rather than looked up: `adaptOptionsLiveToCase` mints
 * exactly this id for the scanner-side row, with no time bucket, so one fingerprint has
 * exactly one pending case for all time. A lookup would need a scan of `case_json` and
 * could return more than one row; this cannot.
 */
export function preMoveCaseIdForFingerprint(fingerprint: string | null | undefined): string | null {
  const fp = String(fingerprint ?? "").trim();
  return fp ? deterministicOpportunityId([fp, "pending"]) : null;
}

function hasTable(db: MirrorIdentityDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name));
  } catch {
    return false;
  }
}

/** Normalise an OCC for comparison (case/whitespace only — never rewrites a symbol). */
function normalizeOcc(occ: unknown): string | null {
  const s = String(occ ?? "").trim().toUpperCase();
  return s.length > 0 ? s : null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};

function parseJson(raw: unknown): Record<string, any> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/**
 * Escape a value for a LIKE prefilter.
 *
 * `_` is a single-character wildcard, and every opportunity id contains one at position
 * three (`oc_...`). Unescaped, `oc_k5129y` would also match `ocXk5129y`. The LIKE is only
 * ever a prefilter here — membership is decided by an exact string comparison against the
 * parsed JSON below — but an unescaped wildcard in a query that looks exact is precisely
 * the kind of thing that is true until it is not.
 */
function likeEscape(v: string): string {
  return v.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ── the frozen case facts a mirror is judged against ─────────────────────────

export interface OwnerCaseFacts {
  opportunityCaseId: string;
  symbol: string | null;
  setupFamily: string | null;
  direction: string | null;
  sessionDate: string | null;
  detectedAtMs: number | null;
  /** The contract the owner was actually shown. Authoritative for mirror identity. */
  frozenOptionSymbol: string | null;
  side: "CALL" | "PUT" | null;
  frozenEntry: number | null;
  targetT1: number | null;
  targetT2: number | null;
  stop: number | null;
  opportunityFingerprint: string | null;
  thesisFingerprint: string | null;
  /** Derived, never stored. The case that owns this callout's PRE_MOVE evidence. */
  preMoveCaseId: string | null;
  /** Null for every owner case in existence. Read only to prove that, never to resolve. */
  alertId: string | null;
}

export function loadOwnerCaseFactsOnDb(
  db: MirrorIdentityDb,
  opportunityCaseId: string,
): OwnerCaseFacts | null {
  if (!hasTable(db, "opportunity_cases")) return null;
  let row: Record<string, any> | undefined;
  try {
    row = db.prepare(
      "SELECT opportunity_id, underlying_symbol, direction, setup_family, detected_at_ms, alert_id, case_json"
      + " FROM opportunity_cases WHERE opportunity_id=?",
    ).get?.(opportunityCaseId) as Record<string, any> | undefined;
  } catch {
    return null;
  }
  if (!row) return null;

  const c = parseJson(row.case_json) ?? {};
  const contract = (c.selectedContract ?? {}) as Record<string, any>;
  const frozen = (c.frozenTrade ?? {}) as Record<string, any>;
  const summary = (c.summary ?? {}) as Record<string, any>;
  const sideRaw = String(contract.side ?? "").trim().toUpperCase();
  // Read from `case_json` rather than the columnar field: BOTH writers persist it there
  // (`adaptOptionsLiveToCase` for the pending row, the claim path for the delivery row),
  // whereas the `opportunity_fingerprint` COLUMN is only written by the claim path and is
  // an additive migration that a legacy database may not have run.
  const fingerprint = str(c.opportunityFingerprint);

  return {
    opportunityCaseId: String(row.opportunity_id),
    symbol: str(row.underlying_symbol) ?? str(c.underlyingSymbol),
    setupFamily: str(row.setup_family) ?? str(c.setupFamily),
    direction: str(row.direction) ?? str(c.direction),
    sessionDate: str(c.sessionDate),
    detectedAtMs: num(row.detected_at_ms) ?? num(c.detectedAtMs),
    frozenOptionSymbol: normalizeOcc(contract.optionSymbol),
    side: sideRaw === "PUT" ? "PUT" : sideRaw === "CALL" ? "CALL" : null,
    frozenEntry: num(frozen.entryMid) ?? num(summary.frozenEntry),
    targetT1: num(frozen.targetT1),
    targetT2: num(frozen.targetT2),
    stop: num(frozen.stop),
    opportunityFingerprint: fingerprint,
    thesisFingerprint: str(c.thesisFingerprint),
    preMoveCaseId: preMoveCaseIdForFingerprint(fingerprint),
    alertId: str(row.alert_id) ?? str(c.alertId),
  };
}

// ── the mirror ───────────────────────────────────────────────────────────────

/**
 * Whether a realized return may be quoted, and why not when it may not.
 *
 * VERIFIED needs an EXITED mirror on the alerted contract carrying its own `return_pct`.
 * STILL_OPEN is "not yet", never a zero.
 */
export type RealizedEvidence = "VERIFIED" | "STILL_OPEN" | "UNAVAILABLE";

export interface OwnerMirrorRecord {
  identityVersion: typeof OWNER_MIRROR_IDENTITY_VERSION;
  /** The CLAIM case — the row that owns the delivery, the frozen trade and this mirror. */
  opportunityCaseId: string;
  /** The PENDING audit case, derived from the fingerprint. Owns the PRE_MOVE evidence. */
  preMoveCaseId: string | null;
  opportunityFingerprint: string | null;
  thesisFingerprint: string | null;

  paperTradeId: number;
  paperKind: string;
  /** The mirror's own contract. */
  optionSymbol: string | null;
  /** The contract the case froze. Authoritative. */
  frozenOptionSymbol: string | null;
  /** True only when the mirror sits on the exact contract the callout named. */
  occExact: boolean;

  symbol: string | null;
  side: "CALL" | "PUT" | null;
  strategyKey: string | null;
  setupFamily: string | null;
  dte: number | null;
  strike: number | null;
  expiration: string | null;

  entryFill: number | null;
  exitFill: number | null;
  enteredAtMs: number | null;
  closedAtMs: number | null;
  status: string | null;
  exitReason: string | null;
  entrySession: string | null;

  realizedReturnPct: number | null;
  realizedEvidence: RealizedEvidence;

  /** Frozen at callout. Never recomputed, never adjusted. */
  targetT1: number | null;
  targetT2: number | null;
  stop: number | null;

  /** Marks recorded against this trade ON ITS OWN contract. The exact-mark denominator. */
  marksOnContract: number;
  /** Marks recorded against this trade on any OTHER contract. Evidence, never trajectory. */
  marksOffContract: number;
  /** True when at least one same-contract mark exists, i.e. the trade was observable. */
  exactContractMarksAvailable: boolean;

  /**
   * The delivery-time QUALITY score, 0..1, as recorded on the mirror's own feature
   * snapshot. Exposed for research only — nothing reads it as a gate.
   *
   * This is NOT the `selStrength` an earlier audit reported taking values of exactly 100
   * and below 75. No field of that name is persisted anywhere in this repository, and the
   * owner lane's stored quality spans 0.70–0.86 in production, so that audit's split
   * cannot be reproduced from stored evidence and is not silently renamed into this one.
   */
  deliveryQuality: number | null;
  /** `deliveryQuality` on a 0–100 scale, for readability only. Research only. */
  deliveryQualityScore: number | null;
  readinessState: string | null;
  ownerReason: string | null;

  /**
   * True when more than one owner mirror names this case. The trade is still a real
   * trade and stays in the lane population; it is only barred from being resolved AS
   * the case's mirror, because which one is the callout's cannot be proven.
   */
  caseIdentityAmbiguous: boolean;
}

export type OwnerMirrorState =
  /** Exactly one mirror, on the contract the callout froze. */
  | "RESOLVED"
  /** Exactly one mirror, but on a different contract than the callout named. */
  | "OCC_MISMATCH"
  /** More than one mirror claims this case. Refused rather than guessed. */
  | "AMBIGUOUS"
  /** No owner mirror carries this case id. */
  | "NO_MIRROR"
  /** The case row does not exist. */
  | "CASE_NOT_FOUND"
  /** The paper/case store is not present in this database. */
  | "STORE_UNAVAILABLE";

export interface OwnerMirrorResolution {
  version: typeof OWNER_MIRROR_IDENTITY_VERSION;
  opportunityCaseId: string;
  state: OwnerMirrorState;
  /** Null unless `state` is RESOLVED. An OCC mismatch is never handed back as the mirror. */
  mirror: OwnerMirrorRecord | null;
  /** Every mirror that named this case, whatever the verdict. Reported, never resolved. */
  candidates: OwnerMirrorRecord[];
  facts: OwnerCaseFacts | null;
  reason: string;
}

const PAPER_COLUMNS =
  "id, option_symbol, side, strike, expiration, dte, strategy, status, entry_fill, exit_fill, return_pct,"
  + " exit_reason, entered_at_ms, exit_at_ms, session, paper_kind, alert_id, feature_snapshot_json";

function markCounts(
  db: MirrorIdentityDb,
  tradeId: number,
  occ: string | null,
): { on: number; off: number } {
  if (!hasTable(db, "options_paper_marks")) return { on: 0, off: 0 };
  try {
    const rows = (db.prepare(
      "SELECT option_symbol, COUNT(*) n FROM options_paper_marks WHERE trade_id=? GROUP BY option_symbol",
    ).all?.(tradeId) ?? []) as Record<string, any>[];
    let on = 0;
    let off = 0;
    for (const r of rows) {
      const n = Number(r.n ?? 0);
      if (occ != null && normalizeOcc(r.option_symbol) === occ) on += n;
      else off += n;
    }
    return { on, off };
  } catch {
    return { on: 0, off: 0 };
  }
}

function toRecord(
  db: MirrorIdentityDb,
  row: Record<string, any>,
  facts: OwnerCaseFacts | null,
  caseIdFromSnapshot: string,
  ambiguous: boolean,
): OwnerMirrorRecord {
  const snap = parseJson(row.feature_snapshot_json) ?? {};
  const occ = normalizeOcc(row.option_symbol);
  const frozenOcc = facts?.frozenOptionSymbol ?? null;
  const status = str(row.status);
  const realized = num(row.return_pct);
  const occExact = occ != null && frozenOcc != null && occ === frozenOcc;
  const marks = markCounts(db, Number(row.id), occ);
  const quality = num(snap.quality);
  const sideRaw = String(row.side ?? "").trim().toUpperCase();

  // Realized evidence requires the EXACT contract. A mirror that drifted onto another
  // strike has a return, but it is not the callout's return, and reporting it as one is
  // how a different instrument's result gets attributed to a decision it never made.
  let realizedEvidence: RealizedEvidence = "UNAVAILABLE";
  if (occExact && status === "EXITED" && realized != null) realizedEvidence = "VERIFIED";
  else if (occExact && status === "ENTERED") realizedEvidence = "STILL_OPEN";

  return {
    identityVersion: OWNER_MIRROR_IDENTITY_VERSION,
    opportunityCaseId: caseIdFromSnapshot,
    preMoveCaseId: facts?.preMoveCaseId ?? null,
    opportunityFingerprint: facts?.opportunityFingerprint ?? null,
    thesisFingerprint: facts?.thesisFingerprint ?? str(snap.thesisFingerprint),
    paperTradeId: Number(row.id),
    paperKind: String(row.paper_kind ?? OWNER_VALIDATION_PAPER_KIND),
    optionSymbol: occ,
    frozenOptionSymbol: frozenOcc,
    occExact,
    symbol: facts?.symbol ?? null,
    side: sideRaw === "PUT" ? "PUT" : sideRaw === "CALL" ? "CALL" : facts?.side ?? null,
    strategyKey: str(row.strategy),
    setupFamily: facts?.setupFamily ?? null,
    dte: num(row.dte),
    strike: num(row.strike),
    expiration: str(row.expiration),
    entryFill: num(row.entry_fill),
    exitFill: num(row.exit_fill),
    enteredAtMs: num(row.entered_at_ms),
    closedAtMs: num(row.exit_at_ms),
    status,
    exitReason: str(row.exit_reason),
    entrySession: str(row.session),
    realizedReturnPct: realizedEvidence === "VERIFIED" ? realized : null,
    realizedEvidence,
    targetT1: facts?.targetT1 ?? null,
    targetT2: facts?.targetT2 ?? null,
    stop: facts?.stop ?? null,
    marksOnContract: marks.on,
    marksOffContract: marks.off,
    exactContractMarksAvailable: marks.on > 0,
    deliveryQuality: quality,
    deliveryQualityScore: quality == null ? null : Math.round(quality * 100),
    readinessState: str(snap.readinessState),
    ownerReason: str(snap.ownerReason),
    caseIdentityAmbiguous: ambiguous,
  };
}

/**
 * Owner mirror rows that name one case, matched EXACTLY.
 *
 * The LIKE narrows the scan; the parsed-JSON equality decides. A substring match alone
 * would let `oc_ab` claim `oc_abc`'s mirror on any schema where the trailing quote ever
 * moved, and identity is not a place to rely on a delimiter staying put.
 */
function mirrorRowsForCase(db: MirrorIdentityDb, opportunityCaseId: string): Record<string, any>[] {
  if (!hasTable(db, "options_paper_trades")) return [];
  try {
    const rows = (db.prepare(
      `SELECT ${PAPER_COLUMNS} FROM options_paper_trades
        WHERE paper_kind=? AND feature_snapshot_json LIKE ? ESCAPE '\\'
        ORDER BY id ASC`,
    ).all?.(
      OWNER_VALIDATION_PAPER_KIND,
      `%${likeEscape(`"opportunityCaseId":"${opportunityCaseId}"`)}%`,
    ) ?? []) as Record<string, any>[];
    return rows.filter((r) => str(parseJson(r.feature_snapshot_json)?.opportunityCaseId) === opportunityCaseId);
  } catch {
    return [];
  }
}

/**
 * Just the mirror trade ids for a case, for callers that need a mark series and nothing
 * else.
 *
 * Deliberately does NOT load the case or judge the OCC: `recomputeExcursionOnDb` already
 * holds the frozen contract and filters marks on their own `option_symbol`, and making it
 * pay for a second case read to learn what it already knows would be the kind of cost that
 * quietly stops a diagnostic from being called.
 */
export function ownerMirrorTradeIdsForCaseOnDb(
  db: MirrorIdentityDb,
  opportunityCaseId: string,
): number[] {
  return mirrorRowsForCase(db, opportunityCaseId)
    .map((r) => Number(r.id))
    .filter((n) => Number.isFinite(n));
}

/**
 * THE canonical owner resolution. Every owner-learning consumer goes through this.
 *
 * `opportunityCaseId` may be either identity of the same callout — the claim case that
 * owns the mirror, or the pending audit case that owns its PRE_MOVE row. The pending id
 * is resolved by deriving the claim's fingerprint from the mirror population rather than
 * by scanning, so the two ids answer identically.
 */
export function resolveOwnerMirrorOnDb(
  db: MirrorIdentityDb,
  opportunityCaseId: string,
): OwnerMirrorResolution {
  const base = {
    version: OWNER_MIRROR_IDENTITY_VERSION,
    opportunityCaseId,
    mirror: null,
    candidates: [] as OwnerMirrorRecord[],
    facts: null as OwnerCaseFacts | null,
  };
  if (!hasTable(db, "options_paper_trades") || !hasTable(db, "opportunity_cases")) {
    return { ...base, state: "STORE_UNAVAILABLE", reason: "the paper/case store is not present in this database" };
  }

  const facts = loadOwnerCaseFactsOnDb(db, opportunityCaseId);
  if (!facts) {
    return { ...base, state: "CASE_NOT_FOUND", reason: `no opportunity case ${opportunityCaseId}` };
  }

  const rows = mirrorRowsForCase(db, opportunityCaseId);
  if (!rows.length) {
    return {
      ...base,
      facts,
      state: "NO_MIRROR",
      reason: `no ${OWNER_VALIDATION_PAPER_KIND} mirror names case ${opportunityCaseId}`,
    };
  }

  const ambiguous = rows.length > 1;
  const candidates = rows.map((r) => toRecord(db, r, facts, opportunityCaseId, ambiguous));
  if (ambiguous) {
    return {
      ...base,
      facts,
      candidates,
      state: "AMBIGUOUS",
      reason: `${rows.length} owner mirrors name case ${opportunityCaseId}; identity refused rather than guessed`,
    };
  }

  const only = candidates[0];
  if (!only.occExact) {
    return {
      ...base,
      facts,
      candidates,
      state: "OCC_MISMATCH",
      reason: facts.frozenOptionSymbol == null
        ? "the case froze no contract, so no mirror can be proven to be its own"
        : `mirror is on ${only.optionSymbol}, the callout named ${facts.frozenOptionSymbol}`,
    };
  }

  return {
    ...base,
    facts,
    candidates,
    mirror: only,
    state: "RESOLVED",
    reason: `one owner mirror on the exact contract ${only.optionSymbol}`,
  };
}

// ── the lane population ──────────────────────────────────────────────────────

export interface OwnerMirrorPopulation {
  version: typeof OWNER_MIRROR_IDENTITY_VERSION;
  /** Every OWNER_VALIDATION_PAPER row in the window, whatever its case identity. */
  mirrors: OwnerMirrorRecord[];
  /** Owner mirrors whose feature snapshot names no case at all. Counted, never dropped. */
  withoutCaseIdentity: number;
  /** Cases claimed by more than one mirror. Reported so ambiguity is visible, not silent. */
  ambiguousCaseIds: string[];
  /** Resolution by CLAIM case id, and by PENDING audit case id. Ambiguous ids are absent. */
  byCaseId: Map<string, OwnerMirrorRecord>;
}

/**
 * The whole owner lane, resolved once.
 *
 * Built mirror-first rather than case-first on purpose: the mirror is the object that
 * carries both an identity and an outcome, and a case with no mirror contributes nothing
 * measurable. Consumers that need per-case lookup use `byCaseId`, which is keyed on BOTH
 * identities of every callout so a PRE_MOVE row and a delivery row resolve to one trade.
 */
export function loadOwnerMirrorPopulationOnDb(
  db: MirrorIdentityDb,
  opts: { sinceMs?: number | null; limit?: number } = {},
): OwnerMirrorPopulation {
  const empty: OwnerMirrorPopulation = {
    version: OWNER_MIRROR_IDENTITY_VERSION,
    mirrors: [],
    withoutCaseIdentity: 0,
    ambiguousCaseIds: [],
    byCaseId: new Map(),
  };
  if (!hasTable(db, "options_paper_trades")) return empty;
  const limit = Math.max(1, Math.min(20_000, opts.limit ?? 5000));

  let rows: Record<string, any>[] = [];
  try {
    const where = opts.sinceMs != null
      ? "WHERE paper_kind=? AND COALESCE(entered_at_ms, created_at_ms) >= ?"
      : "WHERE paper_kind=?";
    const params = opts.sinceMs != null
      ? [OWNER_VALIDATION_PAPER_KIND, opts.sinceMs, limit]
      : [OWNER_VALIDATION_PAPER_KIND, limit];
    rows = (db.prepare(
      `SELECT ${PAPER_COLUMNS} FROM options_paper_trades ${where}
        ORDER BY COALESCE(entered_at_ms, created_at_ms) DESC LIMIT ?`,
    ).all?.(...params) ?? []) as Record<string, any>[];
  } catch {
    return empty;
  }

  // Group by the case each mirror names, so duplicates are recognised before any of them
  // is treated as authoritative.
  const byCase = new Map<string, Record<string, any>[]>();
  let withoutCaseIdentity = 0;
  for (const r of rows) {
    const caseId = str(parseJson(r.feature_snapshot_json)?.opportunityCaseId);
    if (!caseId) { withoutCaseIdentity += 1; continue; }
    byCase.set(caseId, [...(byCase.get(caseId) ?? []), r]);
  }

  const mirrors: OwnerMirrorRecord[] = [];
  const ambiguousCaseIds: string[] = [];
  const byCaseId = new Map<string, OwnerMirrorRecord>();
  const factsCache = new Map<string, OwnerCaseFacts | null>();

  for (const [caseId, group] of byCase) {
    if (!factsCache.has(caseId)) factsCache.set(caseId, loadOwnerCaseFactsOnDb(db, caseId));
    const facts = factsCache.get(caseId) ?? null;
    const ambiguous = group.length > 1;
    if (ambiguous) ambiguousCaseIds.push(caseId);
    for (const r of group) {
      const rec = toRecord(db, r, facts, caseId, ambiguous);
      mirrors.push(rec);
      if (!ambiguous) {
        byCaseId.set(caseId, rec);
        // The PRE_MOVE row lives under the pending audit case, which is a DIFFERENT row
        // from the claim case. Both ids point at one trade, and a collision between two
        // callouts' pending ids would be a fingerprint collision — refused, not resolved.
        const pending = rec.preMoveCaseId;
        if (pending && pending !== caseId) {
          if (byCaseId.has(pending) && byCaseId.get(pending)!.paperTradeId !== rec.paperTradeId) {
            byCaseId.delete(pending);
            if (!ambiguousCaseIds.includes(pending)) ambiguousCaseIds.push(pending);
          } else {
            byCaseId.set(pending, rec);
          }
        }
      }
    }
  }

  mirrors.sort((a, b) => (b.enteredAtMs ?? 0) - (a.enteredAtMs ?? 0));
  return {
    version: OWNER_MIRROR_IDENTITY_VERSION,
    mirrors,
    withoutCaseIdentity,
    ambiguousCaseIds: ambiguousCaseIds.sort(),
    byCaseId,
  };
}

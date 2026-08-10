/**
 * Canonical excursion — what the frozen contract ACTUALLY printed, and whether we
 * are entitled to say so.
 *
 * Realized return and excursion are different claims with different evidence:
 *
 *   REALIZED  = (last mark on the frozen contract) vs (frozen entry).  One observation.
 *   EXCURSION = the best/worst the frozen contract reached along the way.  A claim
 *               about EVERY moment, provable only from a mark series dense enough to
 *               have seen the extremes.
 *
 * All 78 delivered cases reproduce their realized return on the frozen contract. That
 * is sound and this module never disturbs it. The peaks beside them are not: 36 sit
 * above anything the frozen contract ever printed (running maxima poisoned by
 * re-selected strikes) and 20 are the `0` the summary seeds at open, which floors
 * every loser's excursion at break-even and reads as "never went against us".
 *
 * Three rules hold throughout:
 *
 *   1. Absence is never zero. A trade with no marks has NO excursion, not 0%.
 *   2. Nothing is invented. Where marks cannot support a value the answer is null and
 *      the state says why.
 *   3. Stored history is never silently rewritten. A correction is a NEW record
 *      carrying the original value, the corrected value, the evidence and the SHA that
 *      computed it, so a later reader can audit the change rather than trust it.
 *
 * Read-only over the mark series. Zero provider calls.
 */

export interface ExcursionDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run?: (...a: any[]) => { changes: number };
  };
  exec?: (sql: string) => unknown;
}

function hasTable(db: ExcursionDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/** Normalise an OCC for comparison (case/whitespace only — never rewrites a symbol). */
function normalizeOcc(occ: string | null | undefined): string | null {
  const s = String(occ ?? "").trim().toUpperCase();
  return s.length > 0 ? s : null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Marks are stored rounded, so an exact float comparison reports false mismatches. */
export const EXCURSION_TOLERANCE_PCT = 0.05;

/**
 * How many same-contract marks a case must carry before its extremes are believable.
 *
 * An excursion is a claim about the whole holding period. Two marks can only show two
 * moments, and calling the better of them "the maximum favourable excursion" asserts
 * the gaps held nothing larger. This is a floor on honesty, not a statistical result —
 * a dense series can still miss a spike between quotes, which is why a VERIFIED
 * excursion is stated as "the best mark observed", never "the high".
 */
export const MIN_MARKS_FOR_EXCURSION = 3;

/**
 * Explicit evidence states. Deliberately not collapsed: "the stored peak is above
 * anything the contract printed" and "the stored peak is the 0 it was born with" both
 * make a case unpublishable, but they are different defects with different fixes, and
 * a reader who cannot tell them apart cannot act on either.
 */
export type ExcursionEvidenceState =
  /** Enough same-contract marks to state the observed extremes. Publishable. */
  | "VERIFIED_EXCURSION"
  /** Frozen contract identified, but too few marks to claim an extreme. */
  | "INSUFFICIENT_MARKS"
  /** Stored peak exceeds anything the frozen contract printed. Contaminated. */
  | "UNSUPPORTED_MAX_RETURN"
  /** Stored peak is the 0 seeded at open on a trade that only traded down. */
  | "MAX_FLOORED_AT_ZERO"
  /** No linked paper mirror at all, so no mark series exists to reason over. */
  | "NO_MIRROR"
  /** The case never froze an OCC (or entry), so no mark can be attributed to it. */
  | "OCC_IDENTITY_MISSING";

/** States that entitle a consumer to quote a maximum favourable excursion. */
export function excursionIsPublishable(state: ExcursionEvidenceState): boolean {
  return state === "VERIFIED_EXCURSION";
}

export interface CanonicalExcursion {
  opportunityCaseId: string;
  symbol: string | null;

  frozenOptionSymbol: string | null;
  frozenEntry: number | null;

  /** What the case currently claims. Preserved verbatim, never rewritten in place. */
  storedMaxReturnPct: number | null;

  /**
   * Best/worst return observed on the FROZEN contract. `null` whenever the marks
   * cannot support the claim — never 0, which would assert an observation.
   */
  canonicalMfePct: number | null;
  canonicalMaePct: number | null;
  /** When the canonical peak was printed. Null when unknown or unsupported. */
  canonicalMfeAtMs: number | null;
  canonicalMaeAtMs: number | null;

  /** Marks on the frozen contract; marks on anything else (evidence, never trajectory). */
  marksOnFrozen: number;
  marksOffFrozen: number;
  firstMarkAtMs: number | null;
  lastMarkAtMs: number | null;

  state: ExcursionEvidenceState;
  /** True when the stored value materially disagrees with the canonical one. */
  storedValueIsWrong: boolean;
  reason: string;
}

interface CaseFacts {
  symbol: string | null;
  frozenOcc: string | null;
  frozenEntry: number | null;
  storedMax: number | null;
  alertId: string | null;
}

function loadCaseFacts(db: ExcursionDb, opportunityCaseId: string): CaseFacts | null {
  if (!hasTable(db, "opportunity_cases")) return null;
  try {
    const row = db.prepare("SELECT case_json FROM opportunity_cases WHERE opportunity_id=?")
      .get(opportunityCaseId) as { case_json?: string } | undefined;
    if (!row?.case_json) return null;
    const c = JSON.parse(row.case_json);
    return {
      symbol: c?.underlyingSymbol ?? null,
      frozenOcc: normalizeOcc(c?.selectedContract?.optionSymbol),
      frozenEntry: num(c?.frozenTrade?.entryMid) ?? num(c?.summary?.frozenEntry),
      storedMax: num(c?.summary?.maxReturnPct),
      alertId: c?.alertId ? String(c.alertId) : null,
    };
  } catch {
    return null;
  }
}

interface FrozenMark {
  returnPct: number;
  atMs: number | null;
}

/**
 * Every mark recorded against this case's frozen contract, across all linked mirrors.
 *
 * The filter is on the MARK's own `option_symbol`, not the mirror's. A mirror is
 * normally single-contract, but the mark row is where the observation actually lives
 * and it is the only field that can prove which instrument produced the price.
 */
function loadFrozenMarks(
  db: ExcursionDb,
  alertId: string | null,
  frozenOcc: string | null,
): { onFrozen: FrozenMark[]; offFrozen: number; hasMirror: boolean } {
  if (!alertId || !hasTable(db, "options_paper_trades")) {
    return { onFrozen: [], offFrozen: 0, hasMirror: false };
  }
  let tradeIds: number[] = [];
  try {
    tradeIds = (db.prepare("SELECT id FROM options_paper_trades WHERE alert_id=?").all(alertId) as any[])
      .map((r) => Number(r.id))
      .filter((n) => Number.isFinite(n));
  } catch {
    return { onFrozen: [], offFrozen: 0, hasMirror: false };
  }
  if (!tradeIds.length || !hasTable(db, "options_paper_marks")) {
    return { onFrozen: [], offFrozen: 0, hasMirror: tradeIds.length > 0 };
  }

  const onFrozen: FrozenMark[] = [];
  let offFrozen = 0;
  for (const id of tradeIds) {
    let rows: any[] = [];
    try {
      rows = db.prepare(
        "SELECT option_symbol, return_pct, mark_at_ms FROM options_paper_marks WHERE trade_id=?",
      ).all(id) as any[];
    } catch {
      continue;
    }
    for (const r of rows) {
      const occ = normalizeOcc(r.option_symbol);
      if (frozenOcc != null && occ === frozenOcc) {
        const ret = num(r.return_pct);
        if (ret != null) onFrozen.push({ returnPct: ret, atMs: num(r.mark_at_ms) });
      } else {
        offFrozen += 1;
      }
    }
  }
  return { onFrozen, offFrozen, hasMirror: true };
}

/**
 * Recompute one case's excursion from first principles.
 *
 * Inputs are ONLY: the frozen OCC, the frozen entry, and marks whose own
 * `option_symbol` is that OCC. The stored `maxReturnPct` is read to be COMPARED
 * against, never to fall back to.
 */
export function recomputeExcursionOnDb(
  db: ExcursionDb,
  opportunityCaseId: string,
): CanonicalExcursion {
  const facts = loadCaseFacts(db, opportunityCaseId);
  const base: CanonicalExcursion = {
    opportunityCaseId,
    symbol: facts?.symbol ?? null,
    frozenOptionSymbol: facts?.frozenOcc ?? null,
    frozenEntry: facts?.frozenEntry ?? null,
    storedMaxReturnPct: facts?.storedMax ?? null,
    canonicalMfePct: null,
    canonicalMaePct: null,
    canonicalMfeAtMs: null,
    canonicalMaeAtMs: null,
    marksOnFrozen: 0,
    marksOffFrozen: 0,
    firstMarkAtMs: null,
    lastMarkAtMs: null,
    state: "OCC_IDENTITY_MISSING",
    storedValueIsWrong: false,
    reason: "case not found",
  };
  if (!facts) return base;

  if (facts.frozenOcc == null || facts.frozenEntry == null || !(facts.frozenEntry > 0)) {
    base.state = "OCC_IDENTITY_MISSING";
    base.reason = facts.frozenOcc == null
      ? "case froze no contract, so no mark can be attributed to it"
      : "case froze no positive entry, so no mark can be turned into a return";
    return base;
  }

  const { onFrozen, offFrozen, hasMirror } = loadFrozenMarks(db, facts.alertId, facts.frozenOcc);
  base.marksOnFrozen = onFrozen.length;
  base.marksOffFrozen = offFrozen;

  if (!hasMirror) {
    base.state = "NO_MIRROR";
    base.reason = "no linked paper mirror, so no mark series exists";
    return base;
  }

  const times = onFrozen.map((m) => m.atMs).filter((t): t is number => t != null);
  base.firstMarkAtMs = times.length ? Math.min(...times) : null;
  base.lastMarkAtMs = times.length ? Math.max(...times) : null;

  if (onFrozen.length < MIN_MARKS_FOR_EXCURSION) {
    base.state = "INSUFFICIENT_MARKS";
    base.reason = `${onFrozen.length} mark(s) on the frozen contract; ${MIN_MARKS_FOR_EXCURSION} needed to claim an extreme`;
    // The stored peak may still be provably impossible even here — a positive claim
    // with no supporting mark at all is wrong regardless of how many marks exist.
    if (facts.storedMax != null && facts.storedMax > 0 && onFrozen.length === 0) {
      base.storedValueIsWrong = true;
      base.reason += `; stored peak ${facts.storedMax}% has no supporting mark`;
    }
    return base;
  }

  let best = onFrozen[0];
  let worst = onFrozen[0];
  for (const m of onFrozen) {
    if (m.returnPct > best.returnPct) best = m;
    if (m.returnPct < worst.returnPct) worst = m;
  }
  base.canonicalMfePct = best.returnPct;
  base.canonicalMaePct = worst.returnPct;
  base.canonicalMfeAtMs = best.atMs;
  base.canonicalMaeAtMs = worst.atMs;

  const stored = facts.storedMax;
  if (stored == null) {
    base.state = "VERIFIED_EXCURSION";
    base.reason = `no stored peak; ${onFrozen.length} same-contract marks give a canonical peak of ${best.returnPct}%`;
    return base;
  }
  // Order matters. A stored 0 on a losing trade is also numerically "above" the best
  // mark, so the generic exceeds-check would swallow it and report contamination. It is
  // not contamination — the identity is sound and the 0 is the seed showing through.
  // Reporting it as cross-contract would be its own false claim, and would hide the
  // cases that genuinely are.
  if (stored === 0 && best.returnPct < 0) {
    base.state = "MAX_FLOORED_AT_ZERO";
    base.storedValueIsWrong = true;
    base.reason = `stored peak is the 0 seeded at open; the frozen contract's best mark was ${best.returnPct}%`;
    return base;
  }
  if (stored > best.returnPct + EXCURSION_TOLERANCE_PCT) {
    base.state = "UNSUPPORTED_MAX_RETURN";
    base.storedValueIsWrong = true;
    base.reason = `stored peak ${stored}% exceeds the frozen contract's best mark ${best.returnPct}%`;
    return base;
  }
  base.state = "VERIFIED_EXCURSION";
  base.reason = `${onFrozen.length} same-contract marks; observed best ${best.returnPct}%, worst ${worst.returnPct}%`;
  return base;
}

/** Recompute a population. `delivered` is the set able to reach a reader. */
export function recomputeExcursionsOnDb(
  db: ExcursionDb,
  opts: { scope?: "delivered" | "all"; limit?: number; caseIds?: string[] } = {},
): CanonicalExcursion[] {
  if (opts.caseIds?.length) return opts.caseIds.map((id) => recomputeExcursionOnDb(db, id));
  if (!hasTable(db, "opportunity_cases")) return [];
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 500));
  const where = (opts.scope ?? "delivered") === "delivered" ? "WHERE delivery_decision='delivered'" : "";
  try {
    const rows = db.prepare(
      `SELECT opportunity_id FROM opportunity_cases ${where} ORDER BY detected_at_ms DESC LIMIT ?`,
    ).all(limit) as { opportunity_id: string }[];
    return rows.map((r) => recomputeExcursionOnDb(db, String(r.opportunity_id)));
  } catch {
    return [];
  }
}

export interface ExcursionCensus {
  examined: number;
  byState: Record<ExcursionEvidenceState, number>;
  /** Cases whose stored peak materially disagrees with the canonical one. */
  storedValuesWrong: number;
  publishable: number;
}

/**
 * Excursion for ONE paper mirror, judged on its own contract.
 *
 * The case-level path above needs an Opportunity Case. An owner validation mirror is
 * a trade in its own right and may be read before any case reconciliation exists, so
 * this asks the narrower question directly: of the marks recorded against this trade,
 * how many were on the trade's OWN contract, and do they support an extreme?
 *
 * The separation this enables is the point. A trade can be a REALIZED winner —
 * `return_pct` against `entry_fill`, one observation, sound — while its trajectory is
 * unknown because only two marks were ever taken. Reporting `mfe_pct` there would
 * assert the gaps held nothing larger. Realized performance and trajectory quality
 * are different measurements and are answered separately.
 */
export function excursionForPaperTradeOnDb(
  db: ExcursionDb,
  tradeId: number,
  optionSymbol: string | null | undefined,
): { state: ExcursionEvidenceState; mfePct: number | null; maePct: number | null; marksOnContract: number } {
  const occ = normalizeOcc(optionSymbol);
  if (occ == null) {
    return { state: "OCC_IDENTITY_MISSING", mfePct: null, maePct: null, marksOnContract: 0 };
  }
  if (!hasTable(db, "options_paper_marks")) {
    return { state: "NO_MIRROR", mfePct: null, maePct: null, marksOnContract: 0 };
  }
  let rows: any[] = [];
  try {
    rows = db.prepare(
      "SELECT return_pct FROM options_paper_marks WHERE trade_id=? AND UPPER(TRIM(option_symbol))=?",
    ).all(tradeId, occ) as any[];
  } catch {
    return { state: "NO_MIRROR", mfePct: null, maePct: null, marksOnContract: 0 };
  }
  const vals = rows.map((r) => num(r.return_pct)).filter((v): v is number => v != null);
  if (vals.length < MIN_MARKS_FOR_EXCURSION) {
    return {
      state: "INSUFFICIENT_MARKS",
      mfePct: null,
      maePct: null,
      marksOnContract: vals.length,
    };
  }
  return {
    state: "VERIFIED_EXCURSION",
    mfePct: Math.max(...vals),
    maePct: Math.min(...vals),
    marksOnContract: vals.length,
  };
}

// ---------------------------------------------------------------------------
// Correction policy
// ---------------------------------------------------------------------------

/**
 * A correction is an ADDITIONAL record, never an edit.
 *
 * Rewriting `summary.maxReturnPct` in place would destroy the only evidence that a
 * wrong number was ever published, and a reader six months from now could not tell a
 * corrected case from one that was always right. So the original value, the evidence
 * state that condemned it, the corrected value where one is provable, and the SHA that
 * computed the correction all persist side by side. `summary.maxReturnPct` is left
 * exactly as it was found.
 *
 * `correctedMaxReturnPct` is null whenever the evidence cannot support a value. That
 * null is the answer — "unknown" — and consumers must render it as unavailable rather
 * than substituting the original, which is the number known to be wrong.
 */
export interface ExcursionCorrection {
  opportunityCaseId: string;
  originalMaxReturnPct: number | null;
  originalSource: string;
  evidenceState: ExcursionEvidenceState;
  correctedMaxReturnPct: number | null;
  correctedMaePct: number | null;
  frozenOptionSymbol: string | null;
  marksOnFrozen: number;
  correctionSha: string | null;
  correctedAtMs: number;
  reason: string;
}

export function correctionFromExcursion(
  e: CanonicalExcursion,
  opts: { nowMs: number; sha?: string | null },
): ExcursionCorrection {
  const verified = excursionIsPublishable(e.state);
  return {
    opportunityCaseId: e.opportunityCaseId,
    originalMaxReturnPct: e.storedMaxReturnPct,
    originalSource: "opportunity_cases.summary_json.maxReturnPct",
    evidenceState: e.state,
    // Only a VERIFIED excursion may replace the stored value. Anything else leaves the
    // corrected value null: "we know the stored number is wrong" and "we know the right
    // one" are different findings, and only the first is established here.
    correctedMaxReturnPct: verified ? e.canonicalMfePct : null,
    correctedMaePct: verified ? e.canonicalMaePct : null,
    frozenOptionSymbol: e.frozenOptionSymbol,
    marksOnFrozen: e.marksOnFrozen,
    correctionSha: opts.sha ?? null,
    correctedAtMs: opts.nowMs,
    reason: e.reason,
  };
}

function correctionsTableReady(db: ExcursionDb): boolean {
  return hasTable(db, "opportunity_excursion_corrections");
}

/** Persist a correction. Repeat-safe: re-running replaces the row for that case. */
export function persistExcursionCorrectionOnDb(
  db: ExcursionDb,
  c: ExcursionCorrection,
): boolean {
  if (!correctionsTableReady(db)) return false;
  try {
    db.prepare(
      `INSERT INTO opportunity_excursion_corrections
        (opportunity_case_id, original_max_return_pct, original_source, evidence_state,
         corrected_max_return_pct, corrected_mae_pct, frozen_option_symbol, marks_on_frozen,
         correction_sha, corrected_at_ms, reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(opportunity_case_id) DO UPDATE SET
         original_max_return_pct=excluded.original_max_return_pct,
         original_source=excluded.original_source,
         evidence_state=excluded.evidence_state,
         corrected_max_return_pct=excluded.corrected_max_return_pct,
         corrected_mae_pct=excluded.corrected_mae_pct,
         frozen_option_symbol=excluded.frozen_option_symbol,
         marks_on_frozen=excluded.marks_on_frozen,
         correction_sha=excluded.correction_sha,
         corrected_at_ms=excluded.corrected_at_ms,
         reason=excluded.reason`,
    ).run!(
      c.opportunityCaseId,
      c.originalMaxReturnPct,
      c.originalSource,
      c.evidenceState,
      c.correctedMaxReturnPct,
      c.correctedMaePct,
      c.frozenOptionSymbol,
      c.marksOnFrozen,
      c.correctionSha,
      c.correctedAtMs,
      c.reason,
    );
    return true;
  } catch {
    return false;
  }
}

export function readExcursionCorrectionOnDb(
  db: ExcursionDb,
  opportunityCaseId: string,
): ExcursionCorrection | null {
  if (!correctionsTableReady(db)) return null;
  try {
    const r = db.prepare(
      `SELECT * FROM opportunity_excursion_corrections WHERE opportunity_case_id=?`,
    ).get(opportunityCaseId) as Record<string, any> | undefined;
    if (!r) return null;
    return {
      opportunityCaseId: String(r.opportunity_case_id),
      originalMaxReturnPct: num(r.original_max_return_pct),
      originalSource: String(r.original_source ?? ""),
      evidenceState: String(r.evidence_state) as ExcursionEvidenceState,
      correctedMaxReturnPct: num(r.corrected_max_return_pct),
      correctedMaePct: num(r.corrected_mae_pct),
      frozenOptionSymbol: r.frozen_option_symbol == null ? null : String(r.frozen_option_symbol),
      marksOnFrozen: Number(r.marks_on_frozen ?? 0),
      correctionSha: r.correction_sha == null ? null : String(r.correction_sha),
      correctedAtMs: Number(r.corrected_at_ms ?? 0),
      reason: String(r.reason ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * What the correction STORE now holds, as distinct from what the population looks like.
 *
 * `ExcursionCensus` counts cases. This counts the corrections written about them, and
 * the two answer different questions. A case can be examined and produce no correction
 * (it never carried a peak to correct); a correction can be recorded and still resolve
 * to nothing (`UNSUPPORTED_MAX_RETURN` establishes the stored value is wrong without
 * establishing the right one). `unresolved` is that second group, and it is reported
 * rather than folded into either "corrected" or "clean" — a null correction is a real
 * finding, not a missing one.
 */
export interface ExcursionCorrectionCensus {
  recorded: number;
  /** Corrections carrying a provable canonical value. Only VERIFIED can. */
  correctedMfe: number;
  correctedMae: number;
  /** Recorded, but the evidence could not supply a replacement value. */
  unresolved: number;
  /** Corrections that condemned the value the case still stores. */
  storedValuesCondemned: number;
  byState: Record<ExcursionEvidenceState, number>;
}

export function summarizeCorrections(rows: ExcursionCorrection[]): ExcursionCorrectionCensus {
  const byState: Record<ExcursionEvidenceState, number> = {
    VERIFIED_EXCURSION: 0,
    INSUFFICIENT_MARKS: 0,
    UNSUPPORTED_MAX_RETURN: 0,
    MAX_FLOORED_AT_ZERO: 0,
    NO_MIRROR: 0,
    OCC_IDENTITY_MISSING: 0,
  };
  let correctedMfe = 0;
  let correctedMae = 0;
  let unresolved = 0;
  let condemned = 0;
  for (const c of rows) {
    byState[c.evidenceState] += 1;
    if (c.correctedMaxReturnPct != null) correctedMfe += 1;
    if (c.correctedMaePct != null) correctedMae += 1;
    if (c.correctedMaxReturnPct == null) unresolved += 1;
    if (!excursionIsPublishable(c.evidenceState) && c.originalMaxReturnPct != null) condemned += 1;
  }
  return { recorded: rows.length, correctedMfe, correctedMae, unresolved, storedValuesCondemned: condemned, byState };
}

/**
 * Reconcile a population and record what was found. Returns the census.
 *
 * Deliberately writes ONLY to the corrections table. It does not touch
 * `opportunity_cases`, so it can be re-run at any time and can never make the history
 * it is auditing worse.
 *
 * `dryRun` computes every correction and the identical census WITHOUT writing. It exists
 * so the pass can be inspected against production before it is applied, and so a reader
 * can confirm the two agree: a dry run whose census differs from the applied run would
 * mean the write changed the finding, which it must never do.
 */
export function runExcursionCorrectionPassOnDb(
  db: ExcursionDb,
  opts: {
    nowMs: number;
    sha?: string | null;
    scope?: "delivered" | "all";
    limit?: number;
    dryRun?: boolean;
  } = { nowMs: Date.now() },
): {
  census: ExcursionCensus;
  recorded: number;
  rows: CanonicalExcursion[];
  corrections: ExcursionCorrection[];
  correctionCensus: ExcursionCorrectionCensus;
  dryRun: boolean;
} {
  const rows = recomputeExcursionsOnDb(db, { scope: opts.scope, limit: opts.limit });
  const dryRun = opts.dryRun === true;
  const corrections: ExcursionCorrection[] = [];
  let recorded = 0;
  for (const e of rows) {
    // Cases that never carried a peak have nothing to correct; writing a row for each
    // would bury the ones that do under thousands that never misled anyone.
    if (e.storedMaxReturnPct == null && !excursionIsPublishable(e.state)) continue;
    const correction = correctionFromExcursion(e, { nowMs: opts.nowMs, sha: opts.sha });
    corrections.push(correction);
    if (dryRun) continue;
    if (persistExcursionCorrectionOnDb(db, correction)) recorded += 1;
  }
  return {
    census: summarizeExcursions(rows),
    recorded,
    rows,
    corrections,
    correctionCensus: summarizeCorrections(corrections),
    dryRun,
  };
}

/**
 * The ONE question every downstream consumer should ask before printing a peak.
 *
 * Returns the canonical value only when the evidence is VERIFIED. Otherwise
 * `maxReturnPct` is null and `state` says why — there is deliberately no path that
 * falls back to the stored legacy value, because the stored legacy value is precisely
 * what published +185.4%.
 */
export function resolvePublishableExcursionOnDb(
  db: ExcursionDb,
  opportunityCaseId: string,
): { maxReturnPct: number | null; maePct: number | null; state: ExcursionEvidenceState; reason: string } {
  const correction = readExcursionCorrectionOnDb(db, opportunityCaseId);
  if (correction && excursionIsPublishable(correction.evidenceState)) {
    return {
      maxReturnPct: correction.correctedMaxReturnPct,
      maePct: correction.correctedMaePct,
      state: correction.evidenceState,
      reason: correction.reason,
    };
  }
  // No correction on file, or one that condemned the value: recompute live rather than
  // trust a stale verdict.
  const live = recomputeExcursionOnDb(db, opportunityCaseId);
  if (excursionIsPublishable(live.state)) {
    return {
      maxReturnPct: live.canonicalMfePct,
      maePct: live.canonicalMaePct,
      state: live.state,
      reason: live.reason,
    };
  }
  return { maxReturnPct: null, maePct: null, state: live.state, reason: live.reason };
}

export function summarizeExcursions(rows: CanonicalExcursion[]): ExcursionCensus {
  const byState: Record<ExcursionEvidenceState, number> = {
    VERIFIED_EXCURSION: 0,
    INSUFFICIENT_MARKS: 0,
    UNSUPPORTED_MAX_RETURN: 0,
    MAX_FLOORED_AT_ZERO: 0,
    NO_MIRROR: 0,
    OCC_IDENTITY_MISSING: 0,
  };
  let wrong = 0;
  for (const r of rows) {
    byState[r.state] += 1;
    if (r.storedValueIsWrong) wrong += 1;
  }
  return {
    examined: rows.length,
    byState,
    storedValuesWrong: wrong,
    publishable: rows.filter((r) => excursionIsPublishable(r.state)).length,
  };
}

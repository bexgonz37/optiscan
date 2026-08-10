/**
 * Trade identity reconciliation — proves, per Opportunity Case, that every number
 * describing the trade's PERFORMANCE was observed on the ONE contract the case
 * froze its entry on.
 *
 * The invariant this enforces:
 *
 *   ONE CASE PERFORMANCE IDENTITY = ONE FROZEN OCC
 *
 * A case legitimately keeps observing other contracts as the thesis lives on — the
 * options loop re-selects a preferred strike/expiration and records each one in
 * `contractCandidates` / `contractUpdates`. Those are ALTERNATE OBSERVATIONS. They
 * are not this trade. A mark taken on a re-selected contract priced against the
 * frozen entry is a different instrument's price divided by this position's cost,
 * which is not a return on anything.
 *
 * Read-only. Zero provider calls, zero quota spend, no send authority. Reports what
 * the persisted rows actually say — including "cannot be proven", which is a real
 * answer and never rounds up to "verified".
 */

export interface IdentityDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[] };
}

function hasTable(db: IdentityDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/** Normalise an OCC for comparison (case/whitespace only — never rewrites a symbol). */
export function normalizeOcc(occ: string | null | undefined): string | null {
  const s = String(occ ?? "").trim().toUpperCase();
  return s.length > 0 ? s : null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Percentage tolerance when checking whether a stored performance number can be
 * reproduced from marks on the frozen contract. Marks are stored rounded, so an
 * exact float match would report false mismatches.
 */
export const RETURN_TOLERANCE_PCT = 0.05;

export type IdentityVerdict =
  /** Every performance number is reproducible from marks on the frozen OCC. */
  | "SAME_OCC_VERIFIED"
  /** A performance number came from, or is only explainable by, a different OCC. */
  | "CROSS_CONTRACT_CONTAMINATION"
  /** The alert / mirror / marks disagree about which contract this trade is. */
  | "OCC_MISMATCH"
  /** Not enough persisted evidence to prove identity either way. Never publishable. */
  | "IDENTITY_UNVERIFIABLE";

/**
 * Precise defect codes.
 *
 * These are deliberately NOT collapsed into one bucket. "The stated peak exceeds
 * anything the frozen contract printed" and "the stated peak is the 0 it was
 * initialised to" both make a case unpublishable, but they are different bugs with
 * different fixes, and reporting the second as cross-contract contamination would be
 * its own false claim.
 */
export type IdentityDefect =
  /** A mark in the series was taken on a contract other than the frozen one. */
  | "CROSS_CONTRACT_MARK"
  /** Performance evidence spans more than one contract. */
  | "MULTI_OCC_PERFORMANCE"
  /** The SENT alert names a different contract than the case froze. */
  | "ALERT_OCC_MISMATCH"
  /** A linked mirror is on a different contract than the case froze. */
  | "MIRROR_OCC_MISMATCH"
  /** Stated peak is positive but above anything the frozen contract ever printed. */
  | "UNSUPPORTED_MAX_RETURN"
  /** Stated peak is the 0 seeded at open while the contract only ever traded down. */
  | "MAX_FLOORED_AT_ZERO"
  /** Stated return is not (stated mark vs frozen entry). */
  | "RETURN_NOT_REPRODUCIBLE"
  | "NO_FROZEN_OCC"
  | "NO_FROZEN_ENTRY"
  | "NO_PERFORMANCE_MIRROR"
  | "CASE_NOT_FOUND";

export interface LinkedPaperTrade {
  tradeId: number;
  optionSymbol: string | null;
  paperKind: string | null;
  entryFill: number | null;
  status: string | null;
  returnPct: number | null;
  storedMfePct: number | null;
  storedMaePct: number | null;
  markCount: number;
  /** Distinct OCCs actually present in this trade's mark series. */
  markOptionSymbols: string[];
  marksOnFrozen: number;
  marksOffFrozen: number;
  /** Best/worst return among marks recorded on the FROZEN contract only. */
  frozenMfePct: number | null;
  frozenMaePct: number | null;
  onFrozenContract: boolean;
}

export interface TradeIdentityReport {
  opportunityCaseId: string;
  symbol: string | null;
  caseFound: boolean;

  /** The one contract this case's entry was frozen on. */
  frozenOptionSymbol: string | null;
  frozenEntry: number | null;
  frozenStrike: number | null;
  frozenExpiration: string | null;

  alertId: string | null;
  alertOptionSymbol: string | null;
  alertEntryMid: number | null;
  alertState: string | null;
  discordMessageId: string | null;

  /** Case summary performance values as currently persisted. */
  caseCurrentMark: number | null;
  caseCurrentReturnPct: number | null;
  caseMaxReturnPct: number | null;
  caseStatus: string | null;

  /** Alternate contracts this case observed. Evidence, never performance. */
  distinctCandidateOccs: string[];
  contractUpdateCount: number;

  linkedPaperTrades: LinkedPaperTrade[];

  /** Can `caseMaxReturnPct` be reproduced from a mark on the frozen contract? */
  maxReturnReproducibleOnFrozen: boolean | null;
  /** Can `caseCurrentReturnPct` be reproduced from a mark on the frozen contract? */
  realizedReturnReproducibleOnFrozen: boolean | null;

  /** Best mark the FROZEN contract actually printed, across linked mirrors. */
  frozenContractBestMarkPct: number | null;
  /** Worst mark the FROZEN contract actually printed, across linked mirrors. */
  frozenContractWorstMarkPct: number | null;

  verdict: IdentityVerdict;
  defects: IdentityDefect[];
  reasons: string[];
  /** True only when a numeric performance claim may be published from this case. */
  publishable: boolean;
}

function distinctCandidateOccsFromCase(c: any): string[] {
  const out = new Set<string>();
  for (const k of (c?.contractCandidates ?? [])) {
    const occ = normalizeOcc(k?.optionSymbol);
    if (occ) out.add(occ);
  }
  for (const u of (c?.contractUpdates ?? [])) {
    for (const occ of [normalizeOcc(u?.previousOptionSymbol), normalizeOcc(u?.newOptionSymbol)]) {
      if (occ) out.add(occ);
    }
  }
  return [...out].sort();
}

function loadCase(db: IdentityDb, opportunityCaseId: string): any | null {
  if (!hasTable(db, "opportunity_cases")) return null;
  try {
    const row = db.prepare("SELECT case_json FROM opportunity_cases WHERE opportunity_id=?")
      .get(opportunityCaseId) as { case_json?: string } | undefined;
    if (!row?.case_json) return null;
    return JSON.parse(row.case_json);
  } catch {
    return null;
  }
}

function loadLinkedPaperTrades(
  db: IdentityDb,
  alertId: string | null,
  frozenOcc: string | null,
): LinkedPaperTrade[] {
  if (!alertId || !hasTable(db, "options_paper_trades")) return [];
  let rows: Record<string, any>[] = [];
  try {
    rows = db.prepare(
      `SELECT id, option_symbol, paper_kind, entry_fill, status, return_pct, mfe_pct, mae_pct
         FROM options_paper_trades WHERE alert_id=? ORDER BY id ASC`,
    ).all(alertId) as Record<string, any>[];
  } catch {
    return [];
  }
  const marksTable = hasTable(db, "options_paper_marks");
  return rows.map((r) => {
    const tradeId = Number(r.id);
    const occ = normalizeOcc(r.option_symbol);
    let markRows: Record<string, any>[] = [];
    if (marksTable) {
      try {
        markRows = db.prepare(
          "SELECT option_symbol, return_pct FROM options_paper_marks WHERE trade_id=?",
        ).all(tradeId) as Record<string, any>[];
      } catch { /* isolated */ }
    }
    const markOccs = new Set<string>();
    let onFrozen = 0;
    let offFrozen = 0;
    let frozenMfe: number | null = null;
    let frozenMae: number | null = null;
    for (const m of markRows) {
      const mo = normalizeOcc(m.option_symbol);
      if (mo) markOccs.add(mo);
      const ret = num(m.return_pct);
      if (frozenOcc != null && mo === frozenOcc) {
        onFrozen += 1;
        if (ret != null) {
          frozenMfe = frozenMfe == null ? ret : Math.max(frozenMfe, ret);
          frozenMae = frozenMae == null ? ret : Math.min(frozenMae, ret);
        }
      } else {
        offFrozen += 1;
      }
    }
    return {
      tradeId,
      optionSymbol: occ,
      paperKind: r.paper_kind == null ? null : String(r.paper_kind),
      entryFill: num(r.entry_fill),
      status: r.status == null ? null : String(r.status),
      returnPct: num(r.return_pct),
      storedMfePct: num(r.mfe_pct),
      storedMaePct: num(r.mae_pct),
      markCount: markRows.length,
      markOptionSymbols: [...markOccs].sort(),
      marksOnFrozen: onFrozen,
      marksOffFrozen: offFrozen,
      frozenMfePct: frozenMfe,
      frozenMaePct: frozenMae,
      onFrozenContract: frozenOcc != null && occ === frozenOcc,
    };
  });
}

/** Reconcile one Opportunity Case against the contract it froze its entry on. */
export function reconcileTradeIdentityOnDb(
  db: IdentityDb,
  opportunityCaseId: string,
): TradeIdentityReport {
  const reasons: string[] = [];
  const defects: IdentityDefect[] = [];
  const flag = (d: IdentityDefect, why: string) => { defects.push(d); reasons.push(why); };
  const c = loadCase(db, opportunityCaseId);

  const base: TradeIdentityReport = {
    opportunityCaseId,
    symbol: c?.underlyingSymbol ?? null,
    caseFound: c != null,
    frozenOptionSymbol: null,
    frozenEntry: null,
    frozenStrike: null,
    frozenExpiration: null,
    alertId: null,
    alertOptionSymbol: null,
    alertEntryMid: null,
    alertState: null,
    discordMessageId: null,
    caseCurrentMark: null,
    caseCurrentReturnPct: null,
    caseMaxReturnPct: null,
    caseStatus: null,
    distinctCandidateOccs: [],
    contractUpdateCount: 0,
    linkedPaperTrades: [],
    maxReturnReproducibleOnFrozen: null,
    realizedReturnReproducibleOnFrozen: null,
    frozenContractBestMarkPct: null,
    frozenContractWorstMarkPct: null,
    verdict: "IDENTITY_UNVERIFIABLE",
    defects,
    reasons,
    publishable: false,
  };

  if (!c) {
    flag("CASE_NOT_FOUND", "opportunity case not found");
    return base;
  }

  const frozenOcc = normalizeOcc(c?.selectedContract?.optionSymbol);
  const frozenEntry = num(c?.frozenTrade?.entryMid) ?? num(c?.summary?.frozenEntry);
  base.frozenOptionSymbol = frozenOcc;
  base.frozenEntry = frozenEntry;
  base.frozenStrike = num(c?.selectedContract?.strike);
  base.frozenExpiration = c?.selectedContract?.expiration ?? null;
  base.caseCurrentMark = num(c?.summary?.currentMark);
  base.caseCurrentReturnPct = num(c?.summary?.currentReturnPct);
  base.caseMaxReturnPct = num(c?.summary?.maxReturnPct);
  base.caseStatus = c?.summary?.currentStatus ?? c?.lifecycleStatus ?? null;
  base.distinctCandidateOccs = distinctCandidateOccsFromCase(c);
  base.contractUpdateCount = (c?.contractUpdates ?? []).length;
  base.alertId = c?.alertId ?? null;

  if (hasTable(db, "options_alerts") && base.alertId) {
    try {
      const a = db.prepare(
        "SELECT option_symbol, entry_mid, state, discord_message_id FROM options_alerts WHERE alert_id=?",
      ).get(base.alertId) as Record<string, any> | undefined;
      if (a) {
        base.alertOptionSymbol = normalizeOcc(a.option_symbol);
        base.alertEntryMid = num(a.entry_mid);
        base.alertState = a.state == null ? null : String(a.state);
        base.discordMessageId = a.discord_message_id == null ? null : String(a.discord_message_id);
      }
    } catch { /* isolated */ }
  }

  base.linkedPaperTrades = loadLinkedPaperTrades(db, base.alertId, frozenOcc);

  // --- identity checks -------------------------------------------------------
  if (!frozenOcc) flag("NO_FROZEN_OCC", "case has no frozen selectedContract.optionSymbol");
  if (frozenEntry == null || !(frozenEntry > 0)) flag("NO_FROZEN_ENTRY", "case has no positive frozen entry");

  if (frozenOcc && base.alertOptionSymbol && base.alertOptionSymbol !== frozenOcc) {
    flag("ALERT_OCC_MISMATCH", `alert OCC ${base.alertOptionSymbol} != frozen OCC ${frozenOcc}`);
  }

  const performanceTrades = base.linkedPaperTrades.filter((t) => t.markCount > 0 || t.returnPct != null);
  for (const t of performanceTrades) {
    if (frozenOcc && t.optionSymbol && t.optionSymbol !== frozenOcc) {
      flag("MIRROR_OCC_MISMATCH", `paper trade ${t.tradeId} is on ${t.optionSymbol}, not frozen OCC ${frozenOcc}`);
    }
    if (t.marksOffFrozen > 0) {
      flag("CROSS_CONTRACT_MARK", `paper trade ${t.tradeId} has ${t.marksOffFrozen} mark(s) off the frozen contract`);
    }
  }
  const distinctPerfOccs = new Set(
    performanceTrades.flatMap((t) => [t.optionSymbol, ...t.markOptionSymbols]).filter((o): o is string => o != null),
  );
  if (distinctPerfOccs.size > 1) {
    flag(
      "MULTI_OCC_PERFORMANCE",
      `performance evidence spans ${distinctPerfOccs.size} contracts: ${[...distinctPerfOccs].sort().join(", ")}`,
    );
  }

  // What the frozen contract ACTUALLY printed, from its own mark series.
  const mfes = performanceTrades.map((t) => t.frozenMfePct).filter((v): v is number => v != null);
  const maes = performanceTrades.map((t) => t.frozenMaePct).filter((v): v is number => v != null);
  const bestFrozenMfe = mfes.length ? Math.max(...mfes) : null;
  base.frozenContractBestMarkPct = bestFrozenMfe;
  base.frozenContractWorstMarkPct = maes.length ? Math.min(...maes) : null;

  if (base.caseMaxReturnPct == null) {
    base.maxReturnReproducibleOnFrozen = null;
  } else if (bestFrozenMfe == null) {
    base.maxReturnReproducibleOnFrozen = false;
    if (base.caseMaxReturnPct !== 0) {
      flag(
        "UNSUPPORTED_MAX_RETURN",
        `case maxReturnPct ${base.caseMaxReturnPct} has no supporting mark on the frozen contract`,
      );
    }
  } else if (base.caseMaxReturnPct <= bestFrozenMfe + RETURN_TOLERANCE_PCT) {
    // A stored max BELOW the observed best is fine: marking may have started late.
    base.maxReturnReproducibleOnFrozen = true;
  } else if (base.caseMaxReturnPct === 0) {
    // The summary seeds maxReturnPct at 0 when the case opens, and a trade that only
    // ever traded down never raises it. The 0 is an initialisation artifact, not an
    // observed peak — it silently floors every loser's excursion at break-even. That
    // is a real defect, but it is NOT a contract-identity problem, and calling it one
    // would be its own false claim.
    base.maxReturnReproducibleOnFrozen = false;
    flag(
      "MAX_FLOORED_AT_ZERO",
      `case maxReturnPct is the 0 seeded at open; the frozen contract's best mark was ${bestFrozenMfe}`,
    );
  } else {
    base.maxReturnReproducibleOnFrozen = false;
    flag(
      "UNSUPPORTED_MAX_RETURN",
      `case maxReturnPct ${base.caseMaxReturnPct} exceeds the frozen contract's best mark ${bestFrozenMfe}`,
    );
  }

  if (base.caseCurrentReturnPct == null) {
    base.realizedReturnReproducibleOnFrozen = null;
  } else if (frozenEntry != null && frozenEntry > 0 && base.caseCurrentMark != null) {
    const recomputed = ((base.caseCurrentMark - frozenEntry) / frozenEntry) * 100;
    const ok = Math.abs(recomputed - base.caseCurrentReturnPct) <= RETURN_TOLERANCE_PCT;
    base.realizedReturnReproducibleOnFrozen = ok;
    if (!ok) {
      flag(
        "RETURN_NOT_REPRODUCIBLE",
        `case return ${base.caseCurrentReturnPct}% does not equal (mark ${base.caseCurrentMark} vs entry ${frozenEntry})`,
      );
    }
  } else {
    base.realizedReturnReproducibleOnFrozen = null;
  }

  // --- verdict ---------------------------------------------------------------
  const has = (d: IdentityDefect) => defects.includes(d);
  const crossContract = has("CROSS_CONTRACT_MARK") || has("MULTI_OCC_PERFORMANCE")
    || has("UNSUPPORTED_MAX_RETURN") || has("RETURN_NOT_REPRODUCIBLE");
  const mismatch = has("ALERT_OCC_MISMATCH") || has("MIRROR_OCC_MISMATCH");

  if (!frozenOcc || frozenEntry == null || !(frozenEntry > 0)) {
    base.verdict = "IDENTITY_UNVERIFIABLE";
  } else if (performanceTrades.length === 0) {
    flag("NO_PERFORMANCE_MIRROR", "no linked paper mirror carries marks or a realized return");
    base.verdict = "IDENTITY_UNVERIFIABLE";
  } else if (crossContract) {
    base.verdict = "CROSS_CONTRACT_CONTAMINATION";
  } else if (mismatch) {
    base.verdict = "OCC_MISMATCH";
  } else if (has("MAX_FLOORED_AT_ZERO")) {
    // Identity is sound; the peak is simply not an observation. The realized return
    // is still same-OCC, so this is unverifiable-for-peak rather than contaminated.
    base.verdict = "IDENTITY_UNVERIFIABLE";
  } else {
    base.verdict = "SAME_OCC_VERIFIED";
  }

  base.publishable = base.verdict === "SAME_OCC_VERIFIED";
  return base;
}

/**
 * Which cases to reconcile.
 *
 * `delivered` is the default and the population that matters: a case only reaches
 * marketing copy, the nightly AI, or strategy grading once it was delivered. The
 * scanner creates thousands of undelivered candidate cases a day, so scanning "recent
 * cases" by detection time drowns the delivered handful and reports a clean audit of
 * rows that never carried a number.
 */
export type IdentityScope = "delivered" | "all";

/** Reconcile every case that has produced content, or a recent window of cases. */
export function reconcileRecentTradeIdentitiesOnDb(
  db: IdentityDb,
  opts: {
    sinceMs?: number | null;
    limit?: number;
    caseIds?: string[];
    scope?: IdentityScope;
  } = {},
): TradeIdentityReport[] {
  if (opts.caseIds?.length) {
    return opts.caseIds.map((id) => reconcileTradeIdentityOnDb(db, id));
  }
  if (!hasTable(db, "opportunity_cases")) return [];
  const limit = Math.max(1, Math.min(2000, opts.limit ?? 200));
  const scope: IdentityScope = opts.scope ?? "delivered";
  const where: string[] = [];
  const args: unknown[] = [];
  if (scope === "delivered") where.push("delivery_decision='delivered'");
  if (opts.sinceMs != null) { where.push("detected_at_ms >= ?"); args.push(opts.sinceMs); }
  args.push(limit);
  let rows: { opportunity_id: string }[] = [];
  try {
    rows = db.prepare(
      `SELECT opportunity_id FROM opportunity_cases
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY detected_at_ms DESC LIMIT ?`,
    ).all(...args) as { opportunity_id: string }[];
  } catch {
    return [];
  }
  return rows.map((r) => reconcileTradeIdentityOnDb(db, String(r.opportunity_id)));
}

export interface IdentitySummary {
  examined: number;
  /** Cases that actually state a return or a peak — the ones able to mislead. */
  carryingPerformance: number;
  byVerdict: Record<IdentityVerdict, number>;
  byDefect: Partial<Record<IdentityDefect, number>>;
  publishable: number;
  contaminated: string[];
}

/**
 * Defects that break the REALIZED return specifically.
 *
 * The excursion defects are deliberately absent. `UNSUPPORTED_MAX_RETURN` and
 * `MAX_FLOORED_AT_ZERO` are both properties of `summary.maxReturnPct` — a value the
 * summary ratchets separately — and neither touches the realized identity, which is
 * (last mark on the frozen contract) vs (frozen entry). All 78 delivered cases
 * reproduce their realized return on the frozen contract, including every one of the
 * 36 carrying an inflated peak.
 *
 * Treating a bad peak as a bad trade would throw away 56 sound realized outcomes to
 * avoid one unsound number, which is its own way of misreporting the record.
 */
const REALIZED_BLOCKING_DEFECTS: IdentityDefect[] = [
  "CROSS_CONTRACT_MARK",
  "MULTI_OCC_PERFORMANCE",
  "ALERT_OCC_MISMATCH",
  "MIRROR_OCC_MISMATCH",
  "RETURN_NOT_REPRODUCIBLE",
  "NO_FROZEN_OCC",
  "NO_FROZEN_ENTRY",
  "NO_PERFORMANCE_MIRROR",
  "CASE_NOT_FOUND",
];

/**
 * May this case's REALIZED return be quoted?
 *
 * Separate from `publishable`, which is the stricter "everything about this case
 * reconciles" answer. A trade can have a perfectly sound realized return and an
 * unusable MFE, and a consumer that cannot express that difference will either
 * publish a false peak or suppress a true return.
 */
export function realizedReturnIsPublishable(r: TradeIdentityReport): boolean {
  if (r.realizedReturnReproducibleOnFrozen === false) return false;
  return !r.defects.some((d) => REALIZED_BLOCKING_DEFECTS.includes(d));
}

export function summarizeTradeIdentities(reports: TradeIdentityReport[]): IdentitySummary {
  const byVerdict: Record<IdentityVerdict, number> = {
    SAME_OCC_VERIFIED: 0,
    CROSS_CONTRACT_CONTAMINATION: 0,
    OCC_MISMATCH: 0,
    IDENTITY_UNVERIFIABLE: 0,
  };
  const byDefect: Partial<Record<IdentityDefect, number>> = {};
  const contaminated: string[] = [];
  let carryingPerformance = 0;
  for (const r of reports) {
    byVerdict[r.verdict] += 1;
    for (const d of new Set(r.defects)) byDefect[d] = (byDefect[d] ?? 0) + 1;
    if (r.caseMaxReturnPct != null || r.caseCurrentReturnPct != null) carryingPerformance += 1;
    if (r.verdict === "CROSS_CONTRACT_CONTAMINATION" || r.verdict === "OCC_MISMATCH") {
      contaminated.push(r.opportunityCaseId);
    }
  }
  return {
    examined: reports.length,
    carryingPerformance,
    byVerdict,
    byDefect,
    publishable: reports.filter((r) => r.publishable).length,
    contaminated,
  };
}

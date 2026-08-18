/**
 * cohort-probability.ts — HISTORICAL_COHORT_V1. Deterministic empirical statistics over
 * the LOCAL record, in shadow.
 *
 * This module exists to make one refusal cheap and automatic:
 *
 *     AI CONFIDENCE IS NOT A PROBABILITY, AND NEITHER IS A SMALL SAMPLE.
 *
 * Every figure is a count divided by a count, over rows this system can prove it
 * observed. Nothing is modelled, smoothed, fitted or extrapolated. When the evidence
 * cannot support a figure the answer is INSUFFICIENT_EVIDENCE with the reason attached —
 * never a number with a caveat next to it, because the number gets quoted and the caveat
 * does not.
 *
 * ── Two admission rules, and they are different on purpose ────────────────────
 *
 * MFE/MAE and milestone probabilities require VERIFIED_EXCURSION. They are claims about
 * every moment of the hold, and a trade marked twice cannot support one.
 *
 * Realized return, expectancy and profit factor require only a VERIFIED REALIZED
 * outcome: a closed mirror on the frozen contract with a return priced against the
 * frozen entry. That is ONE observation and it stands on its own. Demanding a verified
 * excursion for it would throw away realized outcomes that reconcile perfectly — the
 * mistake the content gate originally made in the other direction.
 *
 * ── Independent sessions ──────────────────────────────────────────────────────
 *
 * Twenty trades from one morning are one observation of one market, not twenty
 * observations. Sessions are counted and gated separately from trades, and a cohort that
 * fails the session floor is INSUFFICIENT_EVIDENCE however many rows it has.
 *
 * SHADOW ONLY. Nothing here is read by a gate, a threshold, a ranking weight, a stop, an
 * exit, or any subscriber decision.
 */
import { excursionForPaperTradeOnDb } from "../../opportunity-case/excursion.ts";
import { countIndependentSessions, type IndependentSessionCount } from "../historical/trading-sessions.ts";
import { tradingDay } from "../../trading-session.ts";

export const HISTORICAL_COHORT_VERSION = "HISTORICAL_COHORT_V1" as const;

export interface CohortDb {
  prepare(sql: string): { get?: (...a: any[]) => any; all?: (...a: any[]) => any[] };
}

/**
 * Sample floors. These are honesty floors, not statistical results.
 *
 * `MIN_TRADES` and `MIN_SESSIONS` are both required because they fail for different
 * reasons: too few trades is too little data, too few sessions is too little
 * INDEPENDENCE, and a cohort can pass either one while badly failing the other.
 */
export const MIN_TRADES_FOR_PROBABILITY = 20;
export const MIN_SESSIONS_FOR_PROBABILITY = 5;

export const MILESTONES = [10, 25, 50, 100] as const;

/** The dimensions a cohort may be cut on. Every one is knowable BEFORE entry. */
export interface CohortKey {
  /**
   * THE LANE. `paper_kind` on the mirror: DELIVERED_ALERT_PAPER,
   * OWNER_VALIDATION_PAPER, RESEARCH_ONLY_PAPER, ZERO_DTE_RESEARCH_PAPER.
   *
   * Listed first because omitting it is the most expensive mistake this module can
   * make. The lanes are disjoint populations with different gates, different audiences
   * and different selection rules; a pooled expectancy over all four describes a
   * population that has never existed and cannot be traded. A cohort built without
   * this key is marked `pooledAcrossLanes` and says so in its own limitations.
   */
  paperKind?: string | null;
  strategyKey?: string | null;
  side?: "CALL" | "PUT" | null;
  regime?: string | null;
  timeOfDayBucket?: string | null;
  dteBucket?: string | null;
  moneynessBucket?: string | null;
  discoveryStage?: string | null;
}

export interface CohortMember {
  opportunityCaseId: string;
  tradeId: number;
  /** The lane this trade belongs to. Never blended with another. */
  paperKind: string | null;
  sessionDate: string | null;
  /**
   * Where the session date came from.
   *
   * CASE   — the opportunity case's own `session_date`, joined through `alert_id`.
   * MIRROR_ENTRY — derived from the mirror's `entered_at_ms` in Eastern time, which is
   *          the only session a trade can belong to and the only source available to a
   *          lane that carries no alert id.
   */
  sessionDateSource: "CASE" | "MIRROR_ENTRY" | "UNAVAILABLE";
  symbol: string | null;
  optionSymbol: string | null;
  strategyKey: string | null;
  side: "CALL" | "PUT" | null;
  dte: number | null;
  discoveryStage: string | null;
  /** Closed on the frozen contract, priced against the frozen entry. */
  realizedReturnPct: number | null;
  realizedVerified: boolean;
  /** Only from VERIFIED_EXCURSION. Null otherwise — never 0. */
  mfePct: number | null;
  maePct: number | null;
  excursionVerified: boolean;
  marksOnContract: number;
}

export type EvidenceVerdict = "SUPPORTED" | "INSUFFICIENT_EVIDENCE";

export interface EvidenceStrength {
  verdict: EvidenceVerdict;
  trades: number;
  /** VERIFIED trading sessions. A weekend or a holiday never counts toward this. */
  independentSessions: number;
  minTrades: number;
  minSessions: number;
  /** Which dates counted, which were rejected, and why. Reported, never silent. */
  sessionAudit: IndependentSessionCount;
  reason: string;
}

export interface MilestoneProbability {
  milestone: number;
  reached: number;
  of: number;
  /** Null unless the excursion sample clears BOTH floors. */
  probability: number | null;
  verdict: EvidenceVerdict;
}

export interface CohortStatistics {
  version: typeof HISTORICAL_COHORT_VERSION;
  cohortId: string;
  key: CohortKey;
  dateRange: { from: string | null; to: string | null };
  sessions: string[];

  /** Sample admitted for TRAJECTORY claims — VERIFIED_EXCURSION only. */
  excursionSample: EvidenceStrength;
  /** Sample admitted for REALIZED claims — verified closed outcomes. */
  realizedSample: EvidenceStrength;

  /**
   * True when the cohort spans more than one paper lane.
   *
   * Not an error, but never a tradeable figure: a pooled expectancy over delivered
   * alerts, owner validation, shadow research and 0DTE research describes a population
   * that has never existed. Surfaced as a field rather than a footnote so a consumer
   * must handle it.
   */
  pooledAcrossLanes: boolean;
  lanesIncluded: string[];

  milestoneProbabilities: MilestoneProbability[];
  expectedMfePct: number | null;
  expectedMaePct: number | null;

  expectedRealizedReturnPct: number | null;
  medianRealizedReturnPct: number | null;
  profitFactor: number | null;
  avgWinnerPct: number | null;
  avgLoserPct: number | null;
  winRate: number | null;
  /** Share of realized outcomes at or above +100%. The tail the lane rides. */
  tailFrequency: number | null;
  /** Profit factor with the single best winner removed. Tail-dependence check. */
  profitFactorWithoutTopWinner: number | null;

  entryConvention: string;
  exitConvention: string;
  memberCaseIds: string[];
  limitations: string[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

function hasTable(db: CohortDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name));
  } catch { return false; }
}

const num = (v: unknown): number | null => {
  const x = Number(v);
  return v == null || v === "" || !Number.isFinite(x) ? null : x;
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? +s[m].toFixed(4) : +(((s[m - 1] + s[m]) / 2).toFixed(4));
}

const mean = (xs: number[]): number | null =>
  xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4) : null;

export function dteBucketOf(dte: number | null): string | null {
  if (dte == null) return null;
  if (dte <= 0) return "0DTE";
  if (dte <= 2) return "1-2DTE";
  if (dte <= 7) return "3-7DTE";
  if (dte <= 21) return "8-21DTE";
  return "22DTE+";
}

export function moneynessBucketOf(pct: number | null): string | null {
  if (pct == null) return null;
  const a = Math.abs(pct);
  if (a <= 1) return "ATM";
  if (a <= 3) return "NEAR";
  if (a <= 7) return "OTM";
  return "FAR_OTM";
}

export function timeOfDayBucketOf(atMs: number | null): string | null {
  if (atMs == null) return null;
  // Eastern market hours, derived from the instant rather than a stored label so a row
  // written by any lane buckets the same way.
  const et = new Date(atMs).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
  const [h, m] = et.split(":").map(Number);
  if (!Number.isFinite(h)) return null;
  const mins = h * 60 + m;
  if (mins < 9 * 60 + 30) return "PREMARKET";
  if (mins < 10 * 60) return "OPEN_30";
  if (mins < 12 * 60) return "MORNING";
  if (mins < 14 * 60) return "MIDDAY";
  if (mins < 15 * 60 + 30) return "AFTERNOON";
  if (mins <= 16 * 60) return "POWER_HOUR";
  return "AFTERHOURS";
}

/**
 * Independence, counted against the trading calendar rather than the string set.
 *
 * `new Set(sessionDate).size` was the old count, and a calendar date is not a trading
 * session: a weekend, a market holiday or a corrupt epoch produces a well-formed
 * `YYYY-MM-DD` that clears an independence floor unchallenged. `countIndependentSessions`
 * validates each date and REPORTS what it rejected — "your floor of 5 was cleared using a
 * Saturday" is the most useful thing this count can say.
 */
function strength(
  trades: number,
  sessionDates: ReadonlyArray<string | null>,
  what: string,
): EvidenceStrength {
  const audit = countIndependentSessions(sessionDates);
  const sessions = audit.independentSessions;
  const ok = trades >= MIN_TRADES_FOR_PROBABILITY && sessions >= MIN_SESSIONS_FOR_PROBABILITY;
  return {
    verdict: ok ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE",
    trades,
    independentSessions: sessions,
    minTrades: MIN_TRADES_FOR_PROBABILITY,
    minSessions: MIN_SESSIONS_FOR_PROBABILITY,
    sessionAudit: audit,
    reason: ok
      ? `${trades} ${what} over ${sessions} independent sessions`
      : `needs >= ${MIN_TRADES_FOR_PROBABILITY} ${what} over >= ${MIN_SESSIONS_FOR_PROBABILITY} sessions; `
        + `has ${trades} over ${sessions}`,
  };
}

/** A stable id for the cut, so a cohort's membership can be re-derived and compared. */
export function cohortIdFor(key: CohortKey): string {
  const parts = Object.entries(key)
    .filter(([, v]) => v != null && v !== "")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`);
  return `${HISTORICAL_COHORT_VERSION}:${parts.length ? parts.join("|") : "ALL"}`;
}

// ── membership ───────────────────────────────────────────────────────────────

/**
 * Every locally-trustworthy trade, with its evidence states resolved.
 *
 * The population is `options_paper_trades` joined to its case — a mirror is the only
 * object that carries BOTH an identity (the frozen OCC) and an outcome. Cases with no
 * mirror produce no member: there is nothing to measure, and admitting them with nulls
 * would inflate every denominator with rows that were never observed.
 */
export function loadCohortMembersOnDb(
  db: CohortDb,
  opts: { sinceMs?: number | null; limit?: number } = {},
): CohortMember[] {
  if (!hasTable(db, "options_paper_trades")) return [];
  const limit = Math.max(1, Math.min(20_000, opts.limit ?? 5000));
  let rows: Record<string, any>[] = [];
  try {
    const where = opts.sinceMs != null ? "WHERE t.created_at_ms >= ?" : "";
    const params = opts.sinceMs != null ? [opts.sinceMs, limit] : [limit];
    // The `alert_id` join is the SUBSCRIBER lane's link and stays exactly as it was.
    // It is a LEFT join for a reason that used to be invisible: an owner mirror has no
    // alert id — owner callouts never write an `options_alerts` row — so every owner row
    // came back with a null case, a null symbol and, fatally, a null `session_date`.
    // A null session date is not a missing label; it is an independence count of ZERO,
    // and the owner lane sat permanently at INSUFFICIENT_EVIDENCE with 74 verified
    // excursions and 67 verified realized outcomes behind it.
    rows = (db.prepare(
      `SELECT t.id, t.option_symbol, t.side, t.dte, t.status, t.return_pct, t.entry_fill,
              t.strategy, t.paper_kind, t.alert_id, t.created_at_ms, t.entered_at_ms, t.underlying_price, t.strike,
              t.feature_snapshot_json,
              c.opportunity_id, c.underlying_symbol, c.session_date,
              p.discovery_stage
         FROM options_paper_trades t
         LEFT JOIN opportunity_cases c ON c.alert_id = t.alert_id
         LEFT JOIN opportunity_pre_move_discovery p ON p.opportunity_case_id = c.opportunity_id
         ${where}
        ORDER BY t.created_at_ms DESC LIMIT ?`,
    ).all?.(...params) ?? []) as Record<string, any>[];
  } catch {
    return [];
  }

  // Case identity for the lanes that record it on the mirror itself rather than through
  // an alert. Resolved once per case id, not once per row.
  const caseFactsCache = new Map<string, { symbol: string | null; sessionDate: string | null; stage: string | null } | null>();
  const caseFacts = (caseId: string) => {
    if (caseFactsCache.has(caseId)) return caseFactsCache.get(caseId) ?? null;
    let v: { symbol: string | null; sessionDate: string | null; stage: string | null } | null = null;
    try {
      const row = db.prepare(
        "SELECT underlying_symbol, session_date FROM opportunity_cases WHERE opportunity_id=?",
      ).get?.(caseId) as Record<string, any> | undefined;
      if (row) {
        let stage: string | null = null;
        try {
          const pm = db.prepare(
            "SELECT discovery_stage FROM opportunity_pre_move_discovery WHERE opportunity_case_id=?",
          ).get?.(caseId) as Record<string, any> | undefined;
          stage = pm?.discovery_stage == null ? null : String(pm.discovery_stage);
        } catch { /* isolated */ }
        v = {
          symbol: row.underlying_symbol == null ? null : String(row.underlying_symbol),
          sessionDate: row.session_date == null ? null : String(row.session_date),
          stage,
        };
      }
    } catch { /* isolated */ }
    caseFactsCache.set(caseId, v);
    return v;
  };

  const out: CohortMember[] = [];
  for (const r of rows) {
    const tradeId = Number(r.id);
    if (!Number.isFinite(tradeId)) continue;
    const occ = r.option_symbol == null ? null : String(r.option_symbol);
    const excursion = excursionForPaperTradeOnDb(db as any, tradeId, occ);
    const closed = String(r.status ?? "") === "EXITED";
    const realized = num(r.return_pct);
    // A realized return is verified only when the mirror CLOSED and priced its exit
    // against the frozen entry. An open trade's absent return is "not yet".
    const realizedVerified = closed && realized != null && num(r.entry_fill) != null;

    // Identity, in order of strength: the case the alert join found, then the case the
    // mirror recorded on itself. Nothing is invented when neither exists.
    let caseId = r.opportunity_id == null ? "" : String(r.opportunity_id);
    let symbol = r.underlying_symbol == null ? null : String(r.underlying_symbol);
    let sessionDate = r.session_date == null ? null : String(r.session_date);
    let sessionDateSource: CohortMember["sessionDateSource"] = sessionDate ? "CASE" : "UNAVAILABLE";
    let stage = r.discovery_stage == null ? null : String(r.discovery_stage);

    if (!caseId) {
      const snapCaseId = caseIdFromSnapshot(r.feature_snapshot_json);
      if (snapCaseId) {
        caseId = snapCaseId;
        const f = caseFacts(snapCaseId);
        if (f) {
          symbol = symbol ?? f.symbol;
          if (!sessionDate && f.sessionDate) { sessionDate = f.sessionDate; sessionDateSource = "CASE"; }
          stage = stage ?? f.stage;
        }
      }
    }

    // A trade's session is the session it was ENTERED in. That is knowable from the
    // mirror alone and needs no case at all, so it is the floor under every lane rather
    // than a special case for one. Converted with the repository's Eastern trading-day
    // helper — never by splitting a UTC ISO string, which moves every post-20:00 ET
    // entry into the next day.
    const enteredAtMs = num(r.entered_at_ms);
    if (!sessionDate && enteredAtMs != null) {
      sessionDate = tradingDay(enteredAtMs);
      sessionDateSource = "MIRROR_ENTRY";
    }
    if (!symbol && occ) symbol = occUnderlying(occ);

    out.push({
      opportunityCaseId: caseId,
      tradeId,
      sessionDate,
      sessionDateSource,
      symbol,
      optionSymbol: occ,
      paperKind: r.paper_kind == null ? null : String(r.paper_kind),
      strategyKey: r.strategy == null ? null : String(r.strategy),
      side: r.side == null ? null : (String(r.side).toUpperCase() === "PUT" ? "PUT" : "CALL"),
      dte: num(r.dte),
      discoveryStage: stage,
      realizedReturnPct: realizedVerified ? realized : null,
      realizedVerified,
      mfePct: excursion.state === "VERIFIED_EXCURSION" ? excursion.mfePct : null,
      maePct: excursion.state === "VERIFIED_EXCURSION" ? excursion.maePct : null,
      excursionVerified: excursion.state === "VERIFIED_EXCURSION",
      marksOnContract: excursion.marksOnContract,
    });
  }
  return out;
}

/** The opportunity case a mirror recorded on itself, or null. Exact, never a substring. */
function caseIdFromSnapshot(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.includes("opportunityCaseId")) return null;
  try {
    const v = JSON.parse(raw);
    const id = v && typeof v === "object" ? (v as Record<string, unknown>).opportunityCaseId : null;
    const s = id == null ? "" : String(id).trim();
    return s.length ? s : null;
  } catch {
    return null;
  }
}

/** `O:IWM260819P00301000` -> `IWM`. Identity only; never used to price anything. */
function occUnderlying(occ: string): string | null {
  const m = /^O:([A-Z]+)\d{6}[CP]\d{8}$/.exec(occ.trim().toUpperCase());
  return m ? m[1] : null;
}

/**
 * Narrow a population to a cohort.
 *
 * A null in the key means "do not cut on this", NOT "match rows whose value is null".
 * The distinction matters: treating null as a filter value would silently build a cohort
 * of rows whose data is MISSING and report it as a cohort of rows that share a property.
 */
export function selectCohort(members: readonly CohortMember[], key: CohortKey): CohortMember[] {
  return members.filter((m) => {
    if (key.paperKind != null && m.paperKind !== key.paperKind) return false;
    if (key.strategyKey != null && m.strategyKey !== key.strategyKey) return false;
    if (key.side != null && m.side !== key.side) return false;
    if (key.dteBucket != null && dteBucketOf(m.dte) !== key.dteBucket) return false;
    if (key.discoveryStage != null && m.discoveryStage !== key.discoveryStage) return false;
    return true;
  });
}

// ── statistics ───────────────────────────────────────────────────────────────

export function computeCohortStatistics(
  members: readonly CohortMember[],
  key: CohortKey,
): CohortStatistics {
  const sessions = countIndependentSessions(members.map((m) => m.sessionDate)).sessions;
  const lanesIncluded = [...new Set(members.map((m) => m.paperKind ?? "UNCLASSIFIED"))].sort();
  const pooledAcrossLanes = lanesIncluded.length > 1;

  const excursionRows = members.filter((m) => m.excursionVerified && m.mfePct != null);
  const excursionSample = strength(excursionRows.length, excursionRows.map((m) => m.sessionDate), "verified excursions");

  const realizedRows = members.filter((m) => m.realizedVerified && m.realizedReturnPct != null);
  const realizedSample = strength(realizedRows.length, realizedRows.map((m) => m.sessionDate), "verified realized outcomes");

  // Milestone probabilities. The counts are reported even when the sample is too small —
  // "3 of 4 reached +25%" is a true statement about four trades — but `probability` stays
  // null so nothing downstream can read a rate off four observations.
  const milestoneProbabilities: MilestoneProbability[] = MILESTONES.map((m) => {
    const reached = excursionRows.filter((r) => (r.mfePct as number) >= m).length;
    return {
      milestone: m,
      reached,
      of: excursionRows.length,
      probability: excursionSample.verdict === "SUPPORTED" && excursionRows.length
        ? +(reached / excursionRows.length).toFixed(4)
        : null,
      verdict: excursionSample.verdict,
    };
  });

  const supported = <T>(s: EvidenceStrength, v: T): T | null =>
    s.verdict === "SUPPORTED" ? v : null;

  const returns = realizedRows.map((r) => r.realizedReturnPct as number);
  const winners = returns.filter((r) => r > 0);
  const losers = returns.filter((r) => r <= 0);
  const grossWin = winners.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losers.reduce((a, b) => a + b, 0));

  const pf = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(4) : null;
  // Tail dependence: the delivered lane is known to ride a convex tail, so a profit
  // factor that collapses without its single best winner is a different claim from one
  // that survives. Reported beside PF rather than instead of it.
  const withoutTop = (() => {
    // One winner is not too few to answer this — it is the STARKEST answer. A cohort
    // carried entirely by a single trade reports 0 here, and 0 is the finding. Guarding
    // on `winners.length < 2` returned null for exactly the case the metric exists to
    // expose, so the most tail-dependent cohorts looked like the ones with no data.
    if (!winners.length || grossLoss <= 0) return null;
    const top = Math.max(...winners);
    return +(((grossWin - top) / grossLoss)).toFixed(4);
  })();

  return {
    version: HISTORICAL_COHORT_VERSION,
    cohortId: cohortIdFor(key),
    key,
    dateRange: { from: sessions[0] ?? null, to: sessions[sessions.length - 1] ?? null },
    sessions,
    excursionSample,
    realizedSample,
    pooledAcrossLanes,
    lanesIncluded,
    milestoneProbabilities,
    expectedMfePct: supported(excursionSample, mean(excursionRows.map((r) => r.mfePct as number))),
    expectedMaePct: supported(excursionSample, mean(excursionRows.filter((r) => r.maePct != null).map((r) => r.maePct as number))),
    expectedRealizedReturnPct: supported(realizedSample, mean(returns)),
    medianRealizedReturnPct: supported(realizedSample, median(returns)),
    profitFactor: supported(realizedSample, pf),
    avgWinnerPct: supported(realizedSample, mean(winners)),
    avgLoserPct: supported(realizedSample, mean(losers)),
    winRate: supported(realizedSample, returns.length ? +(winners.length / returns.length).toFixed(4) : null),
    tailFrequency: supported(realizedSample, returns.length ? +(returns.filter((r) => r >= 100).length / returns.length).toFixed(4) : null),
    profitFactorWithoutTopWinner: supported(realizedSample, withoutTop),
    entryConvention: "frozen entry: the mid quoted at alert time on the frozen OCC, never a later or improved fill",
    exitConvention: "realized: the closing exit fill on the SAME OCC. Excursion: best/worst same-contract mark.",
    memberCaseIds: members.map((m) => m.opportunityCaseId).filter(Boolean),
    limitations: [
      ...(pooledAcrossLanes
        ? [
          `POOLED ACROSS ${lanesIncluded.length} LANES (${lanesIncluded.join(", ")}). These are disjoint `
          + "populations with different gates, audiences and selection rules. This expectancy describes a "
          + "population that has never existed and must NOT be quoted as the system's performance. Pass "
          + "paperKind to get a figure that means something.",
        ]
        : [`Single lane: ${lanesIncluded[0] ?? "none"}.`]),
      "SHADOW ONLY. No gate, threshold, ranking weight, stop, exit or subscriber decision reads any of this.",
      "Trajectory figures admit VERIFIED_EXCURSION rows only; realized figures admit verified closed outcomes only. The two samples differ and are reported separately.",
      "A null figure means the sample did not clear the floors. It never means zero.",
      "Counts are reported even when a rate is withheld, so a reader can see the raw evidence without being handed a rate it cannot support.",
      "Local record only. Provider entitlement to deeper history is not possession — see /api/diagnostics/data-truth.",
    ],
  };
}

export function buildCohortStatisticsOnDb(
  db: CohortDb,
  key: CohortKey,
  opts: { sinceMs?: number | null; limit?: number } = {},
): CohortStatistics {
  const all = loadCohortMembersOnDb(db, opts);
  return computeCohortStatistics(selectCohort(all, key), key);
}

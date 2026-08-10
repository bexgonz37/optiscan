/**
 * realized-outcomes.ts — HIST_REALIZED_V1. What the governing policy ACTUALLY captured.
 *
 * ── Two questions that are not the same question ─────────────────────────────
 *
 *     EXCURSION:  "How often did these setups run?"
 *     REALIZED:   "How profitable was the policy that traded them?"
 *
 * A winner event answers the first. It knows the highest and lowest the contract printed
 * after an executable entry, and when each milestone was first touched. It does NOT know
 * where the position was closed, because closing is a decision the exit policy made and
 * an excursion is a fact about the tape.
 *
 * Those two populations have different sizes, different denominators, and different
 * verdicts, and the single most destructive thing this module could do is let them merge.
 * A profit factor computed from MFE is the number that made a losing lane look like a
 * winner: every trade reported at its best moment, an equity curve no account produced.
 * So MFE is never a fallback for a realized return here. There is no code path from one to
 * the other, and `UNAVAILABLE` is always preferred to an inference.
 *
 * ── Identity must be PROVEN, not guessed ─────────────────────────────────────
 *
 * A join is accepted only when all three of these agree:
 *
 *   1. the exact OCC matches — same contract, character for character
 *   2. the paper trade belongs to the SAME opportunity case
 *   3. the paper entry instant is at or after the event's entry instant, close enough to be
 *      the same decision rather than a later re-entry on the same contract
 *
 * Rule 2 is the one that is tempting to drop, and dropping it is how a realized return
 * gets attached to the wrong decision: one liquid contract can be selected by several
 * cases across a week, and an OCC-only join would pick whichever row came back first.
 * Together the three are unique — a case links to one alert, an alert to its mirrors.
 *
 * ── Why the entry PRICE is not an identity rule ──────────────────────────────
 *
 * It was one, at a two-cent tolerance, and it refused 12 of 21 real joins. Every refusal
 * was the same shape: the historical NBBO ask at the detection instant against the live
 * fill the mirror actually recorded, differing by a nickel. Those are two MEASUREMENTS of
 * one trade taken from different sources minutes apart, not two different trades — and on
 * a 0DTE contract inside the entry window the premium is expected to move, so any price
 * bound is arbitrary in both directions.
 *
 * It also could not have earned its cost. The realized return is computed from the paper
 * mirror's OWN entry and exit fills, which are internally consistent whatever the
 * historical ask said. Disagreement between the two sources cannot make that return wrong.
 * So the comparison is kept and REPORTED as corroboration — it is a genuine measure of
 * cross-source price agreement, and a cohort where most rows disagree materially is worth
 * seeing — but it no longer discards valid outcomes.
 *
 * Every refusal is reported with its reason. A join that cannot be proven is evidence
 * about our records, not about the trade, and it is counted separately.
 *
 * SHADOW / RESEARCH ONLY. Nothing here is read by a gate, threshold, ranking weight,
 * stop, exit or subscriber decision.
 */
import type { StoreDb } from "./store.ts";
import { countIndependentSessions, type IndependentSessionCount } from "./trading-sessions.ts";
import type { WinnerEvent } from "./winner-events.ts";

export const REALIZED_OUTCOME_VERSION = "HIST_REALIZED_V1" as const;

/**
 * Below this the two sources are treated as agreeing on the entry price.
 *
 * Corroboration only — a wider gap annotates the row, it does not refuse the join. See the
 * header for why this stopped being an identity rule.
 */
export const ENTRY_MATCH_TOLERANCE = 0.02;
/** A paper entry this far after the event's entry instant is a different decision. */
export const ENTRY_TIME_TOLERANCE_MS = 15 * 60_000;

export type RealizedState = "WIN" | "LOSS" | "OPEN" | "UNAVAILABLE";

export type RealizedRefusal =
  | "NO_CASE_ID_ON_EVENT"
  | "NO_PAPER_TRADE_FOR_CASE"
  | "OCC_MISMATCH"
  | "ENTRY_TIME_MISMATCH"
  | "NO_ENTRY_FILL_RECORDED"
  | "CLOSED_WITHOUT_EXIT_FILL"
  | "AMBIGUOUS_MULTIPLE_MATCHES"
  | "PAPER_TABLE_ABSENT";

/**
 * How well the historical NBBO ask and the recorded paper fill agree.
 *
 * Reported, never gating. A cohort where most rows DIFFER is a real signal about
 * cross-source consistency; it is not a reason to discard the realized returns, which come
 * from the mirror's own fills.
 */
export interface EntryAgreement {
  historicalAsk: number | null;
  paperEntryFill: number;
  deltaAbs: number | null;
  deltaPct: number | null;
  agreement: "AGREES" | "DIFFERS" | "UNKNOWN";
  note: string;
}

export interface RealizedOutcome {
  version: typeof REALIZED_OUTCOME_VERSION;
  eventId: string;
  occ: string;
  opportunityCaseId: string | null;
  paperTradeId: number | null;

  state: RealizedState;
  /**
   * VERIFIED_REALIZED is the ONLY state that may enter an expectancy or profit factor.
   * Anything else is a statement about our records.
   */
  evidenceState: "VERIFIED_REALIZED" | "OPEN_POSITION" | "UNAVAILABLE";
  refusal: RealizedRefusal | null;

  /** The convention, recorded ON the row so a later reader cannot assume a different one. */
  convention: string;
  realizedEntry: number | null;
  realizedExit: number | null;
  realizedReturnPct: number | null;
  exitReason: string | null;
  enteredAtMs: number | null;
  exitAtMs: number | null;
  sessionDate: string | null;

  /** Which identity rules were checked and passed. */
  matchedOn: string[];
  /** Cross-source entry price corroboration. Null when no join was made. */
  entryAgreement: EntryAgreement | null;
  note: string;
}

interface PaperTradeRow {
  id: number;
  option_symbol: string;
  entry_fill: number | null;
  exit_fill: number | null;
  return_pct: number | null;
  status: string | null;
  exit_reason: string | null;
  entered_at_ms: number | null;
  exit_at_ms: number | null;
  alert_id: string | null;
  paper_kind: string | null;
}

function tableExists(db: StoreDb, name: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name);
  } catch {
    return false;
  }
}

function unavailable(
  event: WinnerEvent,
  refusal: RealizedRefusal,
  note: string,
  paperTradeId: number | null = null,
): RealizedOutcome {
  return {
    version: REALIZED_OUTCOME_VERSION,
    eventId: event.eventId,
    occ: event.occ,
    opportunityCaseId: event.opportunityCaseId ?? null,
    paperTradeId,
    state: "UNAVAILABLE",
    evidenceState: "UNAVAILABLE",
    refusal,
    convention: "no realized outcome was joined; MFE is NEVER substituted for one",
    realizedEntry: null, realizedExit: null, realizedReturnPct: null,
    exitReason: null, enteredAtMs: null, exitAtMs: null,
    sessionDate: event.sessionDate,
    matchedOn: [],
    entryAgreement: null,
    note,
  };
}

/** Compare the two sources' view of the entry price. Informational by design. */
function entryAgreementOf(historicalAsk: number | null, paperEntryFill: number): EntryAgreement {
  if (historicalAsk == null || !(historicalAsk > 0)) {
    return {
      historicalAsk, paperEntryFill, deltaAbs: null, deltaPct: null, agreement: "UNKNOWN",
      note: "the event carries no executable ask to compare against",
    };
  }
  const deltaAbs = +(paperEntryFill - historicalAsk).toFixed(4);
  const deltaPct = +((deltaAbs / historicalAsk) * 100).toFixed(4);
  const agrees = Math.abs(deltaAbs) <= ENTRY_MATCH_TOLERANCE;
  return {
    historicalAsk, paperEntryFill, deltaAbs, deltaPct,
    agreement: agrees ? "AGREES" : "DIFFERS",
    note: agrees
      ? `both sources put the entry within ${ENTRY_MATCH_TOLERANCE} of each other`
      : `the historical NBBO ask at the detection instant and the recorded fill differ by `
        + `${deltaAbs} (${deltaPct}%). Two measurements of one trade taken minutes apart from `
        + "different sources; the realized return uses the mirror's own fills and is unaffected",
  };
}

/**
 * Candidate paper trades for one opportunity case.
 *
 * Goes through the case's `alert_id`, which is the link the delivery lane actually wrote.
 * `options_paper_trades` has no case-id column, so the case is resolved to its alert and
 * the mirror is found from there — the same chain the mirror integrity check uses.
 */
function paperTradesForCase(db: StoreDb, opportunityCaseId: string): PaperTradeRow[] {
  try {
    const alert = db.prepare(
      "SELECT alert_id FROM opportunity_cases WHERE opportunity_id = ?",
    ).get?.(opportunityCaseId) as { alert_id?: string | null } | undefined;
    const alertId = alert?.alert_id ? String(alert.alert_id) : null;
    if (!alertId) return [];
    return (db.prepare(
      `SELECT id, option_symbol, entry_fill, exit_fill, return_pct, status, exit_reason,
              entered_at_ms, exit_at_ms, alert_id, paper_kind
         FROM options_paper_trades WHERE alert_id = ?`,
    ).all?.(alertId) ?? []) as PaperTradeRow[];
  } catch {
    return [];
  }
}

/**
 * Join one winner event to its realized outcome, or refuse and say why.
 *
 * The order of the checks is the order of the identity argument, so a refusal names the
 * first rule that failed rather than a generic miss.
 */
export function realizedOutcomeForEvent(db: StoreDb, event: WinnerEvent): RealizedOutcome {
  if (!tableExists(db, "options_paper_trades") || !tableExists(db, "opportunity_cases")) {
    return unavailable(event, "PAPER_TABLE_ABSENT", "the paper/case tables are not present in this database");
  }
  const caseId = event.opportunityCaseId;
  if (!caseId) {
    return unavailable(
      event,
      "NO_CASE_ID_ON_EVENT",
      "this event was not anchored on an opportunity case, so no realized identity can be proven. "
      + "An OCC-only join would risk attaching a return from a different decision on the same contract",
    );
  }

  const rows = paperTradesForCase(db, caseId);
  if (!rows.length) {
    return unavailable(
      event,
      "NO_PAPER_TRADE_FOR_CASE",
      `no paper mirror is linked to case ${caseId}; the setup has excursion evidence but the `
      + "governing policy has no recorded outcome for it",
    );
  }

  // Rule 1: the exact contract.
  const sameOcc = rows.filter((r) => String(r.option_symbol ?? "").toUpperCase() === event.occ);
  if (!sameOcc.length) {
    return unavailable(
      event,
      "OCC_MISMATCH",
      `case ${caseId} has ${rows.length} paper mirror(s) but none on ${event.occ}; measuring one `
      + "contract with another is the exact failure this store exists to prevent",
    );
  }

  // An entry fill is required — not to prove identity, but because the realized return is
  // computed from it. Without one there is no return to recover.
  const withFill = sameOcc.filter((r) => r.entry_fill != null && Number.isFinite(Number(r.entry_fill)));
  if (!withFill.length) {
    return unavailable(
      event,
      "NO_ENTRY_FILL_RECORDED",
      "the mirror records no entry fill, so no realized return can be computed from it",
      sameOcc[0]?.id ?? null,
    );
  }

  // Rule 3: the same moment. This is what separates one decision from a later re-entry on
  // the same contract, and it is the last identity rule — the entry PRICE is corroboration,
  // not identity, because two sources measuring one trade minutes apart legitimately differ.
  const timeMatches = withFill.filter((r) => {
    const at = r.entered_at_ms == null ? null : Number(r.entered_at_ms);
    if (at == null || !Number.isFinite(at)) return false;
    const delta = at - event.entryAtMs;
    // At or after the event instant: a mirror cannot precede the detection it mirrors.
    return delta >= -60_000 && delta <= ENTRY_TIME_TOLERANCE_MS;
  });
  if (!timeMatches.length) {
    return unavailable(
      event,
      "ENTRY_TIME_MISMATCH",
      "no mirror was entered within the window around this event's entry instant; a later entry "
      + "on the same contract is a different decision",
      withFill[0]?.id ?? null,
    );
  }
  if (timeMatches.length > 1) {
    return unavailable(
      event,
      "AMBIGUOUS_MULTIPLE_MATCHES",
      `${timeMatches.length} mirrors satisfy every identity rule; picking one would be arbitrary`,
      timeMatches[0]?.id ?? null,
    );
  }

  const t = timeMatches[0];
  const matchedOn = ["exact OCC", "same opportunity case", "entry instant within window"];
  const agreement = entryAgreementOf(event.entryPrice, Number(t.entry_fill));
  const status = String(t.status ?? "").toUpperCase();
  const isClosed = status === "CLOSED" || status === "EXITED" || t.exit_at_ms != null;

  if (!isClosed) {
    return {
      version: REALIZED_OUTCOME_VERSION,
      eventId: event.eventId, occ: event.occ, opportunityCaseId: caseId, paperTradeId: t.id,
      state: "OPEN",
      // An open position has no realized return. Marking it to market and calling that
      // realized is how an unclosed loser becomes a statistic.
      evidenceState: "OPEN_POSITION",
      refusal: null,
      convention: "position still open; no realized return exists yet and none is inferred",
      realizedEntry: Number(t.entry_fill), realizedExit: null, realizedReturnPct: null,
      exitReason: null, enteredAtMs: t.entered_at_ms == null ? null : Number(t.entered_at_ms),
      exitAtMs: null, sessionDate: event.sessionDate,
      matchedOn,
      entryAgreement: agreement,
      note: `identity proven against paper trade ${t.id}, but it has not closed`,
    };
  }

  if (t.exit_fill == null || !Number.isFinite(Number(t.exit_fill))) {
    return unavailable(
      event,
      "CLOSED_WITHOUT_EXIT_FILL",
      `paper trade ${t.id} is closed but records no exit fill, so its realized return is not `
      + "recoverable. It is NOT inferred from the excursion",
      t.id,
    );
  }

  const entry = Number(t.entry_fill);
  const exit = Number(t.exit_fill);
  // Recomputed from the fills rather than trusting a stored `return_pct`, so the number and
  // the prices behind it can never disagree.
  const ret = entry > 0 ? +(((exit - entry) / entry) * 100).toFixed(4) : null;

  return {
    version: REALIZED_OUTCOME_VERSION,
    eventId: event.eventId, occ: event.occ, opportunityCaseId: caseId, paperTradeId: t.id,
    state: ret == null ? "UNAVAILABLE" : ret > 0 ? "WIN" : "LOSS",
    evidenceState: ret == null ? "UNAVAILABLE" : "VERIFIED_REALIZED",
    refusal: ret == null ? "NO_ENTRY_FILL_RECORDED" : null,
    convention:
      "realized return = (exit fill − entry fill) / entry fill, both as recorded by the paper "
      + "mirror. Recomputed from the fills, never read from a stored percentage, and never "
      + "derived from MFE.",
    realizedEntry: entry,
    realizedExit: exit,
    realizedReturnPct: ret,
    exitReason: t.exit_reason == null ? null : String(t.exit_reason),
    enteredAtMs: t.entered_at_ms == null ? null : Number(t.entered_at_ms),
    exitAtMs: t.exit_at_ms == null ? null : Number(t.exit_at_ms),
    sessionDate: event.sessionDate,
    matchedOn,
    entryAgreement: agreement,
    note: `identity proven against paper trade ${t.id}; realized ${ret}% from ${entry} to ${exit}`
      + (agreement.agreement === "DIFFERS"
        ? ` (historical ask ${agreement.historicalAsk} differs by ${agreement.deltaAbs}; corroboration only)`
        : ""),
  };
}

export interface RealizedCensus {
  examined: number;
  verifiedRealized: number;
  open: number;
  unavailable: number;
  byRefusal: Record<string, number>;
  /**
   * Cross-source entry price agreement across the joined rows.
   *
   * Reported because it is the diagnostic that used to be a refusal: if most joins DIFFER,
   * the historical NBBO and the live fill path disagree systematically and that is worth
   * knowing — but it is a statement about instrumentation, not about the returns.
   */
  entryAgreement: { agrees: number; differs: number; unknown: number; medianAbsDelta: number | null };
  note: string;
}

/** Join a batch and census the result. Refusals are grouped by cause, never pooled. */
export function realizedOutcomesForEvents(
  db: StoreDb,
  events: readonly WinnerEvent[],
): { outcomes: RealizedOutcome[]; census: RealizedCensus } {
  const outcomes = events.map((e) => realizedOutcomeForEvent(db, e));
  const byRefusal: Record<string, number> = {};
  for (const o of outcomes) {
    if (o.refusal) byRefusal[o.refusal] = (byRefusal[o.refusal] ?? 0) + 1;
  }
  const joined = outcomes.filter((o) => o.entryAgreement != null);
  const deltas = joined
    .map((o) => o.entryAgreement?.deltaAbs)
    .filter((v): v is number => v != null)
    .map((v) => Math.abs(v))
    .sort((a, b) => a - b);
  return {
    outcomes,
    census: {
      examined: events.length,
      verifiedRealized: outcomes.filter((o) => o.evidenceState === "VERIFIED_REALIZED").length,
      open: outcomes.filter((o) => o.evidenceState === "OPEN_POSITION").length,
      unavailable: outcomes.filter((o) => o.evidenceState === "UNAVAILABLE").length,
      byRefusal,
      entryAgreement: {
        agrees: joined.filter((o) => o.entryAgreement?.agreement === "AGREES").length,
        differs: joined.filter((o) => o.entryAgreement?.agreement === "DIFFERS").length,
        unknown: joined.filter((o) => o.entryAgreement?.agreement === "UNKNOWN").length,
        medianAbsDelta: deltas.length
          ? +(deltas.length % 2
            ? deltas[(deltas.length - 1) / 2]
            : (deltas[deltas.length / 2 - 1] + deltas[deltas.length / 2]) / 2).toFixed(4)
          : null,
      },
      note:
        "Only VERIFIED_REALIZED rows may enter an expectancy or profit factor. OPEN positions have "
        + "no realized return and are not marked to market to manufacture one. UNAVAILABLE is a "
        + "statement about our records, not about the trade, and each refusal names the identity "
        + "rule that failed.",
    },
  };
}

// ── realized statistics ──────────────────────────────────────────────────────

export interface RealizedStats {
  version: typeof REALIZED_OUTCOME_VERSION;
  /** THE denominator. Closed, identity-proven trades — nothing else. */
  closedTrades: number;
  independentSessions: number;
  sessionAudit: IndependentSessionCount;
  verdict: "SUPPORTED" | "INSUFFICIENT_EVIDENCE";
  floorReason: string;

  winRate: number | null;
  meanReturnPct: number | null;
  medianReturnPct: number | null;
  avgWinnerPct: number | null;
  avgLoserPct: number | null;
  profitFactor: number | null;
  payoffRatio: number | null;

  /** Robustness on the REALIZED population, computed even when the floor fails. */
  profitFactorExBest: number | null;
  profitFactorCapped: number | null;
  cappedAtPct: number;
  bestTradeShareOfGross: number | null;
  survivesBestExcluded: boolean | null;

  /** Populations that were deliberately NOT counted, so the gap is visible. */
  excluded: { open: number; unavailable: number };
  basis: string;
  warnings: string[];
}

const mean = (xs: number[]): number | null =>
  xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4) : null;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? +s[m].toFixed(4) : +(((s[m - 1] + s[m]) / 2).toFixed(4));
}

function profitFactorOf(returns: number[]): number | null {
  const win = returns.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const loss = Math.abs(returns.filter((r) => r <= 0).reduce((a, b) => a + b, 0));
  return loss > 0 ? +(win / loss).toFixed(4) : null;
}

/**
 * Realized expectancy and profit factor.
 *
 * Takes RealizedOutcome rows rather than numbers so it can enforce the population itself.
 * A caller that pre-extracted an array of returns has already had the opportunity to slip
 * an MFE or an open mark into it.
 */
export function realizedStats(
  outcomes: readonly RealizedOutcome[],
  opts: { minTrades?: number; minSessions?: number; returnCapPct?: number } = {},
): RealizedStats {
  const minTrades = opts.minTrades ?? 20;
  const minSessions = opts.minSessions ?? 5;
  const cap = opts.returnCapPct ?? 100;

  const closed = outcomes.filter(
    (o) => o.evidenceState === "VERIFIED_REALIZED" && o.realizedReturnPct != null,
  );
  const returns = closed.map((o) => o.realizedReturnPct as number);
  const audit = countIndependentSessions(closed.map((o) => o.sessionDate));
  const sessions = audit.independentSessions;

  const ok = closed.length >= minTrades && sessions >= minSessions;
  const supported = <T>(v: T): T | null => (ok ? v : null);

  const winners = returns.filter((r) => r > 0);
  const losers = returns.filter((r) => r <= 0);
  const pf = profitFactorOf(returns);

  const best = returns.length ? Math.max(...returns) : null;
  const exBest = best == null ? [] : returns.filter((_, i) => i !== returns.indexOf(best));
  const pfExBest = exBest.length ? profitFactorOf(exBest) : null;
  const pfCapped = returns.length ? profitFactorOf(returns.map((r) => Math.min(r, cap))) : null;
  const grossWin = winners.reduce((a, b) => a + b, 0);
  const bestShare = best != null && best > 0 && grossWin > 0 ? +(best / grossWin).toFixed(4) : null;

  const avgWin = mean(winners);
  const avgLoss = mean(losers);
  const payoff = avgWin != null && avgLoss != null && avgLoss !== 0
    ? +Math.abs(avgWin / avgLoss).toFixed(4)
    : null;

  const warnings: string[] = [...audit.warnings];
  if (!ok) {
    warnings.push(
      `realized statistics withheld: needs >= ${minTrades} closed identity-proven trades over `
      + `>= ${minSessions} trading sessions; has ${closed.length} over ${sessions}`,
    );
  }
  if (bestShare != null && bestShare >= 0.5) {
    warnings.push(`one trade supplies ${Math.round(bestShare * 100)}% of realized gross profit`);
  }
  if (pf != null && pfExBest != null && pf > 1 && pfExBest <= 1) {
    warnings.push("realized profit factor falls to <= 1 without the single best trade");
  }
  const openCount = outcomes.filter((o) => o.evidenceState === "OPEN_POSITION").length;
  if (openCount > closed.length && openCount > 0) {
    warnings.push(
      `${openCount} joined position(s) are still OPEN against ${closed.length} closed; the realized `
      + "record is younger than the excursion record and may not represent the policy yet",
    );
  }

  return {
    version: REALIZED_OUTCOME_VERSION,
    closedTrades: closed.length,
    independentSessions: sessions,
    sessionAudit: audit,
    verdict: ok ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE",
    floorReason: ok
      ? `${closed.length} closed identity-proven trades over ${sessions} trading sessions`
      : `needs >= ${minTrades} closed trades over >= ${minSessions} sessions; has ${closed.length} over ${sessions}`,

    winRate: supported(returns.length ? +(winners.length / returns.length).toFixed(4) : null),
    meanReturnPct: supported(mean(returns)),
    medianReturnPct: supported(median(returns)),
    avgWinnerPct: supported(avgWin),
    avgLoserPct: supported(avgLoss),
    profitFactor: supported(pf),
    payoffRatio: supported(payoff),

    // Robustness is reported even below the floor: a reader deciding whether to keep
    // collecting needs to see that four closed trades are one winner and three losers.
    profitFactorExBest: pfExBest,
    profitFactorCapped: pfCapped,
    cappedAtPct: cap,
    bestTradeShareOfGross: bestShare,
    survivesBestExcluded: pf != null && pfExBest != null ? pfExBest > 1 && pf > 1 : null,

    excluded: {
      open: openCount,
      unavailable: outcomes.filter((o) => o.evidenceState === "UNAVAILABLE").length,
    },
    basis:
      "REALIZED ONLY. Every value above comes from (exit fill − entry fill) / entry fill on "
      + "closed, identity-proven paper mirrors. No maximum favourable excursion, no mark-to-market "
      + "on an open position, and no stored percentage is used. These numbers answer 'how "
      + "profitable was the policy', NOT 'how often did the setup run' — that is the excursion "
      + "population, which has a different and larger denominator.",
    warnings,
  };
}

/**
 * forensic.ts — the session forensic. "Did we miss it, and if so, why?"
 *
 * A STRUCTURAL LIMIT, STATED UP FRONT. Verifying an executable ask→bid return for
 * a session that has already closed requires historical NBBO. Option AGGREGATES
 * (the only bounded historical option series available here) are TRADE prints:
 * they prove a price occurred, never that anyone could have bought or sold there.
 * So this module has exactly two evidence tiers and never blurs them:
 *
 *   NBBO tier   — bid/ask the system captured LIVE and persisted
 *                 (`options_research_observations`, `options_paper_marks`).
 *                 This tier can reach VERIFIED_EXECUTABLE.
 *   TRADE tier  — minute aggregates fetched after the fact.
 *                 This tier is capped at LAST_TRADE_ONLY, forever.
 *
 * A contract OptiScan never quoted therefore cannot produce an official missed-
 * winner claim, only a research lead. That is not a gap to paper over — it is the
 * honest consequence of not having been there, and pretending otherwise is how a
 * +2,000% headline becomes an engineering mandate it never earned.
 *
 * PROVIDER COST IS BOUNDED AND SUBORDINATE. All fetching runs inside the
 * `historical_research` consumer scope, which holds NO minute reserve — it can
 * only ever spend from the shared pool, so it is structurally incapable of taking
 * capacity from the scanner or either marking lane. A hard per-run request cap
 * bounds it further.
 */
import { withProviderConsumer } from "@/lib/provider-context";
import {
  MISSED_OPPORTUNITY_CASE_VERSION,
  emptyLadder,
  type ClaimVerdict,
  type MissedOpportunityCase,
  type QuoteObservation,
} from "./types.ts";
import { reconstructSymbol, type ReadDb, type SymbolReconstruction } from "./reconstruct.ts";
import { classifyCase } from "./classify.ts";
import {
  emptyVerifiedReturns,
  inferExecutableNotionalUsd,
  findEntry,
  verifyExecutableReturns,
  type VerifiedReturns,
} from "./returns.ts";
import { missedOpportunityId } from "./store.ts";

/** Hard ceiling on provider requests per forensic run. Never raised at runtime. */
export const MAX_PROVIDER_REQUESTS_PER_RUN = 40;

export interface ForensicInput {
  db: ReadDb;
  symbol: string;
  sessionDate: string;
  sessionFromMs: number;
  sessionToMs: number;
  /** Direction the reported winner required. */
  winnerDirection: "CALL" | "PUT" | null;
  /** Research threshold the case is raised against, e.g. 2000 for +2,000%. */
  thresholdPct: number;
  /** Externally claimed return, if the owner supplied one. Never trusted. */
  claimedReturnPct: number | null;
  claimSource: string | null;
  /** Provider state during the window, for budget attribution. */
  systemState?: MissedOpportunityCase["systemState"];
  nowMs: number;
}

/**
 * Build a per-contract NBBO series from what the system actually quoted live.
 * These are real bid/ask observations with provider timestamps — the only
 * evidence that can support an executable claim about a closed session.
 */
export function nbboSeriesFromReconstruction(
  rc: SymbolReconstruction,
): Map<string, QuoteObservation[]> {
  const byOcc = new Map<string, QuoteObservation[]>();
  for (const o of rc.observations) {
    if (!o.occSymbol || o.atMs == null) continue;
    if (o.bid == null && o.ask == null) continue;
    const occ = o.occSymbol.toUpperCase();
    const list = byOcc.get(occ) ?? [];
    list.push({
      atMs: o.atMs,
      bid: o.bid,
      ask: o.ask,
      midpoint: o.bid != null && o.ask != null ? (o.bid + o.ask) / 2 : null,
      lastTrade: null,
      quoteTimestampMs: o.atMs,
      volume: o.volume,
      openInterest: o.openInterest,
    });
    byOcc.set(occ, list);
  }
  return byOcc;
}

/**
 * Paper marks are a second NBBO source: they are bid/ask the marking lane read
 * from the provider and persisted, so they carry the same evidentiary weight as
 * a research observation.
 */
export function nbboSeriesFromPaperMarks(
  db: ReadDb,
  symbol: string,
  fromMs: number,
  toMs: number,
): Map<string, QuoteObservation[]> {
  const byOcc = new Map<string, QuoteObservation[]>();
  try {
    const has = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_paper_marks'")
      .get();
    if (!has) return byOcc;
    const rows = db
      .prepare(
        `SELECT option_symbol, mark_at_ms, bid, ask
           FROM options_paper_marks
          WHERE option_symbol LIKE ? AND mark_at_ms BETWEEN ? AND ?
          ORDER BY mark_at_ms ASC LIMIT 4000`,
      )
      .all(`O:${symbol.toUpperCase()}%`, fromMs, toMs) as any[];
    for (const r of rows) {
      const occ = String(r.option_symbol ?? "").toUpperCase();
      const atMs = Number(r.mark_at_ms);
      if (!occ || !Number.isFinite(atMs)) continue;
      const bid = r.bid == null ? null : Number(r.bid);
      const ask = r.ask == null ? null : Number(r.ask);
      if (bid == null && ask == null) continue;
      const list = byOcc.get(occ) ?? [];
      list.push({
        atMs, bid, ask,
        midpoint: bid != null && ask != null ? (bid + ask) / 2 : null,
        lastTrade: null, quoteTimestampMs: atMs, volume: null, openInterest: null,
      });
      byOcc.set(occ, list);
    }
  } catch {
    /* research never escalates */
  }
  return byOcc;
}

/** Merge NBBO sources per contract, keeping observations time-ordered. */
export function mergeSeries(
  ...maps: Map<string, QuoteObservation[]>[]
): Map<string, QuoteObservation[]> {
  const out = new Map<string, QuoteObservation[]>();
  for (const m of maps) {
    for (const [occ, list] of m) {
      const acc = out.get(occ) ?? [];
      acc.push(...list);
      out.set(occ, acc);
    }
  }
  for (const [occ, list] of out) {
    out.set(occ, list.sort((a, b) => a.atMs - b.atMs));
  }
  return out;
}

/**
 * Grade the claim. The verdict is a statement about EVIDENCE, not about size:
 * a huge number on a thin tier still grades thin.
 */
export function gradeVerdict(input: {
  hasNbbo: boolean;
  verified: VerifiedReturns;
  thresholdPct: number;
  claimed: boolean;
}): ClaimVerdict {
  const { hasNbbo, verified, thresholdPct } = input;

  if (!hasNbbo) {
    // No quote the system ever saw. A trade-tier move is a lead, not a result.
    return input.claimed ? "UNVERIFIED_EXTERNAL_CLAIM" : "INSUFFICIENT_EVIDENCE";
  }
  if (verified.executableReturnPct == null) return "INSUFFICIENT_EVIDENCE";
  if (verified.singleObservationPeak && verified.executableReturnPct >= thresholdPct) {
    return "BAD_PRINT";
  }
  if (verified.executableReturnPct >= thresholdPct) return "VERIFIED_EXECUTABLE";

  // The executable path fell short. Did a flattering basis reach the threshold?
  const best = verified.diagnostics.reduce<{ basis: string; pct: number } | null>(
    (acc, d) => (acc == null || d.returnPct > acc.pct ? { basis: d.basis, pct: d.returnPct } : acc),
    null,
  );
  if (best && best.pct >= thresholdPct) {
    if (best.basis === "MIDPOINT") return "MIDPOINT_ONLY";
    if (best.basis === "LAST_TRADE") return "LAST_TRADE_ONLY";
    if (best.basis === "ASK_TO_ASK") return "ASK_SIDE_ONLY";
  }
  if (verified.executableReturnPct > 0) return "PARTIALLY_EXECUTABLE";
  return "INSUFFICIENT_EVIDENCE";
}

/**
 * The earliest non-hindsight entry: the first moment the system had a directional
 * reason to act. Falls back to the first observation of the contract — never to
 * the timestamp of the cheapest premium, which would measure a trade nobody could
 * have taken.
 */
export function earliestValidEntryMs(
  rc: SymbolReconstruction,
  series: QuoteObservation[],
): number | null {
  const candidates: number[] = [];
  if (rc.regularScanner.firstCandidateAtMs != null) candidates.push(rc.regularScanner.firstCandidateAtMs);
  if (rc.highAsymmetry.firstSeenAtMs != null) candidates.push(rc.highAsymmetry.firstSeenAtMs);
  if (candidates.length > 0) return Math.min(...candidates);
  return series.length > 0 ? series[0].atMs : null;
}

export interface ForensicResult {
  case: MissedOpportunityCase;
  /** Per-contract NBBO coverage, so weak evidence is visible rather than implied. */
  contractsWithNbbo: number;
  nbboObservations: number;
  /** Best executable contract found, when any NBBO series produced one. */
  bestOcc: string | null;
  notes: string[];
}

/**
 * Run the forensic for one symbol on one closed session. DB-only: this function
 * makes no provider call at all, which is why it is safe to run while the minute
 * cap is saturated.
 */
export function runSymbolForensic(input: ForensicInput): ForensicResult {
  const notes: string[] = [];
  const rc = reconstructSymbol(
    input.db, input.symbol, input.sessionDate, input.sessionFromMs, input.sessionToMs,
  );

  const series = mergeSeries(
    nbboSeriesFromReconstruction(rc),
    nbboSeriesFromPaperMarks(input.db, input.symbol, input.sessionFromMs, input.sessionToMs),
  );

  // Only contracts matching the winner's direction are eligible; a PUT series
  // cannot verify a CALL claim.
  const wantSide = input.winnerDirection === "CALL" ? "C" : input.winnerDirection === "PUT" ? "P" : null;
  const eligible = [...series.entries()].filter(([occ]) => {
    if (!wantSide) return true;
    const m = /^O?:?[A-Z]{1,6}\d{6}([CP])\d{8}$/.exec(occ.replace(/^O:/, ""));
    return m ? m[1] === wantSide : true;
  });

  let best: { occ: string; verified: VerifiedReturns } | null = null;
  let nbboObservations = 0;
  for (const [occ, list] of eligible) {
    nbboObservations += list.length;
    const entryAt = earliestValidEntryMs(rc, list);
    if (entryAt == null) continue;
    const v = verifyExecutableReturns(list, entryAt);
    if (v.executableReturnPct == null) continue;
    if (!best || v.executableReturnPct > (best.verified.executableReturnPct ?? -Infinity)) {
      best = { occ, verified: v };
    }
  }

  const hasNbbo = best != null;
  const verified = best?.verified ?? emptyVerifiedReturns();
  if (!hasNbbo) {
    notes.push(
      eligible.length === 0
        ? "No NBBO series for any contract on this symbol/direction — the system never quoted one, so no executable claim is possible."
        : "NBBO series exist but none produced an entry with a later bid; executable return is unverifiable.",
    );
  }

  const verdict = gradeVerdict({
    hasNbbo,
    verified,
    thresholdPct: input.thresholdPct,
    claimed: input.claimedReturnPct != null,
  });

  const systemState = input.systemState ?? {
    providerMinutesObserved: 0, providerRequestsInWindow: 0, providerQuotaBlocksInWindow: 0,
    admissionPct: null, budgetPlausibleCause: false, notes: [],
  };

  const classification = classifyCase({
    reconstruction: rc,
    executableReturnPct: verified.executableReturnPct,
    verdict,
    thresholdPct: input.thresholdPct,
    hadQuoteEvidence: hasNbbo,
    budgetPlausibleCause: systemState.budgetPlausibleCause,
    winnerDirection: input.winnerDirection,
  });

  const occ = best?.occ ?? null;
  const parsed = occ ? /^O?:?([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ.replace(/^O:/, "")) : null;
  const entryObs = best ? findEntry(series.get(best.occ) ?? [], verified.entryAtMs ?? 0) : null;

  const c: MissedOpportunityCase = {
    missedOpportunityId: missedOpportunityId(input.sessionDate, input.symbol, occ),
    caseVersion: MISSED_OPPORTUNITY_CASE_VERSION,
    symbol: input.symbol.toUpperCase(),
    sessionDate: input.sessionDate,
    direction: input.winnerDirection,
    occSymbol: occ,
    expiration: parsed ? `20${parsed[2]}-${parsed[3]}-${parsed[4]}` : null,
    strike: parsed ? Number(parsed[6]) / 1000 : null,
    dte: null,
    externalClaim: {
      claimed: input.claimedReturnPct != null,
      claimedReturnPct: input.claimedReturnPct,
      source: input.claimSource,
      alertIdentified: false,
      verdict,
    },
    verified: {
      executableReturnPct: verified.executableReturnPct,
      basis: verified.executableReturnPct != null ? "ASK_TO_BID" : null,
      measured: verified.diagnostics,
      ladder: verified.ladder ?? emptyLadder(),
      mfePct: verified.mfePct,
      maePct: verified.maePct,
      entrySpreadPct: verified.entrySpreadPct,
      entryVolume: verified.entryVolume,
      entryOpenInterest: verified.entryOpenInterest,
      maxExecutableBid: verified.maxExecutableBid,
      executableNotionalUsd: inferExecutableNotionalUsd(entryObs),
    },
    timeline: {
      earliestValidSetupAtMs: rc.regularScanner.firstCandidateAtMs ?? rc.highAsymmetry.firstSeenAtMs,
      earliestExecutableContractAtMs: verified.entryAtMs,
      optiscanFirstSeenAtMs: rc.regularScanner.firstSeenAtMs,
      asymmetryFirstSeenAtMs: rc.highAsymmetry.firstSeenAtMs,
      localHighAtMs: verified.exitAtMs,
    },
    regularScanner: rc.regularScanner,
    highAsymmetry: rc.highAsymmetry,
    betterAlternativeOcc: null,
    rootCause: classification.rootCause,
    secondaryCauses: classification.secondaryCauses,
    failureFamily: classification.failureFamily,
    recoverability: classification.recoverability,
    evidenceQuality: classification.evidenceQuality,
    systemState,
    quantFinding: null,
    aiAdvisory: null,
    experimentId: null,
    feedbackProposalId: null,
    status: "RESEARCH_ONLY",
    productionChanged: false,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
  };

  return {
    case: c,
    contractsWithNbbo: eligible.length,
    nbboObservations,
    bestOcc: occ,
    notes,
  };
}

/**
 * Trade-tier discovery: which contracts on this underlying actually moved.
 *
 * Runs inside `historical_research`, which holds no minute reserve, and is capped
 * per run. Returns TRADE-tier evidence only — a result here is a research lead and
 * can never be graded above LAST_TRADE_ONLY.
 */
export async function discoverTradeTierMoves(
  fetchCandles: (symbol: string, opts: Record<string, unknown>) => Promise<{ available: boolean; bars: any[] }>,
  occSymbols: string[],
  sessionDate: string,
  maxRequests: number = MAX_PROVIDER_REQUESTS_PER_RUN,
): Promise<{ occSymbol: string; low: number; high: number; movePct: number; bars: number }[]> {
  const capped = occSymbols.slice(0, Math.max(0, maxRequests));
  const out: { occSymbol: string; low: number; high: number; movePct: number; bars: number }[] = [];

  await withProviderConsumer({ consumer: "historical_research", historical: true }, async () => {
    for (const occ of capped) {
      try {
        const res = await fetchCandles(occ, {
          resolution: "1", timespan: "minute", from: sessionDate, to: sessionDate, limit: 5000,
        });
        if (!res?.available || !Array.isArray(res.bars) || res.bars.length === 0) continue;
        let low = Infinity, high = -Infinity;
        for (const b of res.bars) {
          const l = Number(b.l), h = Number(b.h);
          if (Number.isFinite(l)) low = Math.min(low, l);
          if (Number.isFinite(h)) high = Math.max(high, h);
        }
        if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0) continue;
        out.push({
          occSymbol: occ, low, high,
          movePct: ((high - low) / low) * 100,
          bars: res.bars.length,
        });
      } catch {
        /* one contract failing must not end the sweep */
      }
    }
  });

  return out.sort((a, b) => b.movePct - a.movePct);
}

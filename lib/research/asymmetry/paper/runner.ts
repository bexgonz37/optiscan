/**
 * runner.ts — the scheduled owner of the High-Asymmetry paper lane.
 *
 *   runAsymmetryPaper()
 *     -> listCasesOnDb()                [read asymmetry_cases]
 *     -> openAsymmetryPaperTrade()      [write asymmetry_paper_positions / _skips]
 *     -> listOpenPaperPositionsOnDb()   [read asymmetry_paper_positions]
 *     -> quote provider                 [injected — the SAME verified adapter marks use]
 *     -> writePaperMarkOnDb()           [write asymmetry_paper_marks]
 *     -> evaluatePaperManagement()      [pure, versioned]
 *     -> closePaperPositionOnDb() | recordUnverifiedExitOnDb()
 *
 * ONE JOB owns both halves deliberately. Entry and management need the same
 * fresh quote for the same contract in the same tick; splitting them would
 * double the provider calls and let a position be opened against one quote and
 * immediately managed against a different one.
 *
 * Never throws. Every case and every position is processed inside its own
 * try/catch so one bad row cannot abort the sweep, and the whole sweep is
 * wrapped again so nothing can reach the scheduler, the scanner, or Discord.
 *
 * NO AI. Not imported, not called, not awaited. The complete paper runtime —
 * entry, marks, exits, grading — runs with the AI modules absent entirely, and
 * a test asserts it.
 */
import { listCasesOnDb } from "../case-store.ts";
import { regularCloseMs } from "../../../market-session-guard.ts";
import { PAPER_ENABLED_ENV, isPaperEntryState, paperPositionFingerprint } from "./lane.ts";
import { openAsymmetryPaperTrade, type PaperEntryQuote } from "./entry.ts";
import {
  evaluatePaperManagement, resolveManagementConfig, updateExcursions, highestMilestone,
  type ManagementConfig,
} from "./management.ts";
import { paperPnlUsd, paperReturnPct, resolveSizingConfig } from "./sizing.ts";
import {
  listOpenPaperPositionsOnDb, writePaperMarkOnDb, applyPaperMarkOnDb,
  closePaperPositionOnDb, recordUnverifiedExitOnDb, hasPaperPosition,
} from "./store.ts";

type RunnerDb = Parameters<typeof listCasesOnDb>[0] & Parameters<typeof listOpenPaperPositionsOnDb>[0];

export interface PaperQuote {
  optionSymbol: string;
  bid: number | null;
  ask: number | null;
  quoteAtMs: number | null;
  underlyingPrice?: number | null;
}

export interface PaperRunResult {
  ran: boolean;
  reason: string | null;
  casesRead: number;
  entriesOpened: number;
  entriesSkipped: number;
  positionsManaged: number;
  marksWritten: number;
  marksRejected: number;
  positionsClosed: number;
  positionsUnverified: number;
  providerErrors: number;
  errors: string[];
}

export interface PaperRunDeps {
  /** The verified exact-OCC provider. Same interface the mark runner uses. */
  quote: (optionSymbol: string, underlyingSymbol: string) => Promise<{ quote: PaperQuote | null; providerError: string | null }>;
  nowMs: number;
  sessionDate: string;
  env?: NodeJS.ProcessEnv;
  management?: ManagementConfig;
  codeVersion?: string | null;
}

/** Sweep the paper lane: open eligible entries, then manage open positions. */
export async function runAsymmetryPaper(db: RunnerDb, deps: PaperRunDeps): Promise<PaperRunResult> {
  const out: PaperRunResult = {
    ran: false, reason: null, casesRead: 0, entriesOpened: 0, entriesSkipped: 0,
    positionsManaged: 0, marksWritten: 0, marksRejected: 0, positionsClosed: 0,
    positionsUnverified: 0, providerErrors: 0, errors: [],
  };
  try {
    const env = deps.env ?? process.env;
    if (env[PAPER_ENABLED_ENV] !== "1") {
      out.reason = `${PAPER_ENABLED_ENV} is not set`;
      return out;
    }
    out.ran = true;

    const cfg = deps.management ?? resolveManagementConfig(env);
    const sizing = resolveSizingConfig(env);
    const sessionCloseAtMs = safeCloseMs(deps.sessionDate, deps.nowMs, env);

    // One quote per contract per sweep. Entry and management then agree by
    // construction rather than by luck.
    const quotes = new Map<string, { quote: PaperQuote | null; providerError: string | null }>();
    const fetchQuote = async (occ: string, symbol: string) => {
      const key = occ.toUpperCase();
      const cached = quotes.get(key);
      if (cached) return cached;
      let result: { quote: PaperQuote | null; providerError: string | null };
      try {
        result = await deps.quote(occ, symbol);
      } catch (err: any) {
        result = { quote: null, providerError: String(err?.message ?? err) };
      }
      if (result.providerError) out.providerErrors += 1;
      quotes.set(key, result);
      return result;
    };

    // ── 1. Entries ────────────────────────────────────────────────────────
    const cases = listCasesOnDb(db, deps.sessionDate, 500);
    out.casesRead = cases.length;
    const caseState = new Map<string, string>();
    for (const c of cases) caseState.set(c.fingerprint, c.state);

    for (const c of cases) {
      try {
        if (!isPaperEntryState(c.state)) continue;
        const fingerprint = paperPositionFingerprint({
          sessionDate: c.sessionDate, symbol: c.symbol, direction: c.direction,
          optionSymbol: c.optionSymbol, setupFamily: setupOf(c),
        });
        // Cheap read first: the overwhelming majority of sweeps find the
        // position already open, and there is no reason to spend a provider
        // call to rediscover that.
        if (hasPaperPosition(db, c.sessionDate, fingerprint)) continue;

        const fetched = await fetchQuote(c.optionSymbol, c.symbol);
        const entryQuote: PaperEntryQuote | null = fetched.quote
          ? {
            optionSymbol: fetched.quote.optionSymbol,
            bid: fetched.quote.bid,
            ask: fetched.quote.ask,
            quoteAtMs: fetched.quote.quoteAtMs,
            underlyingPrice: fetched.quote.underlyingPrice ?? null,
          }
          : null;

        const res = openAsymmetryPaperTrade(db, {
          sessionDate: c.sessionDate,
          caseFingerprint: c.fingerprint,
          symbol: c.symbol,
          direction: c.direction,
          optionSymbol: c.optionSymbol,
          setupFamily: setupOf(c),
          state: c.state,
          evidenceJson: null,
          missingEvidence: c.missingEvidence,
        }, entryQuote, {
          nowMs: deps.nowMs, env, sizing, codeVersion: deps.codeVersion ?? null,
        });
        if (res.opened) out.entriesOpened += 1;
        else if (res.skipped) out.entriesSkipped += 1;
        if (res.error) out.errors.push(`entry ${c.fingerprint}: ${res.error}`);
      } catch (err: any) {
        out.errors.push(`entry ${c.fingerprint}: ${String(err?.message ?? err)}`);
      }
    }

    // ── 2. Management ─────────────────────────────────────────────────────
    const open = listOpenPaperPositionsOnDb(db, deps.sessionDate);
    for (const p of open) {
      try {
        out.positionsManaged += 1;
        const fetched = await fetchQuote(p.optionSymbol, p.symbol);
        const q = fetched.quote;

        // A rejected mark is recorded with its reason and no numbers. The
        // position is untouched: an absent quote says nothing about the trade.
        const rejection = fetched.providerError
          ? "PROVIDER_ERROR"
          : !q ? "NO_QUOTE"
            : String(q.optionSymbol ?? "").toUpperCase() !== p.optionSymbol.toUpperCase() ? "WRONG_OCC"
              : q.quoteAtMs == null ? "NO_QUOTE"
                : q.quoteAtMs > deps.nowMs ? "FUTURE_QUOTE"
                  : q.bid == null || q.bid <= 0 ? "NO_BID"
                    : null;

        const returnPct = rejection ? null : paperReturnPct(p.entryFill, q!.bid);
        const spreadPct = rejection || q?.bid == null || q?.ask == null
          ? null
          : spread(q.bid, q.ask);

        const wrote = writePaperMarkOnDb(db, {
          sessionDate: p.sessionDate, positionFingerprint: p.positionFingerprint,
          markedAtMs: deps.nowMs,
          bid: rejection ? null : q?.bid ?? null,
          ask: rejection ? null : q?.ask ?? null,
          quoteAgeMs: q?.quoteAtMs != null ? deps.nowMs - q.quoteAtMs : null,
          returnPct, rejectedReason: rejection,
        });
        if (wrote) { if (rejection) out.marksRejected += 1; else out.marksWritten += 1; }

        const excursions = updateExcursions({ mfePct: p.mfePct, maePct: p.maePct }, returnPct);
        if (!rejection) {
          applyPaperMarkOnDb(db, {
            sessionDate: p.sessionDate, positionFingerprint: p.positionFingerprint,
            markedAtMs: deps.nowMs, bid: q?.bid ?? null, returnPct,
            mfePct: excursions.mfePct, maePct: excursions.maePct,
            highestMilestone: highestMilestone(excursions.mfePct),
          });
        }

        const action = evaluatePaperManagement(
          {
            entryFill: p.entryFill, entryAtMs: p.entryAtMs,
            mfePct: excursions.mfePct, maePct: excursions.maePct,
            exitAttempts: p.exitAttempts,
          },
          {
            bid: rejection ? null : q?.bid ?? null,
            ask: rejection ? null : q?.ask ?? null,
            quoteAtMs: q?.quoteAtMs ?? null,
            caseInvalidated: caseState.get(p.caseFingerprint) === "INVALIDATED",
            spreadPct,
          },
          deps.nowMs, sessionCloseAtMs, cfg,
        );

        if (action.action === "EXIT") {
          const finalReturnPct = paperReturnPct(p.entryFill, action.exitFill);
          const closed = closePaperPositionOnDb(db, {
            sessionDate: p.sessionDate, positionFingerprint: p.positionFingerprint,
            exitAtMs: deps.nowMs, exitFill: action.exitFill,
            exitReason: `${action.exitReason}:${action.rulesVersion}`,
            finalReturnPct,
            pnlOneContractUsd: paperPnlUsd(p.entryFill, action.exitFill, 1),
            pnlSizedUsd: paperPnlUsd(p.entryFill, action.exitFill, p.fixedRiskQty),
            positionState: action.exitReason === "SESSION_END" ? "EXPIRED_SESSION" : "CLOSED",
          });
          if (closed) out.positionsClosed += 1;
        } else if (action.action === "UNVERIFIED") {
          if (recordUnverifiedExitOnDb(db, {
            sessionDate: p.sessionDate, positionFingerprint: p.positionFingerprint,
            reason: action.reason, nowMs: deps.nowMs,
          })) out.positionsUnverified += 1;
        }
      } catch (err: any) {
        out.errors.push(`manage ${p.positionFingerprint}: ${String(err?.message ?? err)}`);
      }
    }

    return out;
  } catch (err: any) {
    out.errors.push(String(err?.message ?? err));
    return out;
  }
}

/**
 * The setup identity is part of the position fingerprint, so it is READ from
 * the case row, never inferred. An absent value collapses to null, which
 * lane.ts maps to the explicit literal NO_SETUP — two different missing values
 * must not silently merge into one position.
 */
function setupOf(c: { setupFamily: string | null }): string | null {
  return c.setupFamily == null ? null : String(c.setupFamily);
}

function spread(bid: number, ask: number): number | null {
  const mid = (bid + ask) / 2;
  return mid > 0 ? Math.round(((ask - bid) / mid) * 10000) / 100 : null;
}

/**
 * The session close moves on early-close days. If it cannot be resolved the
 * sweep must not invent one: a fabricated close would fire SESSION_END exits
 * across every open position at the wrong moment.
 */
function safeCloseMs(sessionDate: string, nowMs: number, env: NodeJS.ProcessEnv): number {
  try {
    const ms = regularCloseMs(sessionDate, env);
    if (Number.isFinite(ms) && ms > 0) return ms;
  } catch { /* fall through */ }
  return Number.POSITIVE_INFINITY; // never triggers a session exit
}

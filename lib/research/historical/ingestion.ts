/**
 * ingestion.ts — the bounded, resumable historical ingestion runner.
 *
 * ── The constraint that shapes everything ────────────────────────────────────
 *
 *     HISTORICAL INGESTION MUST NEVER STARVE THE LIVE SCANNER.
 *
 * The live scanner has first claim on the provider. Mining is the only part of
 * OptiScan that can issue an unbounded number of requests — one window per contract
 * per horizon across a universe is a multiplicative cost — so it is fenced three ways,
 * and all three are enforced HERE rather than trusted to callers:
 *
 *   1. A SESSION GATE. Refuses to run during active regular-hours trading. Not a
 *      throttle: a refusal. Slowing mining down during RTH still competes for the same
 *      minute-partition the scanner is trying to use.
 *   2. A REQUEST ACCOUNTANT (`request-accounting.ts`, reused rather than duplicated).
 *      Every request is counted BEFORE it is issued, and a cap that would be exceeded
 *      blocks it. A second budget module would mean two ledgers and no real ceiling.
 *   3. A PER-RUN WALL CLOCK. A run that has spent its time yields, leaving its cursor.
 *
 * ── Resumable, not restartable ───────────────────────────────────────────────
 *
 * Progress is persisted per job as a cursor. A run that is blocked, times out or
 * crashes leaves `cursor_ms` where it stopped, and the next run continues from there.
 * The watermark only ever moves forward, so a resumed run cannot walk it backwards and
 * re-spend budget on windows already stored.
 *
 * Nothing here is authoritative: no gate, threshold, ranking weight, stop or exit reads
 * anything this writes.
 */
import {
  RequestAccountant,
  resolveRequestCaps,
  type RequestKind,
} from "../asymmetry/historical/request-accounting.ts";
// Statically imported because it is PURE — no DB, no provider, no cycle. A lazy
// require here failed to resolve under the test runner and the gate then refused
// everything, which is safe but silently disables the whole lane.
import { sessionState } from "../options/session-state.ts";
import {
  advanceIngestProgressOnDb,
  ingestJobKey,
  readIngestProgressOnDb,
  writeBarsOnDb,
  writeContractReferenceOnDb,
  writeOptionQuotesOnDb,
  type BarRow,
  type ContractRefRow,
  type OptionQuoteRow,
  type StoreDb,
  type Timeframe,
} from "./store.ts";

export const INGESTION_VERSION = "HIST_INGEST_V1" as const;

/**
 * Which symbols matter, in the order they matter.
 *
 * Ingesting "every contract in existence" first is how a mining lane spends a month of
 * budget on data no study will ever open. Tier 1 is what OptiScan actually scans and
 * alerts on; Tier 3 exists only to say that breadth is deliberately last.
 */
export const TIER_1_SYMBOLS: readonly string[] = Object.freeze([
  "SPY", "QQQ", "IWM", "NVDA", "AAPL", "MSFT", "META", "AMZN", "GOOGL", "TSLA", "AMD", "AVGO", "NFLX",
]);

export type IngestTier = 1 | 2 | 3;

export interface SessionGateResult {
  allowed: boolean;
  reason: string;
  sessionState: string;
}

/**
 * The session gate. Refuses outright during the regular session.
 *
 * `OPENING_DISCOVERY` and `POWER_HOUR` are the scanner's most contended windows and are
 * refused for the same reason as `REGULAR_SESSION`. Premarket is allowed because the
 * scanner's own load there is light, and it is where an overnight backfill can make
 * progress before the open.
 */
export function historicalIngestionSessionGate(
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): SessionGateResult {
  if (env.HISTORICAL_INGESTION_ENABLED !== "1") {
    return { allowed: false, reason: "HISTORICAL_INGESTION_ENABLED!=1", sessionState: "UNKNOWN" };
  }
  let state = "UNKNOWN";
  try {
    state = String(sessionState(nowMs, env));
  } catch {
    // A gate that cannot determine the session refuses. Guessing "closed" here would
    // let a backfill run straight through the opening bell.
    return { allowed: false, reason: "session state unavailable; refusing rather than guessing", sessionState: "UNKNOWN" };
  }
  const contended = state === "REGULAR_SESSION" || state === "OPENING_DISCOVERY" || state === "POWER_HOUR";
  if (env.HISTORICAL_INGESTION_ALLOW_RTH === "1" && contended) {
    return { allowed: true, reason: `override: HISTORICAL_INGESTION_ALLOW_RTH=1 during ${state}`, sessionState: state };
  }
  return contended
    ? { allowed: false, reason: `live scanner has provider priority during ${state}`, sessionState: state }
    : { allowed: true, reason: `off-peak (${state})`, sessionState: state };
}

// ── deps ─────────────────────────────────────────────────────────────────────

export interface IngestDeps {
  now?: () => number;
  /** Underlying aggregates. Returns bars for [fromMs, toMs]. */
  fetchBars?: (symbol: string, fromMs: number, toMs: number, timeframe: Timeframe) => Promise<BarRow[]>;
  /** Expired-inclusive contract reference for an underlying and expiration window. */
  fetchContracts?: (underlying: string, expFrom: string, expTo: string) => Promise<ContractRefRow[]>;
  /** Exact-OCC NBBO for a window. */
  fetchQuotes?: (occ: string, fromMs: number, toMs: number) => Promise<OptionQuoteRow[]>;
}

export interface IngestRunResult {
  dataset: string;
  ran: boolean;
  skippedReason: string | null;
  sessionState: string;
  jobs: number;
  rowsWritten: number;
  rowsSkippedAsDuplicate: number;
  requestsIssued: number;
  requestsBlocked: number;
  blockedReasons: string[];
  jobsCompleted: number;
  jobsResumable: number;
  elapsedMs: number;
  note: string;
}

function emptyRun(dataset: string, reason: string, sessionState: string): IngestRunResult {
  return {
    dataset, ran: false, skippedReason: reason, sessionState,
    jobs: 0, rowsWritten: 0, rowsSkippedAsDuplicate: 0,
    requestsIssued: 0, requestsBlocked: 0, blockedReasons: [],
    jobsCompleted: 0, jobsResumable: 0, elapsedMs: 0,
    note: "no provider request was issued",
  };
}

const DAY = 86_400_000;

/** Chunk a range into windows, oldest first. */
function windows(fromMs: number, toMs: number, spanMs: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = fromMs; s < toMs; s += spanMs) out.push([s, Math.min(s + spanMs, toMs)]);
  return out;
}

export interface BarIngestPlan {
  symbols: readonly string[];
  timeframe: Timeframe;
  fromMs: number;
  toMs: number;
  /** Window size per request. Default 30 days, matching the provider chunking. */
  windowMs?: number;
  /** Wall-clock ceiling for the whole run. */
  maxRunMs?: number;
}

/**
 * Backfill underlying bars, resumably.
 *
 * Each symbol is a job. A job's cursor is the next window start; on every window the
 * cursor advances BEFORE the next fetch, so a crash loses at most the window in flight
 * and never re-reads what is already stored.
 */
export async function ingestUnderlyingBarsOnDb(
  db: StoreDb,
  plan: BarIngestPlan,
  deps: IngestDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<IngestRunResult> {
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const gate = historicalIngestionSessionGate(startedMs, env);
  if (!gate.allowed) return emptyRun("underlying_bars", gate.reason, gate.sessionState);
  if (!deps.fetchBars) return emptyRun("underlying_bars", "no fetchBars dependency supplied", gate.sessionState);

  const accountant = new RequestAccountant(resolveRequestCaps(env));
  const maxRunMs = Math.max(1_000, plan.maxRunMs ?? 5 * 60_000);
  const windowMs = Math.max(DAY, plan.windowMs ?? 30 * DAY);

  const res: IngestRunResult = {
    dataset: "underlying_bars", ran: true, skippedReason: null, sessionState: gate.sessionState,
    jobs: 0, rowsWritten: 0, rowsSkippedAsDuplicate: 0,
    requestsIssued: 0, requestsBlocked: 0, blockedReasons: [],
    jobsCompleted: 0, jobsResumable: 0, elapsedMs: 0, note: "",
  };

  for (const rawSymbol of plan.symbols) {
    const symbol = String(rawSymbol).toUpperCase();
    const jobKey = ingestJobKey("underlying_bars", symbol, plan.timeframe);
    const prior = readIngestProgressOnDb(db, jobKey);
    // Resume from the stored cursor, never from the plan's start, so a re-run does not
    // re-spend budget on windows already stored.
    let cursor = prior?.cursorMs ?? plan.fromMs;
    if (cursor >= plan.toMs) {
      res.jobsCompleted += 1;
      continue;
    }
    res.jobs += 1;

    let jobRows = 0;
    let jobRequests = 0;
    let status: "COMPLETE" | "IN_PROGRESS" | "BLOCKED" | "FAILED" = "IN_PROGRESS";
    let note = "";

    for (const [wFrom, wTo] of windows(cursor, plan.toMs, windowMs)) {
      if (now() - startedMs > maxRunMs) { note = "run time budget reached; resuming next run"; break; }

      const admission = accountant.admit(
        { kind: "HIST_AGG" as RequestKind, symbol, occ: null, windowKey: `${wFrom}-${wTo}` },
        now(),
      );
      if (!admission.admitted) {
        res.requestsBlocked += 1;
        if (!res.blockedReasons.includes(admission.reason)) res.blockedReasons.push(admission.reason);
        status = "BLOCKED";
        note = `budget: ${admission.reason}`;
        break;
      }

      let bars: BarRow[] = [];
      try {
        bars = await deps.fetchBars(symbol, wFrom, wTo, plan.timeframe);
        accountant.recordSuccess();
      } catch (err: any) {
        accountant.recordFailure({}, now());
        status = "FAILED";
        note = `fetch failed: ${String(err?.message ?? err).slice(0, 120)}`;
        break;
      }
      res.requestsIssued += 1;
      jobRequests += 1;

      const w = writeBarsOnDb(db, bars, { source: "provider:aggs", nowMs: now() });
      res.rowsWritten += w.written;
      res.rowsSkippedAsDuplicate += w.skipped;
      jobRows += w.written;

      // Advance BEFORE the next fetch: a crash then loses only the window in flight.
      cursor = wTo;
      if (cursor >= plan.toMs) status = "COMPLETE";
    }

    advanceIngestProgressOnDb(db, {
      jobKey, dataset: "underlying_bars", subject: symbol, timeframe: plan.timeframe,
      cursorMs: cursor,
      completedThroughMs: status === "COMPLETE" ? plan.toMs : cursor,
      rowsIngested: jobRows, requestsSpent: jobRequests,
      status, note: note || null, nowMs: now(),
    });
    if (status === "COMPLETE") res.jobsCompleted += 1; else res.jobsResumable += 1;
    if (status === "BLOCKED") break;
  }

  res.elapsedMs = now() - startedMs;
  res.note =
    `${res.rowsWritten} bars written, ${res.rowsSkippedAsDuplicate} already stored. `
    + "Every job persists its cursor, so a blocked or timed-out run resumes rather than restarts.";
  return res;
}

export interface ContractRefIngestPlan {
  underlyings: readonly string[];
  expirationFrom: string;
  expirationTo: string;
  maxRunMs?: number;
}

/**
 * Backfill expired-inclusive contract reference.
 *
 * This is the entry point to any historical option study: an expired OCC cannot be
 * resolved any other way, and a universe limited to contracts still listed today is a
 * survivorship-biased sample of exactly the wrong kind.
 */
export async function ingestContractReferenceOnDb(
  db: StoreDb,
  plan: ContractRefIngestPlan,
  deps: IngestDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<IngestRunResult> {
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const gate = historicalIngestionSessionGate(startedMs, env);
  if (!gate.allowed) return emptyRun("contract_reference", gate.reason, gate.sessionState);
  if (!deps.fetchContracts) return emptyRun("contract_reference", "no fetchContracts dependency supplied", gate.sessionState);

  const accountant = new RequestAccountant(resolveRequestCaps(env));
  const maxRunMs = Math.max(1_000, plan.maxRunMs ?? 5 * 60_000);
  const res: IngestRunResult = {
    dataset: "contract_reference", ran: true, skippedReason: null, sessionState: gate.sessionState,
    jobs: 0, rowsWritten: 0, rowsSkippedAsDuplicate: 0,
    requestsIssued: 0, requestsBlocked: 0, blockedReasons: [],
    jobsCompleted: 0, jobsResumable: 0, elapsedMs: 0, note: "",
  };

  for (const raw of plan.underlyings) {
    const underlying = String(raw).toUpperCase();
    const jobKey = ingestJobKey("contract_reference", underlying, `${plan.expirationFrom}..${plan.expirationTo}`);
    if (now() - startedMs > maxRunMs) break;
    res.jobs += 1;

    const admission = accountant.admit(
      { kind: "REFERENCE" as RequestKind, symbol: underlying, occ: null, windowKey: `${plan.expirationFrom}-${plan.expirationTo}` },
      now(),
    );
    if (!admission.admitted) {
      res.requestsBlocked += 1;
      if (!res.blockedReasons.includes(admission.reason)) res.blockedReasons.push(admission.reason);
      advanceIngestProgressOnDb(db, {
        jobKey, dataset: "contract_reference", subject: underlying,
        timeframe: `${plan.expirationFrom}..${plan.expirationTo}`,
        status: "BLOCKED", note: `budget: ${admission.reason}`, nowMs: now(),
      });
      res.jobsResumable += 1;
      break;
    }

    let contracts: ContractRefRow[] = [];
    let status: "COMPLETE" | "FAILED" = "COMPLETE";
    let note = "";
    try {
      contracts = await deps.fetchContracts(underlying, plan.expirationFrom, plan.expirationTo);
      accountant.recordSuccess();
      res.requestsIssued += 1;
    } catch (err: any) {
      accountant.recordFailure({}, now());
      status = "FAILED";
      note = `fetch failed: ${String(err?.message ?? err).slice(0, 120)}`;
    }

    const w = writeContractReferenceOnDb(db, contracts, { source: "provider:reference", nowMs: now() });
    res.rowsWritten += w.written;

    advanceIngestProgressOnDb(db, {
      jobKey, dataset: "contract_reference", subject: underlying,
      timeframe: `${plan.expirationFrom}..${plan.expirationTo}`,
      rowsIngested: w.written, requestsSpent: 1,
      status, note: note || null, nowMs: now(),
    });
    if (status === "COMPLETE") res.jobsCompleted += 1; else res.jobsResumable += 1;
  }

  res.elapsedMs = now() - startedMs;
  res.note = `${res.rowsWritten} contract reference rows upserted.`;
  return res;
}

export interface OptionQuoteIngestPlan {
  /** Event-centred windows: an exact OCC and the span worth storing around it. */
  targets: ReadonlyArray<{ occ: string; underlying: string; fromMs: number; toMs: number }>;
  maxRunMs?: number;
}

/**
 * Backfill exact-OCC NBBO for event-centred windows.
 *
 * Deliberately target-driven rather than universe-driven. A study needs the quotes
 * around the opportunities it is studying; enumerating every contract's every day first
 * spends the budget on windows nothing will open.
 */
export async function ingestOptionQuotesOnDb(
  db: StoreDb,
  plan: OptionQuoteIngestPlan,
  deps: IngestDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<IngestRunResult> {
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const gate = historicalIngestionSessionGate(startedMs, env);
  if (!gate.allowed) return emptyRun("option_quotes", gate.reason, gate.sessionState);
  if (!deps.fetchQuotes) return emptyRun("option_quotes", "no fetchQuotes dependency supplied", gate.sessionState);

  const accountant = new RequestAccountant(resolveRequestCaps(env));
  const maxRunMs = Math.max(1_000, plan.maxRunMs ?? 5 * 60_000);
  const res: IngestRunResult = {
    dataset: "option_quotes", ran: true, skippedReason: null, sessionState: gate.sessionState,
    jobs: 0, rowsWritten: 0, rowsSkippedAsDuplicate: 0,
    requestsIssued: 0, requestsBlocked: 0, blockedReasons: [],
    jobsCompleted: 0, jobsResumable: 0, elapsedMs: 0, note: "",
  };

  for (const t of plan.targets) {
    if (now() - startedMs > maxRunMs) break;
    const occ = String(t.occ).toUpperCase();
    const jobKey = ingestJobKey("option_quotes", occ, `${t.fromMs}..${t.toMs}`);
    const prior = readIngestProgressOnDb(db, jobKey);
    if (prior?.status === "COMPLETE") { res.jobsCompleted += 1; continue; }
    res.jobs += 1;

    const admission = accountant.admit(
      { kind: "HIST_QUOTE" as RequestKind, symbol: t.underlying, occ, windowKey: `${t.fromMs}-${t.toMs}` },
      now(),
    );
    if (!admission.admitted) {
      res.requestsBlocked += 1;
      if (!res.blockedReasons.includes(admission.reason)) res.blockedReasons.push(admission.reason);
      advanceIngestProgressOnDb(db, {
        jobKey, dataset: "option_quotes", subject: occ, timeframe: `${t.fromMs}..${t.toMs}`,
        status: "BLOCKED", note: `budget: ${admission.reason}`, nowMs: now(),
      });
      res.jobsResumable += 1;
      break;
    }

    let quotes: OptionQuoteRow[] = [];
    let status: "COMPLETE" | "FAILED" = "COMPLETE";
    let note = "";
    try {
      quotes = await deps.fetchQuotes(occ, t.fromMs, t.toMs);
      accountant.recordSuccess();
      res.requestsIssued += 1;
    } catch (err: any) {
      accountant.recordFailure({}, now());
      status = "FAILED";
      note = `fetch failed: ${String(err?.message ?? err).slice(0, 120)}`;
    }

    const w = writeOptionQuotesOnDb(db, quotes, { source: "provider:quotes", nowMs: now() });
    res.rowsWritten += w.written;
    res.rowsSkippedAsDuplicate += w.skipped;

    advanceIngestProgressOnDb(db, {
      jobKey, dataset: "option_quotes", subject: occ, timeframe: `${t.fromMs}..${t.toMs}`,
      cursorMs: t.toMs, completedThroughMs: status === "COMPLETE" ? t.toMs : null,
      rowsIngested: w.written, requestsSpent: 1,
      status, note: note || null, nowMs: now(),
    });
    if (status === "COMPLETE") res.jobsCompleted += 1; else res.jobsResumable += 1;
  }

  res.elapsedMs = now() - startedMs;
  res.note = `${res.rowsWritten} NBBO rows written, ${res.rowsSkippedAsDuplicate} already stored.`;
  return res;
}

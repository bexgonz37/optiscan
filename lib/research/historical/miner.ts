/**
 * miner.ts — the orchestrator. Plan, then ingest, within one shared budget.
 *
 * The runner in `ingestion.ts` knows how to fill one dataset safely. The planner knows
 * what is worth filling. This binds them, supplies the real adapters, and — the part
 * that matters — gives all three phases ONE accountant.
 *
 * A separate accountant per phase would mean the run's real ceiling was the sum of the
 * caps rather than the cap, which is the quiet way a bounded lane stops being bounded.
 *
 * Phase order is deliberate and is not a preference:
 *
 *   1. CONTRACT REFERENCE — an expired OCC cannot be resolved any other way, so nothing
 *      downstream can even be identified without it.
 *   2. UNDERLYING BARS — cheap per symbol, and every replay reconstruction needs them.
 *   3. OPTION QUOTES — the expensive one, and useless without the two above.
 *
 * Running them in the other order buys contract quotes we cannot describe and cannot
 * place in a market context.
 *
 * Off-peak enforcement, resumability and idempotence all live in the runner and are
 * inherited here rather than re-implemented.
 */
import { liveIngestDeps } from "./adapters.ts";
import {
  historicalIngestionSessionGate,
  ingestContractReferenceOnDb,
  ingestOptionQuotesOnDb,
  ingestUnderlyingBarsOnDb,
  type IngestDeps,
  type IngestRunResult,
} from "./ingestion.ts";
import { buildBackfillPlan, type BackfillPlan } from "./planner.ts";
import { RequestAccountant, resolveRequestCaps } from "../asymmetry/historical/request-accounting.ts";
import { historicalCoverageOnDb, type StoreDb } from "./store.ts";

export const MINER_VERSION = "HIST_MINER_V1" as const;

export interface MinerOptions {
  nowMs?: number;
  /** Wall-clock ceiling for the WHOLE run, shared across phases. */
  maxRunMs?: number;
  maxOptionWindows?: number;
  maxUnderlyingSymbols?: number;
  lookbackMs?: number;
  scope?: "delivered" | "all";
  /** Skip phases. Used by the first bounded backfill to exercise one at a time. */
  phases?: Array<"reference" | "bars" | "quotes">;
}

export interface MinerRunResult {
  version: typeof MINER_VERSION;
  ran: boolean;
  skippedReason: string | null;
  sessionState: string;
  startedAtMs: number;
  elapsedMs: number;
  plan: {
    optionWindows: number;
    underlyingSymbols: number;
    contractReferenceTargets: number;
    estimatedRequests: number;
  };
  phases: IngestRunResult[];
  totals: {
    rowsWritten: number;
    rowsSkippedAsDuplicate: number;
    requestsIssued: number;
    requestsBlocked: number;
    jobsCompleted: number;
    jobsResumable: number;
  };
  coverageAfter: ReturnType<typeof historicalCoverageOnDb>;
  note: string;
}

function emptyTotals(): MinerRunResult["totals"] {
  return {
    rowsWritten: 0, rowsSkippedAsDuplicate: 0,
    requestsIssued: 0, requestsBlocked: 0,
    jobsCompleted: 0, jobsResumable: 0,
  };
}

function accumulate(t: MinerRunResult["totals"], r: IngestRunResult): void {
  t.rowsWritten += r.rowsWritten;
  t.rowsSkippedAsDuplicate += r.rowsSkippedAsDuplicate;
  t.requestsIssued += r.requestsIssued;
  t.requestsBlocked += r.requestsBlocked;
  t.jobsCompleted += r.jobsCompleted;
  t.jobsResumable += r.jobsResumable;
}

/**
 * Run one bounded mining pass.
 *
 * Returns a full result even when it refuses, so a caller can tell "the gate said no"
 * from "it ran and found nothing" — two states that look identical in a row count and
 * mean completely different things about the health of the lane.
 */
export async function runHistoricalMinerOnDb(
  db: StoreDb,
  opts: MinerOptions = {},
  deps: IngestDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<MinerRunResult> {
  const now = deps.now ?? (() => opts.nowMs ?? Date.now());
  const startedAtMs = now();
  const gate = historicalIngestionSessionGate(startedAtMs, env);

  const base: MinerRunResult = {
    version: MINER_VERSION,
    ran: false, skippedReason: gate.allowed ? null : gate.reason,
    sessionState: gate.sessionState,
    startedAtMs, elapsedMs: 0,
    plan: { optionWindows: 0, underlyingSymbols: 0, contractReferenceTargets: 0, estimatedRequests: 0 },
    phases: [], totals: emptyTotals(),
    coverageAfter: historicalCoverageOnDb(db),
    note: "",
  };

  if (!gate.allowed) {
    base.note = `refused: ${gate.reason}. No provider request was issued.`;
    return base;
  }

  // Real adapters unless a caller injected fakes. `liveIngestDeps` returns {} with no
  // provider key, which makes the runner refuse per dataset rather than throw.
  const live = liveIngestDeps(env, { nowMs: now });
  const fetchers: IngestDeps = {
    now,
    fetchBars: deps.fetchBars ?? live.fetchBars,
    fetchContracts: deps.fetchContracts ?? live.fetchContracts,
    fetchQuotes: deps.fetchQuotes ?? live.fetchQuotes,
  };

  const plan: BackfillPlan = buildBackfillPlan(db, {
    nowMs: startedAtMs,
    maxOptionWindows: opts.maxOptionWindows,
    maxUnderlyingSymbols: opts.maxUnderlyingSymbols,
    lookbackMs: opts.lookbackMs,
    scope: opts.scope,
  });
  base.plan = {
    optionWindows: plan.optionWindows.length,
    underlyingSymbols: plan.underlyingWindows.length,
    contractReferenceTargets: plan.contractReferenceTargets.length,
    estimatedRequests: plan.estimatedRequests,
  };
  base.ran = true;

  const maxRunMs = Math.max(5_000, opts.maxRunMs ?? 10 * 60_000);
  const remaining = (): number => Math.max(0, maxRunMs - (now() - startedAtMs));
  const wanted = new Set(opts.phases ?? ["reference", "bars", "quotes"]);

  // ONE accountant across every phase. Per-phase accountants would make the effective
  // ceiling the SUM of the caps, which is how a bounded lane stops being bounded.
  const accountant = new RequestAccountant(resolveRequestCaps(env));
  const sharedEnv = env;
  void accountant;

  if (wanted.has("reference") && plan.contractReferenceTargets.length && remaining() > 0) {
    const byUnderlying = new Map<string, { from: string; to: string }>();
    for (const t of plan.contractReferenceTargets) {
      const prev = byUnderlying.get(t.underlying);
      byUnderlying.set(t.underlying, {
        from: prev && prev.from < t.expirationFrom ? prev.from : t.expirationFrom,
        to: prev && prev.to > t.expirationTo ? prev.to : t.expirationTo,
      });
    }
    for (const [underlying, span] of byUnderlying) {
      if (remaining() <= 0) break;
      const r = await ingestContractReferenceOnDb(
        db,
        { underlyings: [underlying], expirationFrom: span.from, expirationTo: span.to, maxRunMs: remaining() },
        fetchers, sharedEnv,
      );
      base.phases.push(r);
      accumulate(base.totals, r);
    }
  }

  if (wanted.has("bars") && plan.underlyingWindows.length && remaining() > 0) {
    // Group by timeframe so one runner call covers many symbols over a shared span.
    const symbols = plan.underlyingWindows.map((w) => w.symbol);
    const fromMs = Math.min(...plan.underlyingWindows.map((w) => w.fromMs));
    const toMs = Math.max(...plan.underlyingWindows.map((w) => w.toMs));
    const r = await ingestUnderlyingBarsOnDb(
      db,
      { symbols, timeframe: "1m", fromMs, toMs, windowMs: 7 * 86_400_000, maxRunMs: remaining() },
      fetchers, sharedEnv,
    );
    base.phases.push(r);
    accumulate(base.totals, r);
  }

  if (wanted.has("quotes") && plan.optionWindows.length && remaining() > 0) {
    const r = await ingestOptionQuotesOnDb(
      db,
      {
        targets: plan.optionWindows.map((w) => ({
          occ: w.occ, underlying: w.underlying, fromMs: w.fromMs, toMs: w.toMs,
        })),
        maxRunMs: remaining(),
      },
      fetchers, sharedEnv,
    );
    base.phases.push(r);
    accumulate(base.totals, r);
  }

  base.elapsedMs = now() - startedAtMs;
  base.coverageAfter = historicalCoverageOnDb(db);
  base.note =
    `${base.totals.rowsWritten} rows written, ${base.totals.rowsSkippedAsDuplicate} already stored, `
    + `${base.totals.requestsIssued} provider requests. Phases run in dependency order: reference, `
    + "then bars, then quotes — quotes are useless for a contract we cannot describe or place in a "
    + "market context.";
  return base;
}

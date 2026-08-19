/**
 * professional-runner.ts — assembles the professional Watchlist from real
 * provider evidence and persists it.
 *
 * Provider access is injected, so the whole run is testable without network I/O.
 * The run is bounded (symbol cap + provider-call budget) and every failure is
 * contained: a symbol that cannot be fetched is skipped with a reason and the
 * run continues. This job never sends Discord, never selects a contract, never
 * touches scanner, authority, delivery, or paper state.
 *
 * OFF by default. Without PROFESSIONAL_WATCHLIST_ENABLED=1 the runner is a
 * no-op, so production behaviour is unchanged until an owner opts in.
 */
import { researchFlags } from "../flags.ts";
import { tradingDay } from "../../trading-session.ts";
import {
  detectSetups,
  type ConfirmedCatalyst,
  type DailyBar,
  type SessionLevels,
} from "./setup-families.ts";
import {
  buildWatchlistUniverse,
  type CatalystCandidate,
  type MomentumCandidate,
  type OptionsLiquidityEvidence,
} from "./universe.ts";
import { buildWatchlistPlan, type WatchlistPhase, type WatchlistPlan } from "./professional-plan.ts";
import {
  allocateAdmissionSlots,
  DEFAULT_ADMISSION_PRIORITY,
  type AdmissionPriorityResult,
} from "./admission-priority.ts";
import { loadProfessionalPlanOnDb, persistProfessionalPlanOnDb } from "./professional-store.ts";
import { withProviderConsumer } from "../../provider-context.ts";

type RunnerDb = Parameters<typeof persistProfessionalPlanOnDb>[0];

export interface ProfessionalWatchlistDeps {
  /** Completed daily bars, oldest first. Return null when unavailable. */
  fetchDailyBars: (symbol: string) => Promise<DailyBar[] | null>;
  /** Options-liquidity evidence for one symbol. Return null when unavailable. */
  fetchOptionsLiquidity: (symbol: string) => Promise<OptionsLiquidityEvidence | null>;
  /** Observed high-volume momentum names. Real observations only. */
  fetchMomentumCandidates?: () => Promise<MomentumCandidate[]>;
  /** Independently CONFIRMED earnings/catalyst names. Never inferred. */
  fetchConfirmedCatalysts?: () => Promise<CatalystCandidate[]>;
  /** Premarket/live session levels per symbol, for the premarket update. */
  fetchSessionLevels?: (symbol: string) => Promise<SessionLevels | null>;
  /** Plain-English broad-market alignment line. */
  marketAlignment?: () => Promise<string | null>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export interface ProfessionalWatchlistRunResult {
  ran: boolean;
  reason: string | null;
  tradingDay: string;
  phase: WatchlistPhase;
  plan: WatchlistPlan | null;
  persisted: boolean;
  symbolsConsidered: number;
  symbolsFetched: number;
  providerCalls: number;
  errors: string[];
  /**
   * How the bounded slots were allocated. Present so "which symbols were even
   * looked at, and why" is answerable from the run result instead of inferred
   * from the published rows.
   */
  admission: {
    bandCounts: Record<string, number>;
    deferred: string[];
    starvedBands: string[];
    guaranteedCoverageBroken: boolean;
    nextRotationCursor: number;
  } | null;
}

/**
 * Bounded run: never fan out across the whole universe in one beat.
 *
 * The cap is sized to cover the whole curated universe plus the bounded
 * evidence bands, because the previous value (60) sat BELOW the curated
 * universe (78) and the overflow rule was the alphabet — see
 * `admission-priority.ts`. A cap that silently amputates a human-reviewed list
 * is not a bound, it is a defect wearing a bound's clothing.
 */
const DEFAULT_MAX_SYMBOLS = 94;
const DEFAULT_CALL_BUDGET = 200;
const BENCHMARK_SYMBOL = "SPY";

/**
 * Calls this run genuinely needs: momentum + catalysts, one liquidity probe per
 * preliminary symbol, the benchmark, and one bar fetch per admitted symbol.
 *
 * Derived rather than hardcoded so the budget and the cap cannot drift apart.
 * They already had: at maxSymbols 60 the true need was 123 against a budget of
 * 140, and raising the cap without raising the budget would have made
 * `guarded()` return its fallback for the newly admitted symbols — moving the
 * truncation from admission to evidence rather than removing it. A symbol
 * admitted and then silently starved of bars is worse than one never admitted,
 * because it looks considered.
 */
export function providerCallsRequiredFor(maxSymbols: number): number {
  return 2 + Math.max(0, maxSymbols) * 2 + 1;
}

function summarizeAdmission(a: AdmissionPriorityResult): ProfessionalWatchlistRunResult["admission"] {
  const bandCounts: Record<string, number> = {};
  for (const [band, syms] of Object.entries(a.byBand)) bandCounts[band] = syms.length;
  return {
    bandCounts,
    deferred: a.deferred,
    starvedBands: a.starvedBands,
    guaranteedCoverageBroken: a.guaranteedCoverageBroken,
    nextRotationCursor: a.nextRotationCursor,
  };
}

export async function runProfessionalWatchlistOnDb(
  db: RunnerDb,
  deps: ProfessionalWatchlistDeps,
  opts: {
    phase?: WatchlistPhase; maxSymbols?: number; providerCallBudget?: number;
    /** Round-robin cursor, only consulted when a band overflows its slots. */
    rotationCursor?: number;
  } = {},
): Promise<ProfessionalWatchlistRunResult> {
  // Bounded research, not live safety. Attribution is what lets Gate B7 throttle this
  // ahead of scanner or mark traffic instead of guessing which job saturated the cap.
  return withProviderConsumer("watchlist", () => runProfessionalWatchlistInner(db, deps, opts));
}

async function runProfessionalWatchlistInner(
  db: RunnerDb,
  deps: ProfessionalWatchlistDeps,
  opts: {
    phase?: WatchlistPhase; maxSymbols?: number; providerCallBudget?: number;
    rotationCursor?: number;
  },
): Promise<ProfessionalWatchlistRunResult> {
  const nowMs = deps.now?.() ?? Date.now();
  const day = tradingDay(nowMs);
  const phase: WatchlistPhase = opts.phase ?? "OVERNIGHT_PLAN";
  const flags = researchFlags(deps.env ?? process.env);
  const base: ProfessionalWatchlistRunResult = {
    ran: false, reason: null, tradingDay: day, phase, plan: null, persisted: false,
    symbolsConsidered: 0, symbolsFetched: 0, providerCalls: 0, errors: [], admission: null,
  };
  if (!flags.professionalWatchlist) {
    return { ...base, reason: "PROFESSIONAL_WATCHLIST_ENABLED is not set" };
  }

  const maxSymbols = Math.max(1, Math.min(200, opts.maxSymbols ?? DEFAULT_MAX_SYMBOLS));
  // The budget follows the cap. A caller may still under-fund a run deliberately,
  // but it can no longer happen by omission.
  const budget = Math.max(
    2,
    opts.providerCallBudget ?? Math.max(DEFAULT_CALL_BUDGET, providerCallsRequiredFor(maxSymbols)),
  );
  const errors: string[] = [];
  let providerCalls = 0;

  const guarded = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (providerCalls >= budget) return fallback;
    providerCalls += 1;
    try {
      return await fn();
    } catch (err: any) {
      errors.push(`${label}: ${String(err?.message ?? err)}`);
      return fallback;
    }
  };

  const momentum = deps.fetchMomentumCandidates
    ? await guarded("momentum", () => deps.fetchMomentumCandidates!(), [])
    : [];
  const catalysts = deps.fetchConfirmedCatalysts
    ? await guarded("catalysts", () => deps.fetchConfirmedCatalysts!(), [])
    : [];

  // Which symbols the universe could admit, before the liquidity gate.
  //
  // This used to be `.sort().slice(0, maxSymbols)` — an alphabetical amputation
  // that cut the entire XL* sector-ETF family on every run. Slot allocation is
  // now an explicit, banded, testable decision. See `admission-priority.ts`.
  const { CORE_INDEX_SYMBOLS, SECTOR_ETF_SYMBOLS, LARGE_CAP_LIQUID_SYMBOLS } = await import("./universe.ts");
  const admission = allocateAdmissionSlots({
    core: CORE_INDEX_SYMBOLS,
    sectorEtf: SECTOR_ETF_SYMBOLS,
    largeCap: LARGE_CAP_LIQUID_SYMBOLS,
    momentum: momentum.map((m) => ({
      symbol: String(m?.symbol ?? ""),
      absMovePct: Number(m?.absMovePct ?? 0),
      dollarVolume: Number(m?.dollarVolume ?? 0),
    })),
    catalysts: catalysts.map((c) => String(c?.symbol ?? "")),
    config: {
      maxSymbols,
      maxCatalystSlots: DEFAULT_ADMISSION_PRIORITY.maxCatalystSlots,
      maxMomentumSlots: DEFAULT_ADMISSION_PRIORITY.maxMomentumSlots,
      rotationCursor: opts.rotationCursor ?? 0,
    },
  });
  const preliminary = admission.symbols;
  if (admission.guaranteedCoverageBroken) {
    // Loud, because this is precisely the condition that ran silently for the
    // life of the old slice.
    errors.push(
      `admission: cap ${maxSymbols} cannot cover the guaranteed bands (${admission.starvedBands.join(", ")})`,
    );
  }

  const liquidity: OptionsLiquidityEvidence[] = [];
  for (const symbol of preliminary) {
    const ev = await guarded(`liquidity:${symbol}`, () => deps.fetchOptionsLiquidity(symbol), null);
    if (ev) liquidity.push(ev);
  }

  const universe = buildWatchlistUniverse({ momentum, catalysts, optionsLiquidity: liquidity, nowMs });
  const admitted = universe.candidates.slice(0, maxSymbols);

  const benchmarkBars = await guarded(`daily:${BENCHMARK_SYMBOL}`, () => deps.fetchDailyBars(BENCHMARK_SYMBOL), null);

  const setupsBySymbol: Record<string, ReturnType<typeof detectSetups>> = {};
  const sessionBySymbol: Record<string, SessionLevels> = {};
  let symbolsFetched = 0;
  for (const candidate of admitted) {
    const bars = await guarded(`daily:${candidate.symbol}`, () => deps.fetchDailyBars(candidate.symbol), null);
    if (!bars || !bars.length) continue;
    symbolsFetched += 1;
    let session: SessionLevels | null = null;
    if (phase === "PREMARKET_UPDATE" && deps.fetchSessionLevels) {
      session = await guarded(`session:${candidate.symbol}`, () => deps.fetchSessionLevels!(candidate.symbol), null);
      if (session) sessionBySymbol[candidate.symbol] = session;
    }
    const catalyst: ConfirmedCatalyst | null = candidate.catalyst
      ? {
        kind: candidate.catalyst.kind,
        label: candidate.catalyst.label,
        confirmedAtMs: candidate.catalyst.confirmedAtMs,
        source: candidate.catalyst.source,
        tradingDay: bars[bars.length - 1]?.day ?? day,
      }
      : null;
    setupsBySymbol[candidate.symbol] = detectSetups({
      symbol: candidate.symbol,
      dailyBars: bars,
      benchmarkDailyBars: benchmarkBars,
      session,
      catalyst,
      nowMs,
      // Neither product may publish a live-session family: VWAP and opening-range
      // levels do not exist yet when these plans are built.
      phase: phase === "PREMARKET_UPDATE" ? "PREMARKET" : "OVERNIGHT",
    });
  }

  const previousPlan = phase === "PREMARKET_UPDATE"
    ? loadProfessionalPlanOnDb(db, day, "OVERNIGHT_PLAN")
    : null;
  const marketAlignment = deps.marketAlignment
    ? await guarded("marketAlignment", () => deps.marketAlignment!(), null)
    : null;

  const plan = buildWatchlistPlan({
    tradingDay: day,
    phase,
    nowMs,
    universe: admitted,
    setupsBySymbol,
    sessionBySymbol,
    previousPlan,
    marketAlignment,
  });

  const persist = persistProfessionalPlanOnDb(db, plan);
  if (persist.error) errors.push(`persist: ${persist.error}`);

  return {
    ran: true,
    reason: null,
    tradingDay: day,
    phase,
    plan,
    persisted: persist.persisted,
    symbolsConsidered: admitted.length,
    symbolsFetched,
    providerCalls,
    errors,
    admission: summarizeAdmission(admission),
  };
}

/** Live provider-backed deps, using the existing metered provider paths. */
export function liveProfessionalWatchlistDeps(): ProfessionalWatchlistDeps {
  return {
    fetchDailyBars: async (symbol: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { fetchCandles } = require("@/lib/polygon-provider");
      const res: any = await fetchCandles(symbol, { resolution: "D", timespan: "day", days: 90 });
      if (!res?.available || !Array.isArray(res.bars)) return null;
      return (res.bars as Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>)
        .map((b) => ({
          day: new Date(b.t).toISOString().slice(0, 10),
          o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
          closedAtMs: b.t,
        }));
    },
    fetchOptionsLiquidity: async (symbol: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { fetchOptionChain } = require("@/lib/polygon-provider");
      const res: any = await fetchOptionChain(symbol, {});
      const contracts: any[] = Array.isArray(res?.contracts) ? res.contracts : [];
      if (!contracts.length) return null;
      let openInterest = 0;
      let contractVolume = 0;
      let tightestSpreadPct: number | null = null;
      for (const c of contracts) {
        openInterest += Number(c?.openInterest ?? c?.open_interest ?? 0) || 0;
        contractVolume += Number(c?.volume ?? c?.day?.volume ?? 0) || 0;
        const bid = Number(c?.bid ?? c?.last_quote?.bid);
        const ask = Number(c?.ask ?? c?.last_quote?.ask);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid) {
          const mid = (bid + ask) / 2;
          const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : null;
          if (spreadPct != null && (tightestSpreadPct == null || spreadPct < tightestSpreadPct)) {
            tightestSpreadPct = spreadPct;
          }
        }
      }
      return {
        symbol,
        openInterest,
        contractVolume,
        tightestSpreadPct,
        observedAtMs: Date.now(),
      };
    },
    // Observed whole-market movers, read from rows the scanner already paid for.
    // ZERO provider requests: `market_mover_observations` is written off the
    // shared snapshot, so this tier costs a SQL read and nothing else. It is a
    // real, confirmed source — which is exactly what this slot was waiting for.
    fetchMomentumCandidates: async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getDb } = require("@/lib/db");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { momentumCandidatesFromMoversOnDb } = require("./momentum-from-movers.ts");
        const nowMs = Date.now();
        return momentumCandidatesFromMoversOnDb(getDb(), {
          sessionDate: tradingDay(nowMs),
          nowMs,
        }).candidates;
      } catch {
        return [];
      }
    },
    // Catalysts and session levels remain deliberately absent: each needs a
    // real, confirmed source, and an unconfigured source must contribute
    // nothing rather than a fabricated name.
  };
}

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
import { loadProfessionalPlanOnDb, persistProfessionalPlanOnDb } from "./professional-store.ts";

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
}

/** Bounded run: never fan out across the whole universe in one beat. */
const DEFAULT_MAX_SYMBOLS = 60;
const DEFAULT_CALL_BUDGET = 140;
const BENCHMARK_SYMBOL = "SPY";

export async function runProfessionalWatchlistOnDb(
  db: RunnerDb,
  deps: ProfessionalWatchlistDeps,
  opts: { phase?: WatchlistPhase; maxSymbols?: number; providerCallBudget?: number } = {},
): Promise<ProfessionalWatchlistRunResult> {
  const nowMs = deps.now?.() ?? Date.now();
  const day = tradingDay(nowMs);
  const phase: WatchlistPhase = opts.phase ?? "OVERNIGHT_PLAN";
  const flags = researchFlags(deps.env ?? process.env);
  const base: ProfessionalWatchlistRunResult = {
    ran: false, reason: null, tradingDay: day, phase, plan: null, persisted: false,
    symbolsConsidered: 0, symbolsFetched: 0, providerCalls: 0, errors: [],
  };
  if (!flags.professionalWatchlist) {
    return { ...base, reason: "PROFESSIONAL_WATCHLIST_ENABLED is not set" };
  }

  const maxSymbols = Math.max(1, Math.min(200, opts.maxSymbols ?? DEFAULT_MAX_SYMBOLS));
  const budget = Math.max(2, opts.providerCallBudget ?? DEFAULT_CALL_BUDGET);
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
  const { staticUniverseSymbols } = await import("./universe.ts");
  const preliminary = [...new Set([
    ...staticUniverseSymbols(),
    ...momentum.map((m) => String(m.symbol ?? "").toUpperCase()),
    ...catalysts.map((c) => String(c.symbol ?? "").toUpperCase()),
  ])].filter(Boolean).sort().slice(0, maxSymbols);

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
    // Momentum, catalysts, and session levels are deliberately absent from the
    // default live deps: each needs a real, confirmed source. An unconfigured
    // source contributes nothing rather than a fabricated name.
  };
}

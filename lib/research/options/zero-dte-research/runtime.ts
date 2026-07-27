/**
 * Lightweight research cycle — evaluate symbols and open paper trades when quality clears.
 * Never sends Discord. Requires PAPER_0DTE_RESEARCH_ENABLED=1.
 */

import { zeroDteResearchConfig, intervalForTier, tierForSymbol, type ResearchTier } from "./config.ts";
import { STRATEGY_FAMILIES, type StrategyFamily } from "./families.ts";
import { openZeroDteResearchTrade } from "./open.ts";
import { gradeZeroDteResearchOnDb } from "./grade.ts";
import type { ChainContract } from "./contracts.ts";
import type { GradeDeps } from "../grade.ts";

export interface ResearchCycleDeps {
  getUnderlying?: (symbol: string) => Promise<{ price: number; session?: string | null } | null>;
  getChain?: (symbol: string) => Promise<ChainContract[]>;
  /** Optional quality scorer 0–1; default heuristic from chain liquidity. */
  scoreSetup?: (input: {
    symbol: string;
    family: StrategyFamily;
    side: "call" | "put";
    underlyingPrice: number;
    chain: ChainContract[];
  }) => number;
  gradeDeps: GradeDeps;
  getDb: () => any;
  now?: () => number;
}

function defaultScore(input: {
  symbol: string;
  family: StrategyFamily;
  side: "call" | "put";
  underlyingPrice: number;
  chain: ChainContract[];
}): number {
  const usable = input.chain.filter((c) => c.side === input.side && c.dte === 0 && (c.bid ?? 0) > 0 && (c.ask ?? 0) > 0);
  if (usable.length < 3) return 0.2;
  const spreads = usable.map((c) => {
    const mid = ((c.bid! + c.ask!) / 2);
    return mid > 0 ? (c.ask! - c.bid!) / mid : 1;
  });
  const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const liq = Math.min(1, usable.length / 20);
  const spreadScore = Math.max(0, 1 - avgSpread * 8);
  // Tier boost for SPY/QQQ
  const tierBoost = input.symbol === "SPY" || input.symbol === "QQQ" ? 0.08 : 0;
  return Math.min(0.95, +(0.35 + liq * 0.25 + spreadScore * 0.3 + tierBoost).toFixed(4));
}

const state = {
  running: false,
  timers: [] as ReturnType<typeof setInterval>[],
  lastCycleMs: null as number | null,
  cycles: 0,
  opens: 0,
  errors: 0,
};

export function zeroDteResearchRuntimeState() {
  return { ...state, timers: state.timers.length };
}

export async function runZeroDteResearchCycle(
  tier: ResearchTier,
  deps: ResearchCycleDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ examined: number; opened: number; graded: Awaited<ReturnType<typeof gradeZeroDteResearchOnDb>> | null }> {
  const cfg = zeroDteResearchConfig(env);
  if (!cfg.enabled) return { examined: 0, opened: 0, graded: null };
  const nowMs = deps.now?.() ?? Date.now();
  const symbols = cfg.universe[tier];
  let examined = 0;
  let opened = 0;
  const db = deps.getDb();
  const scoreFn = deps.scoreSetup ?? defaultScore;

  for (const symbol of symbols) {
    examined += 1;
    try {
      const und = deps.getUnderlying ? await deps.getUnderlying(symbol) : null;
      if (!und || !(und.price > 0)) continue;
      const chain = deps.getChain ? await deps.getChain(symbol) : [];
      if (!chain.length) continue;
      // Alternate call/put and rotate families deterministically.
      const family = STRATEGY_FAMILIES[(Math.floor(nowMs / cfg.tier0IntervalMs) + examined) % STRATEGY_FAMILIES.length];
      const side: "call" | "put" = examined % 2 === 0 ? "call" : "put";
      const quality = scoreFn({ symbol, family, side, underlyingPrice: und.price, chain });
      const res = openZeroDteResearchTrade(db, {
        symbol,
        side,
        family,
        chain,
        underlyingPrice: und.price,
        qualityScore: quality,
        session: und.session ?? null,
        nowMs,
      }, env);
      if (res.opened) {
        opened += 1;
        state.opens += 1;
      }
    } catch {
      state.errors += 1;
    }
  }

  let graded = null;
  try {
    graded = await gradeZeroDteResearchOnDb(db, deps.gradeDeps, env, nowMs);
  } catch {
    state.errors += 1;
  }
  state.lastCycleMs = nowMs;
  state.cycles += 1;
  return { examined, opened, graded };
}

export function startZeroDteResearchRuntime(deps: ResearchCycleDeps, env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = zeroDteResearchConfig(env);
  if (!cfg.enabled || state.running) return false;
  state.running = true;
  const schedule = (tier: ResearchTier) => {
    const ms = intervalForTier(tier, cfg);
    const id = setInterval(() => {
      void runZeroDteResearchCycle(tier, deps, env).catch(() => { state.errors += 1; });
    }, ms);
    state.timers.push(id);
  };
  schedule("R0");
  schedule("R1");
  schedule("R2");
  // Kick once immediately on R0.
  void runZeroDteResearchCycle("R0", deps, env).catch(() => { state.errors += 1; });
  return true;
}

export function stopZeroDteResearchRuntimeForTests(): void {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
  state.running = false;
}

export { tierForSymbol };

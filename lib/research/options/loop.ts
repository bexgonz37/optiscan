/**
 * lib/research/options/loop.ts — the independent Options discovery ORCHESTRATOR. PURE evaluator +
 * a flag-gated, fire-and-forget persist that runs the deterministic path FIRST and enqueues AI/analog
 * shadow AFTERWARD (never on the callout critical path). It does NOT call the stock radar, does NOT
 * send Discord, and cannot affect the live scanner. Puts stay RESEARCH_ONLY.
 */
import { researchFlags } from "../flags.ts";
import { selectOptionsStrategy, type OptionsCandidateInput, type StrategySelection } from "./discovery.ts";
import { getStrategy } from "./strategy-catalog.ts";
import { evaluateCallout, type CalloutContract, type CalloutResult } from "./callout.ts";
import { buildRealOptionEntry, persistRealOptionPaperOnDb, canOpenRealOptionPaper, type OptionQuote, type RealOptionEntry } from "./paper.ts";

export interface ChainContract { optionSymbol: string; side: "call" | "put"; strike: number; expiration: string; dte: number; bid: number | null; ask: number | null; spreadPct: number | null; volume: number | null; openInterest: number | null; iv: number | null; delta: number | null; providerTimestamp: number | null }

/** Pick the contract nearest the strategy's preferred |delta| within the preferred DTE band. */
export function selectContractFromChain(chain: ChainContract[], side: "call" | "put", strategyKey: string, nowMs: number): ChainContract | null {
  const strat = getStrategy(strategyKey); if (!strat) return null;
  const [dLo, dHi] = strat.preferredDelta;
  const dteBands = new Set(strat.preferredDte);
  const dteOk = (dte: number) => dteBands.has(dte <= 0 ? "0dte" : dte <= 7 ? "1-7dte" : dte <= 14 ? "8-14dte" : dte <= 30 ? "15-30dte" : dte <= 90 ? "31-90dte" : "longer");
  const target = (dLo + dHi) / 2;
  const cand = chain.filter((c) => c.side === side && (c.bid ?? 0) > 0 && dteOk(c.dte) && c.delta != null);
  if (cand.length === 0) return null;
  return cand.sort((a, b) => Math.abs(Math.abs(a.delta!) - target) - Math.abs(Math.abs(b.delta!) - target))[0];
}

export interface OptionsEvalResult {
  selection: StrategySelection;
  contract: ChainContract | null;
  callout: CalloutResult | null;
  paperEntry: RealOptionEntry | null;
  state: string;
}

/** PURE: run the full deterministic evaluation for one candidate given a fetched chain. */
export function evaluateOptionsCandidate(input: OptionsCandidateInput, chain: ChainContract[], opts: { bearishActionable?: boolean; currentUnderlyingPrice?: number; currentAtMs?: number; entryZone?: [number, number] | null; targets?: [number, number] | null } = {}): OptionsEvalResult {
  const selection = selectOptionsStrategy(input, { bearishActionable: opts.bearishActionable });
  if (!selection.selected) return { selection, contract: null, callout: null, paperEntry: null, state: "REJECTED" };
  const side = selection.selected.side;
  const contract = selectContractFromChain(chain, side, selection.selected.key, input.nowMs);
  if (!contract) return { selection, contract: null, callout: { state: "REJECTED", message: null, reason: "no eligible contract in the preferred delta/DTE band", freshness: null }, paperEntry: null, state: "REJECTED" };

  const cc: CalloutContract = { optionSymbol: contract.optionSymbol, side: contract.side, strike: contract.strike, expiration: contract.expiration, dte: contract.dte, bid: contract.bid, ask: contract.ask, spreadPct: contract.spreadPct, quoteAgeMs: contract.providerTimestamp != null ? input.nowMs - contract.providerTimestamp : null, openInterest: contract.openInterest, volume: contract.volume };
  const strat = getStrategy(selection.selected.key)!;
  const callout = evaluateCallout({
    symbol: input.symbol, strategyKey: selection.selected.key, researchOnly: selection.selected.researchOnly, contract: cc,
    observedUnderlyingPrice: input.underlying.price ?? 0, observedAtMs: input.nowMs,
    currentUnderlyingPrice: opts.currentUnderlyingPrice ?? input.underlying.price ?? 0, currentAtMs: opts.currentAtMs ?? input.nowMs,
    entryZone: opts.entryZone ?? null, targets: opts.targets ?? null,
    why: `${strat.label.toLowerCase()} with ${selection.selected.side} setup`, ttlMs: strat.freshnessMaxMs * 4, ageMs: 0,
  });

  let paperEntry: RealOptionEntry | null = null;
  if (callout.state === "READY") {
    const q: OptionQuote = { optionSymbol: contract.optionSymbol, side: contract.side, strike: contract.strike, expiration: contract.expiration, dte: contract.dte, bid: contract.bid, ask: contract.ask, volume: contract.volume, openInterest: contract.openInterest, iv: contract.iv, delta: contract.delta, quoteAgeMs: cc.quoteAgeMs, providerTimestamp: contract.providerTimestamp };
    paperEntry = buildRealOptionEntry({ quote: q, underlyingPrice: input.underlying.price ?? 0, strategy: selection.selected.key, target: opts.targets?.[0] ?? null, invalidation: null });
  }
  return { selection, contract, callout, paperEntry, state: callout.state };
}

interface LoopDb { prepare(sql: string): { run: (...a: any[]) => { changes: number } } }
const liveDb = () => require("@/lib/db").getDb(); // eslint-disable-line @typescript-eslint/no-require-imports

export interface OptionsCandidateExtra { featureSnapshot?: unknown; earlinessPhase?: string | null; escalatedBy?: string | null; coreBroad?: string | null }

/** Fire-and-forget: run the candidate, persist it (with the enriched decision-time snapshot the AI/
 *  analog shadow consume), and enqueue AI/analog shadow AFTERWARD. HARD no-op unless
 *  INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1. Never throws into the caller. */
export function runOptionsCandidate(input: OptionsCandidateInput, chain: ChainContract[], deps: { getDb?: () => LoopDb } = {}, env: NodeJS.ProcessEnv = process.env, extra: OptionsCandidateExtra = {}): OptionsEvalResult | null {
  if (!researchFlags(env).independentOptionsDiscovery) return null;
  const res = evaluateOptionsCandidate(input, chain, { bearishActionable: env.BEARISH_ACTIONABLE === "1" });
  const snapJson = extra.featureSnapshot !== undefined ? JSON.stringify(extra.featureSnapshot) : null;
  try {
    const db = (deps.getDb ?? liveDb)();
    db.prepare(
      `INSERT INTO options_candidates (symbol, tier, session, selected_strategy, direction, side, research_only, score, considered_json, state, why, option_symbol, freshness_state, callout_message, earliness_phase, escalated_by, feature_snapshot_json, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(input.symbol, input.tier, input.session, res.selection.selected?.key ?? null, res.selection.direction, res.selection.selected?.side ?? null, res.selection.selected?.researchOnly ? 1 : 0, res.selection.selected?.score ?? null, JSON.stringify(res.selection.considered.slice(0, 8)), res.state, res.callout?.reason ?? res.selection.reason, res.contract?.optionSymbol ?? null, res.callout?.freshness ?? null, res.callout?.message ?? null, extra.earlinessPhase ?? null, extra.escalatedBy ?? null, snapJson, input.nowMs);
    // Real-option paper (separate flag). Public callout DELIVERY is NOT wired here (manual/gated).
    // Options-market-hours only (never open from a stale prior-session quote), and gated on
    // dedup / max-concurrent / per-symbol exposure. A fresh executable quote is enforced by the
    // entry gate (quoteAgeMs) inside buildRealOptionEntry.
    if (res.state === "READY" && res.paperEntry?.ok && researchFlags(env).realOptionPaper && input.session === "regular") {
      const gate = canOpenRealOptionPaper(db, { optionSymbol: res.paperEntry.optionSymbol, strategy: res.paperEntry.strategy, nowMs: input.nowMs });
      if (gate.ok) persistRealOptionPaperOnDb(db, res.paperEntry, input.nowMs, { session: input.session, coreBroad: extra.coreBroad ?? (input.tier === 1 ? "core" : "broad"), featureSnapshotJson: snapJson ?? undefined });
    }
  } catch { /* isolated: options discovery never affects the live path */ }
  return res;
}

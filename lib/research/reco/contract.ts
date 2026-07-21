/**
 * lib/research/reco/contract.ts — map an analog thesis to a CURRENT real option contract
 * (Analog Engine, Phase E). PURE. Operates over a chain snapshot PASSED IN (never fetched
 * here) so it can be unit-tested with mocked chains and never fabricates data.
 *
 * Safety: puts are RESEARCH_ONLY (bearish-gate authoritative — a put is never marked
 * production-eligible unless the existing deterministic option-put gates explicitly allow).
 * Hard gates (spread / OI / volume / two-sided quote / freshness / event-risk) are absolute;
 * failing any of them ABSTAINS with the reason — no contract is invented.
 */
import { bearishActionable } from "../../bearish-gate.ts";

export interface ChainContract {
  optionSymbol: string; side: "call" | "put"; strike: number; expiration: string; dte: number;
  bid: number | null; ask: number | null; mid: number | null; spreadPct: number | null;
  delta: number | null; iv: number | null; volume: number | null; openInterest: number | null;
}
export interface ChainSnapshot { symbol: string; underlyingPrice: number | null; asOfMs: number; available: boolean; contracts: ChainContract[]; note?: string }

export interface ContractGates {
  maxSpreadPct: number; minOpenInterest: number; minVolume: number; maxQuoteAgeMs: number;
  deltaBand: [number, number];        // target |delta| band (e.g. 0.35..0.60)
  allowEarningsWithinHorizon: boolean;
}
export function defaultContractGates(env: NodeJS.ProcessEnv = process.env): ContractGates {
  const n = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    maxSpreadPct: n(env.RECO_MAX_SPREAD_PCT, 12),
    minOpenInterest: n(env.RECO_MIN_OI, 250),
    minVolume: n(env.RECO_MIN_VOLUME, 50),
    maxQuoteAgeMs: n(env.RECO_MAX_QUOTE_AGE_MS, 45_000),
    deltaBand: [n(env.RECO_DELTA_LO, 0.35), n(env.RECO_DELTA_HI, 0.60)],
    allowEarningsWithinHorizon: env.RECO_ALLOW_EARNINGS === "1",
  };
}

export interface SelectInput {
  chain: ChainSnapshot; side: "call" | "put"; holdingDays: number; nowMs: number;
  eventRisk?: { earningsWithinHorizon: boolean } | null;
  gates?: ContractGates; env?: NodeJS.ProcessEnv;
}
export interface SelectResult {
  ok: boolean;
  contract?: ChainContract;
  productionEligible: boolean;   // false for puts unless deterministic gates allow
  researchOnly: boolean;
  rejectedGate?: string;
  reason?: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function twoSided(c: ChainContract): boolean { return isNum(c.bid) && isNum(c.ask) && c.bid > 0 && c.ask >= c.bid; }

/** Select the best current contract for the thesis, or ABSTAIN with a precise gate reason. */
export function selectContract(input: SelectInput): SelectResult {
  const env = input.env ?? process.env;
  const gates = input.gates ?? defaultContractGates(env);
  // Puts are RESEARCH_ONLY unless BEARISH_ACTIONABLE is explicitly on (bearish-gate.ts is the
  // final authority; it defaults OFF). A learned thesis can never make a put production-eligible.
  const putResearchOnly = input.side === "put" && !bearishActionable();

  if (!input.chain?.available || input.chain.contracts.length === 0) {
    return abstain("chain_unavailable", "current option chain unavailable — no contract (never fabricated)", input.side, putResearchOnly);
  }
  if (input.nowMs - input.chain.asOfMs > gates.maxQuoteAgeMs) {
    return abstain("chain_stale", `chain quote ${Math.round((input.nowMs - input.chain.asOfMs) / 1000)}s old > ${Math.round(gates.maxQuoteAgeMs / 1000)}s`, input.side, putResearchOnly);
  }
  if (input.eventRisk?.earningsWithinHorizon && !gates.allowEarningsWithinHorizon) {
    return abstain("event_risk", "earnings inside the holding horizon — abstaining (event risk)", input.side, putResearchOnly);
  }

  // Expiration: DTE must cover the hold (with a small theta buffer); pick the nearest that does.
  const bufferDte = Math.max(1, Math.ceil(input.holdingDays));
  const sameSide = input.chain.contracts.filter((c) => c.side === input.side && c.dte >= bufferDte);
  if (sameSide.length === 0) return abstain("no_expiration", `no ${input.side} expiration covers a ~${input.holdingDays}d hold`, input.side, putResearchOnly);
  const minDte = Math.min(...sameSide.map((c) => c.dte));
  const expiryPool = sameSide.filter((c) => c.dte <= minDte + 7); // nearest expiry bucket

  // Strike: target the middle of the delta band; then apply the hard gates.
  const targetDelta = (gates.deltaBand[0] + gates.deltaBand[1]) / 2;
  const inBand = expiryPool.filter((c) => isNum(c.delta) && Math.abs(c.delta) >= gates.deltaBand[0] && Math.abs(c.delta) <= gates.deltaBand[1]);
  const strikePool = (inBand.length ? inBand : expiryPool).slice();
  const passing = strikePool.filter((c) => {
    if (!twoSided(c)) return false;
    if (!(isNum(c.spreadPct) && c.spreadPct <= gates.maxSpreadPct)) return false;
    if (!(isNum(c.openInterest) && c.openInterest >= gates.minOpenInterest)) return false;
    if (!(isNum(c.volume) && c.volume >= gates.minVolume)) return false;
    return true;
  });
  if (passing.length === 0) {
    const reason = failingReason(strikePool, gates);
    return abstain(reason.gate, reason.detail, input.side, putResearchOnly);
  }
  // Best = closest delta to target, then tightest spread.
  passing.sort((a, b) => (Math.abs((Math.abs(a.delta!) - targetDelta)) - Math.abs((Math.abs(b.delta!) - targetDelta))) || ((a.spreadPct ?? 99) - (b.spreadPct ?? 99)));
  const contract = passing[0];
  const productionEligible = input.side === "call" ? true : !putResearchOnly;
  return { ok: true, contract, productionEligible, researchOnly: !productionEligible, reason: undefined };
}

function failingReason(pool: ChainContract[], g: ContractGates): { gate: string; detail: string } {
  if (!pool.some(twoSided)) return { gate: "no_two_sided_quote", detail: "no contract has a valid two-sided quote" };
  if (!pool.some((c) => isNum(c.spreadPct) && c.spreadPct <= g.maxSpreadPct)) return { gate: "spread", detail: `all spreads exceed ${g.maxSpreadPct}%` };
  if (!pool.some((c) => isNum(c.openInterest) && c.openInterest >= g.minOpenInterest)) return { gate: "open_interest", detail: `open interest below ${g.minOpenInterest}` };
  if (!pool.some((c) => isNum(c.volume) && c.volume >= g.minVolume)) return { gate: "volume", detail: `volume below ${g.minVolume}` };
  return { gate: "liquidity", detail: "no contract clears the liquidity gates" };
}

function abstain(gate: string, reason: string, side: "call" | "put", putResearchOnly: boolean): SelectResult {
  return { ok: false, productionEligible: false, researchOnly: side === "put" ? putResearchOnly : false, rejectedGate: gate, reason };
}

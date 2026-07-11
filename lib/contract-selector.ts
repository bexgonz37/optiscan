/**
 * contract-selector.ts — the ONE centralized, pure, deterministic options
 * contract-selection service. Every alert/scanner/research path selects through
 * here so the gates (delta band, spread, liquidity, DTE, price, freshness,
 * session) live in a single place instead of four divergent copies.
 *
 * PURE by design: it does NO provider I/O. Callers fetch the chain through the
 * metered `fetchOptionChain` (which already routes through `polyFetch` and
 * records freshness) and pass the contracts + freshness in. This preserves the
 * `polyFetch` guarantee and keeps selection fully unit-testable / deterministic.
 *
 * Consolidation: the canonical low-level selectors (`rankZeroDte`, `entryGate`,
 * `nearTheMoney`, `pickSwing`) live here; the legacy names in zero-dte.js /
 * swing-score.ts are thin wrappers that delegate to these, so existing callers
 * and tests keep working while the gate logic exists once.
 *
 * Bearish safety (BEARISH_ACTIONABLE stays off): the selector may identify and
 * score a PUT contract for research/display, but it NEVER marks a put
 * `actionable: true`. Authorization of any bearish actionable alert remains with
 * the existing bearish gate (lib/bearish-gate.ts) downstream — the selector does
 * not (and cannot) authorize it, and there is no env override here that would.
 */
import { maxAgeSecondsFor } from "./data-freshness.ts";
import type { MarketSession } from "./trading-session.ts";
import type { OptionContract, OptionSide } from "./types.ts";
import { zeroDteContractScore } from "./zero-dte.js";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A chain contract as produced by parseOptionsSnapshot (superset of OptionContract). */
export type ChainContract = OptionContract & {
  providerTimestamp?: number | null;
  underlyingPrice?: number | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Canonical low-level selectors (exact behavior preserved; legacy fns delegate)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rank one side's 0DTE contracts. Order: (1) delta in the usable 0.35–0.65 zone,
 * (2) strike distance from spot, (3) composite quality score, (4) optionSymbol
 * as a deterministic final tiebreak (new — makes ranking reproducible). When
 * `underlying` is absent, falls back to score order. Never "cheapest wins".
 */
export function rankZeroDte(
  contracts: any[] = [],
  side: string,
  { minsToClose, expRemainPct, max = 3, underlying = null }: { minsToClose?: number; expRemainPct?: number; max?: number; underlying?: number | null } = {},
): { contract: any; score: number; reasons: string[]; flags: any }[] {
  const spot = isNum(underlying) ? underlying : null;
  const inZone = (c: any) => {
    const d = isNum(c.delta) ? Math.abs(c.delta) : null;
    return d != null && d >= 0.35 && d <= 0.65;
  };
  const dist = (c: any) => (spot != null && isNum(c.strike) ? Math.abs(c.strike - spot) / spot : Infinity);
  const sym = (c: any) => String(c.optionSymbol ?? "");
  return (contracts as any[])
    .filter((c) => c.side === side && c.mid != null && c.mid > 0)
    .map((c) => ({ contract: c, ...zeroDteContractScore(c, { minsToClose, expRemainPct }) }))
    .sort((a, b) => {
      if (spot != null) {
        const za = inZone(a.contract) ? 0 : 1;
        const zb = inZone(b.contract) ? 0 : 1;
        if (za !== zb) return za - zb;
        const da = dist(a.contract);
        const db = dist(b.contract);
        if (Number.isFinite(da) || Number.isFinite(db)) {
          if (Math.abs(da - db) > 1e-9) return da - db;
        }
      }
      if (b.score !== a.score) return b.score - a.score;
      return sym(a.contract) < sym(b.contract) ? -1 : sym(a.contract) > sym(b.contract) ? 1 : 0; // deterministic
    })
    .slice(0, max);
}

/**
 * The 0DTE tradability gate. Returns { ok, failures[] }. This is the canonical
 * spread/delta/breakeven gate — `contractEntryGate` in zero-dte.js delegates to
 * it so the numbers live in one place.
 */
export function entryGate(
  contract: any,
  { underlying = null, expRemainPct = null, maxSpreadPct = 5, minDelta = 0.35, maxDelta = 0.65 }: { underlying?: number | null; expRemainPct?: number | null; maxSpreadPct?: number; minDelta?: number; maxDelta?: number } = {},
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (!contract || !isNum(contract.mid) || contract.mid <= 0) {
    return { ok: false, failures: ["no live contract quote"] };
  }
  const spread = isNum(contract.spreadPct) ? contract.spreadPct : null;
  if (spread == null || spread > maxSpreadPct) {
    failures.push(`spread ${spread == null ? "unknown" : spread.toFixed(1) + "%"} > ${maxSpreadPct}% max`);
  }
  const absDelta = isNum(contract.delta) ? Math.abs(contract.delta) : null;
  if (absDelta == null || absDelta < minDelta || absDelta > maxDelta) {
    failures.push(`delta ${absDelta == null ? "unknown" : absDelta.toFixed(2)} outside ${minDelta}-${maxDelta}`);
  }
  const under = isNum(underlying) ? underlying : isNum(contract.underlyingPrice) ? contract.underlyingPrice : null;
  if (under != null && under > 0 && isNum(expRemainPct)) {
    const breakevenMovePct = (contract.mid / under) * 100;
    if (breakevenMovePct > expRemainPct) {
      failures.push(`breakeven ${breakevenMovePct.toFixed(2)}% > ~${expRemainPct}% plausibly left`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Nearest-usable-strike each side, for research display / context. Widens the
 * DELTA band for SELECTION only (0.35–0.65 → 0.25–0.75 → any) — it never widens
 * spread/liquidity, and the richer selectContract() marks such a pick
 * non-actionable when it fails the tradability gates.
 */
export function nearTheMoney(
  contracts: any[] = [],
  spot: number | null = null,
  { expRemainPct = null }: { expRemainPct?: number | null } = {},
) {
  const pick = (side: "call" | "put") => {
    if (!isNum(spot) || spot <= 0) return null;
    const usable = (contracts as any[]).filter((c) => c.side === side && isNum(c.mid) && c.mid > 0 && isNum(c.strike));
    const zone = (lo: number, hi: number) => usable.filter((c) => {
      const d = isNum(c.delta) ? Math.abs(c.delta) : null;
      return d != null && d >= lo && d <= hi;
    });
    const pool = zone(0.35, 0.65).length ? zone(0.35, 0.65) : zone(0.25, 0.75).length ? zone(0.25, 0.75) : usable;
    if (!pool.length) return null;
    const c = pool.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
    const breakevenPct = +((c.mid / spot) * 100).toFixed(2);
    return {
      optionSymbol: c.optionSymbol ?? null, strike: c.strike, side,
      bid: c.bid ?? null, ask: c.ask ?? null, mid: c.mid,
      spreadPct: isNum(c.spreadPct) ? +c.spreadPct.toFixed(2) : null,
      delta: isNum(c.delta) ? +c.delta.toFixed(2) : null,
      breakevenPct,
      breakevenOk: isNum(expRemainPct) ? breakevenPct <= expRemainPct : null,
      distFromSpotPct: +((Math.abs(c.strike - spot) / spot) * 100).toFixed(2),
    };
  };
  return { call: pick("call"), put: pick("put") };
}

/** Swing (1–4 week) contract gates + preference. Params mirror the SWING_* env. */
export const SWING_MAX_SPREAD_PCT = Number(process.env.SWING_MAX_SPREAD_PCT ?? 8);
export const SWING_MIN_OI = Number(process.env.SWING_MIN_OI ?? 250);
export const SWING_DELTA_MIN = 0.40;
export const SWING_DELTA_MAX = 0.70;

export function pickSwing<T extends { side: string; dte: number | null; spreadPct: number | null; openInterest?: number | null; delta: number | null; mid: number | null; optionSymbol?: string | null }>(
  contracts: T[],
  direction: "call" | "put",
): T | null {
  const usable = contracts.filter((c) =>
    c.side === direction &&
    c.dte != null && c.dte >= 7 && c.dte <= 35 &&
    c.spreadPct != null && c.spreadPct <= SWING_MAX_SPREAD_PCT &&
    (c.openInterest ?? 0) >= SWING_MIN_OI &&
    c.delta != null && Math.abs(c.delta) >= SWING_DELTA_MIN && Math.abs(c.delta) <= SWING_DELTA_MAX &&
    c.mid != null && c.mid > 0.1,
  );
  return usable.sort((a, b) => {
    const dteScore = (c: T) => (c.dte! >= 21 && c.dte! <= 28 ? 0 : Math.min(Math.abs(c.dte! - 21), Math.abs(c.dte! - 28)));
    const dDelta = (c: T) => Math.abs(Math.abs(c.delta!) - 0.55);
    return dteScore(a) - dteScore(b) || dDelta(a) - dDelta(b) ||
      // deterministic final tiebreak
      (String(a.optionSymbol ?? "") < String(b.optionSymbol ?? "") ? -1 : String(a.optionSymbol ?? "") > String(b.optionSymbol ?? "") ? 1 : 0);
  })[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rich centralized API: profiles + selectContract
// ─────────────────────────────────────────────────────────────────────────────

export type SelectionMode = "zero_dte" | "swing" | "near_money";

export interface ContractProfile {
  name: string;
  mode: SelectionMode;
  dteMin: number;
  dteMax: number;
  deltaMin: number;
  deltaMax: number;
  maxSpreadPct: number;
  minOpenInterest: number;
  minVolume: number;
  minMid: number;
  requireActionableSession: boolean;
  actionableSessions: MarketSession[];
  /** "session" → maxAgeSecondsFor("options_chain", session); a number → seconds; null → no staleness gate. */
  maxChainAgeMode: "session" | number | null;
  requireBreakeven: boolean;
}

export const PROFILES: Record<string, ContractProfile> = {
  zero_dte_momentum: {
    name: "zero_dte_momentum",
    mode: "zero_dte",
    dteMin: 0, dteMax: 1,
    deltaMin: 0.35, deltaMax: 0.65,
    maxSpreadPct: Number(process.env.TRADE_MAX_SPREAD_PCT ?? 5),
    minOpenInterest: 0, minVolume: 0, minMid: 0,
    requireActionableSession: true,
    actionableSessions: ["regular"],
    maxChainAgeMode: "session",
    requireBreakeven: true,
  },
  swing_position: {
    name: "swing_position",
    mode: "swing",
    dteMin: 7, dteMax: 35,
    deltaMin: SWING_DELTA_MIN, deltaMax: SWING_DELTA_MAX,
    maxSpreadPct: SWING_MAX_SPREAD_PCT,
    minOpenInterest: SWING_MIN_OI, minVolume: 0, minMid: 0.1,
    requireActionableSession: false,
    actionableSessions: ["premarket", "regular", "afterhours"],
    maxChainAgeMode: "session",
    requireBreakeven: false,
  },
  near_money_context: {
    name: "near_money_context",
    mode: "near_money",
    dteMin: 0, dteMax: 5,
    deltaMin: 0.35, deltaMax: 0.65,
    maxSpreadPct: Number(process.env.TRADE_MAX_SPREAD_PCT ?? 5),
    minOpenInterest: 0, minVolume: 0, minMid: 0,
    requireActionableSession: false,
    actionableSessions: ["regular"],
    maxChainAgeMode: "session",
    requireBreakeven: false,
  },
};

export type RejectionCode =
  | "CHAIN_UNAVAILABLE"
  | "CHAIN_STALE"
  | "NO_CONTRACTS"
  | "NO_SIDE_CONTRACTS"
  | "NO_MID_QUOTE"
  | "SPREAD_TOO_WIDE"
  | "NO_LIQUID_CONTRACT"
  | "NO_DELTA_ZONE"
  | "DTE_OUT_OF_WINDOW"
  | "BREAKEVEN_UNREACHABLE"
  | "STALE_CONTRACT"
  | "SESSION_NOT_ACTIONABLE";

export interface SelectInput {
  underlying: string;
  spot: number | null;
  side: OptionSide;
  contracts: ChainContract[];
  session: MarketSession;
  chainAvailable: boolean;
  chainAsOfMs: number | null;
  minsToClose?: number;
  expRemainPct?: number;
  nowMs?: number;
}

export interface SelectionSuccess {
  ok: true;
  profile: string;
  contract: ChainContract;
  score: number;
  reasons: string[];
  actionable: boolean;
  researchOnly: boolean;
  marketData: {
    spot: number | null;
    mid: number | null;
    spreadPct: number | null;
    delta: number | null;
    openInterest: number;
    volume: number;
    iv: number | null;
    breakevenPct: number | null;
    distFromSpotPct: number | null;
    chainAsOfMs: number | null;
    contractAsOfMs: number | null;
  };
  /** Non-blocking notes (e.g. bearish research-only, session-not-actionable). */
  notes: string[];
}

export interface SelectionRejection {
  ok: false;
  profile: string;
  rejectionCode: RejectionCode;
  reason: string;
  evaluated: number;
  blockedByGate: Record<string, number>;
}

export type SelectionResult = SelectionSuccess | SelectionRejection;

const GATE_TO_CODE: Record<string, RejectionCode> = {
  mid: "NO_MID_QUOTE",
  spread: "SPREAD_TOO_WIDE",
  open_interest: "NO_LIQUID_CONTRACT",
  volume: "NO_LIQUID_CONTRACT",
  delta: "NO_DELTA_ZONE",
  dte: "DTE_OUT_OF_WINDOW",
  breakeven: "BREAKEVEN_UNREACHABLE",
  stale_contract: "STALE_CONTRACT",
};

// Priority when several gates block: the most "fundamental" one wins as primary.
const GATE_PRIORITY = ["mid", "stale_contract", "delta", "spread", "open_interest", "volume", "dte", "breakeven"];

function chainMaxAgeSeconds(profile: ContractProfile, session: MarketSession): number | null {
  if (profile.maxChainAgeMode == null) return null;
  if (profile.maxChainAgeMode === "session") return maxAgeSecondsFor("options_chain", session);
  return profile.maxChainAgeMode;
}

/**
 * Per-contract tradability gates. Returns the list of failed gate keys with
 * human messages. Considers the contract's OWN provider timestamp (req 14): a
 * fresh chain does not rescue an individually stale contract.
 */
function evaluateTradability(
  c: ChainContract,
  profile: ContractProfile,
  ctx: { spot: number | null; expRemainPct?: number; maxContractAgeSeconds: number | null; nowMs: number },
): { gate: string; msg: string }[] {
  const fails: { gate: string; msg: string }[] = [];
  if (!isNum(c.mid) || c.mid <= 0 || c.mid < profile.minMid) {
    fails.push({ gate: "mid", msg: c.mid == null ? "no live contract quote" : `mid ${c.mid} below ${profile.minMid} minimum` });
  }
  const spread = isNum(c.spreadPct) ? c.spreadPct : null;
  if (spread == null || spread > profile.maxSpreadPct) {
    fails.push({ gate: "spread", msg: `spread ${spread == null ? "unknown" : spread.toFixed(1) + "%"} > ${profile.maxSpreadPct}% max` });
  }
  const absDelta = isNum(c.delta) ? Math.abs(c.delta) : null;
  if (absDelta == null || absDelta < profile.deltaMin || absDelta > profile.deltaMax) {
    fails.push({ gate: "delta", msg: `delta ${absDelta == null ? "unknown" : absDelta.toFixed(2)} outside ${profile.deltaMin}-${profile.deltaMax}` });
  }
  if (profile.minOpenInterest > 0 && (c.openInterest ?? 0) < profile.minOpenInterest) {
    fails.push({ gate: "open_interest", msg: `open interest ${c.openInterest ?? 0} < ${profile.minOpenInterest} minimum` });
  }
  if (profile.minVolume > 0 && (c.volume ?? 0) < profile.minVolume) {
    fails.push({ gate: "volume", msg: `volume ${c.volume ?? 0} < ${profile.minVolume} minimum` });
  }
  if (isNum(c.dte) && (c.dte < profile.dteMin || c.dte > profile.dteMax)) {
    fails.push({ gate: "dte", msg: `${c.dte} DTE outside ${profile.dteMin}-${profile.dteMax} window` });
  }
  if (profile.requireBreakeven && isNum(ctx.spot) && ctx.spot > 0 && isNum(ctx.expRemainPct) && isNum(c.mid)) {
    const breakevenMovePct = (c.mid / ctx.spot) * 100;
    if (breakevenMovePct > ctx.expRemainPct) {
      fails.push({ gate: "breakeven", msg: `breakeven ${breakevenMovePct.toFixed(2)}% > ~${ctx.expRemainPct}% plausibly left` });
    }
  }
  if (ctx.maxContractAgeSeconds != null && isNum(c.providerTimestamp)) {
    const ageSec = Math.max(0, Math.round((ctx.nowMs - c.providerTimestamp) / 1000));
    if (ageSec > ctx.maxContractAgeSeconds) {
      fails.push({ gate: "stale_contract", msg: `contract quote ${ageSec}s old > ${ctx.maxContractAgeSeconds}s allowed for this session` });
    }
  }
  return fails;
}

/** Build the ordered candidate pool for a profile (best first). */
function orderedCandidates(input: SelectInput, profile: ContractProfile): ChainContract[] {
  const { contracts, side, spot, minsToClose, expRemainPct } = input;
  if (profile.mode === "swing") {
    // hard-gated selection order (no research widening)
    const best = pickSwing(contracts as any[], side);
    return best ? [best as ChainContract] : [];
  }
  if (profile.mode === "near_money") {
    // research widening of the DELTA band only (spread/liquidity stay as gates)
    const pair = nearTheMoney(contracts as any[], spot, { expRemainPct });
    const sym = pair[side]?.optionSymbol ?? null;
    const found = sym ? (contracts as ChainContract[]).find((c) => c.optionSymbol === sym) : null;
    return found ? [found] : [];
  }
  // zero_dte: permissive rank (marginal contracts included), gates decide actionability
  return rankZeroDte(contracts as any[], side, { minsToClose, expRemainPct, max: 8, underlying: spot }).map((r) => r.contract as ChainContract);
}

/**
 * Centralized contract selection. Returns the best available research contract
 * plus whether it is safe/actionable — or a structured rejection when nothing
 * qualifies. Selecting a research contract and authorizing an actionable trade
 * are DISTINCT: puts are always research-only here (bearish gate is the
 * downstream authority), and any contract failing tradability gates is returned
 * (for near_money research) or rejected (for zero_dte/swing) but never marked
 * actionable.
 */
export function selectContract(input: SelectInput, profileRef: string | ContractProfile): SelectionResult {
  const profile = typeof profileRef === "string" ? PROFILES[profileRef] : profileRef;
  if (!profile) throw new Error(`unknown contract profile: ${String(profileRef)}`);
  const nowMs = input.nowMs ?? Date.now();

  const reject = (rejectionCode: RejectionCode, reason: string, evaluated = 0, blockedByGate: Record<string, number> = {}): SelectionRejection =>
    ({ ok: false, profile: profile.name, rejectionCode, reason, evaluated, blockedByGate });

  // Chain-level availability + freshness first (req 14: chain freshness AND per-contract).
  if (!input.chainAvailable) return reject("CHAIN_UNAVAILABLE", `Options chain for ${input.underlying} is unavailable from the provider.`);
  if (!input.contracts?.length) return reject("NO_CONTRACTS", `No option contracts returned for ${input.underlying}.`);

  const maxAgeSec = chainMaxAgeSeconds(profile, input.session);
  if (maxAgeSec != null) {
    if (input.chainAsOfMs == null) {
      return reject("CHAIN_STALE", `Options chain for ${input.underlying} has no provider timestamp — treated as stale.`);
    }
    const chainAgeSec = Math.max(0, Math.round((nowMs - input.chainAsOfMs) / 1000));
    if (chainAgeSec > maxAgeSec) {
      return reject("CHAIN_STALE", `Options chain for ${input.underlying} is ${chainAgeSec}s old (max ${maxAgeSec}s for the ${input.session} session).`);
    }
  }

  const sideContracts = (input.contracts as ChainContract[]).filter((c) => c.side === input.side);
  if (!sideContracts.length) return reject("NO_SIDE_CONTRACTS", `No ${input.side} contracts available for ${input.underlying}.`);

  const candidates = orderedCandidates(input, profile);
  const ctx = { spot: input.spot, expRemainPct: input.expRemainPct, maxContractAgeSeconds: maxAgeSec, nowMs };

  // Evaluate gates in ranked order; the first gate-clean contract wins.
  const blockedByGate: Record<string, number> = {};
  let firstClean: ChainContract | null = null;
  let evaluated = 0;
  // For near_money research we still surface the picked (possibly non-tradable)
  // contract, marked non-actionable. For zero_dte/swing we require a clean pick.
  const researchPick = candidates[0] ?? null;

  for (const c of candidates) {
    evaluated += 1;
    const fails = evaluateTradability(c, profile, ctx);
    if (!fails.length) { firstClean = c; break; }
    for (const f of fails) blockedByGate[f.gate] = (blockedByGate[f.gate] ?? 0) + 1;
  }

  // Session actionability (does not block research selection).
  const sessionActionable = !profile.requireActionableSession || profile.actionableSessions.includes(input.session);
  const notes: string[] = [];
  if (!sessionActionable) notes.push(`Not actionable in the ${input.session} session for ${profile.name}.`);

  const chosen = firstClean ?? (profile.mode === "near_money" ? researchPick : null);
  if (!chosen) {
    // No safe contract, and this profile does not surface research fallbacks.
    if (!candidates.length) {
      return reject("NO_SIDE_CONTRACTS", `No ${input.side} contract for ${input.underlying} entered the ${profile.name} selection pool.`, sideContracts.length, blockedByGate);
    }
    // primary rejection = highest-count gate, tie-broken by fundamental priority
    let primary = "spread";
    let bestCount = -1;
    for (const g of GATE_PRIORITY) {
      const n = blockedByGate[g] ?? 0;
      if (n > bestCount) { bestCount = n; primary = g; }
    }
    const code = GATE_TO_CODE[primary] ?? "NO_LIQUID_CONTRACT";
    const summary = Object.entries(blockedByGate).map(([g, n]) => `${g}×${n}`).join(", ");
    return reject(code, `No safe/tradable ${input.side} contract for ${input.underlying}: ${evaluated} evaluated, blocked by ${summary || "gates"}.`, evaluated, blockedByGate);
  }

  // Bearish safety: a put is never marked actionable by the selector.
  const isPut = input.side === "put";
  const cleanForActionable = firstClean === chosen;
  const actionable = !isPut && cleanForActionable && sessionActionable;
  const researchOnly = isPut || !cleanForActionable || !sessionActionable;
  if (isPut) notes.push("Put contract is research-only here; bearish actionability is governed by the bearish gate downstream.");
  if (firstClean == null && profile.mode === "near_money") notes.push("Research display contract — fails one or more tradability gates, not actionable.");

  const scored = zeroDteContractScore(chosen, { minsToClose: input.minsToClose, expRemainPct: input.expRemainPct });
  const breakevenPct = isNum(input.spot) && input.spot > 0 && isNum(chosen.mid) ? +((chosen.mid / input.spot) * 100).toFixed(2) : null;
  const distFromSpotPct = isNum(input.spot) && input.spot > 0 && isNum(chosen.strike) ? +((Math.abs(chosen.strike - input.spot) / input.spot) * 100).toFixed(2) : null;

  return {
    ok: true,
    profile: profile.name,
    contract: chosen,
    score: scored.score,
    reasons: scored.reasons,
    actionable,
    researchOnly,
    notes,
    marketData: {
      spot: input.spot,
      mid: chosen.mid ?? null,
      spreadPct: chosen.spreadPct ?? null,
      delta: chosen.delta ?? null,
      openInterest: chosen.openInterest ?? 0,
      volume: chosen.volume ?? 0,
      iv: chosen.iv ?? null,
      breakevenPct,
      distFromSpotPct,
      chainAsOfMs: input.chainAsOfMs,
      contractAsOfMs: isNum(chosen.providerTimestamp) ? chosen.providerTimestamp : null,
    },
  };
}

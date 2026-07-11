/**
 * paper-revalidation.ts — pre-entry contract revalidation (rebuild, PURE).
 *
 * Immediately before a simulated entry, the alert-time contract can no longer be
 * trusted: the chain may be stale, the contract may have vanished, its spread may
 * have widened, its liquidity may have dropped, or it may have drifted outside the
 * strategy profile. This module re-checks the SPECIFIC alert-time contract against
 * a genuinely fresh chain and answers pass/fail — with drift — WITHOUT ever
 * selecting a different contract (no substitution; that is explicitly deferred).
 *
 * Gate reuse: validation runs the alert-time contract back through the ONE
 * centralized selector (lib/contract-selector.ts) as a single-contract pool, so
 * spread / liquidity / delta / DTE / price / breakeven / chain+contract freshness
 * thresholds and the bearish (never-actionable-put) policy live in exactly one
 * place. No thresholds are duplicated here.
 *
 * PURE: no DB, no provider I/O, no clock in the output (caller passes nowMs).
 */
import {
  selectContract,
  PROFILES,
  type ChainContract,
  type ContractProfile,
  type RejectionCode,
} from "./contract-selector.ts";
import type { MarketSession } from "./trading-session.ts";
import type { OptionSide } from "./types.ts";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export type RevalidationCode =
  | RejectionCode
  | "CONTRACT_DISAPPEARED"
  | "IDENTITY_MISMATCH";

/** The alert-time contract we committed to at callout — the ONLY contract we may enter. */
export interface AlertTimeContract {
  optionSymbol: string;
  side: OptionSide;
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  /** At-alert reference values for drift (may be null). */
  mid?: number | null;
  spreadPct?: number | null;
  delta?: number | null;
}

export interface RevalidationInput {
  /** Underlying ticker (for selector context / messages). */
  underlying: string;
  alertContract: AlertTimeContract;
  /** A genuinely fresh chain (already fetched through the metered provider). */
  freshContracts: ChainContract[];
  chainAvailable: boolean;
  chainAsOfMs: number | null;
  session: MarketSession;
  spot: number | null;
  /** Profile name (e.g. "zero_dte_momentum" | "swing_position") or a profile object. */
  profile: string | ContractProfile;
  minsToClose?: number;
  expRemainPct?: number;
  nowMs?: number;
}

export interface ContractDrift {
  spreadPctAtAlert: number | null;
  spreadPctNow: number | null;
  spreadWidened: boolean;
  deltaAtAlert: number | null;
  deltaNow: number | null;
  midAtAlert: number | null;
  midNow: number | null;
  midMovePct: number | null;
  dteAtAlert: number | null;
  dteNow: number | null;
  dteChanged: boolean;
}

export interface RevalidationResult {
  ok: boolean;
  /** ALWAYS the same option symbol as the alert-time contract, or null on failure. Never a substitute. */
  revalidatedContract: ChainContract | null;
  alertTimeContract: AlertTimeContract;
  actionable: boolean;
  researchOnly: boolean;
  drift: ContractDrift | null;
  selectionScore: number | null;
  passedGates: string[];
  failedGates: string[];
  rejectionCode: RevalidationCode | null;
  reason: string;
}

function driftBetween(alert: AlertTimeContract, now: ChainContract): ContractDrift {
  const sA = isNum(alert.spreadPct) ? alert.spreadPct : null;
  const sN = isNum(now.spreadPct) ? now.spreadPct : null;
  const dA = isNum(alert.delta) ? alert.delta : null;
  const dN = isNum(now.delta) ? now.delta : null;
  const mA = isNum(alert.mid) ? alert.mid : null;
  const mN = isNum(now.mid) ? now.mid : null;
  return {
    spreadPctAtAlert: sA,
    spreadPctNow: sN,
    spreadWidened: sA != null && sN != null ? sN > sA : false,
    deltaAtAlert: dA,
    deltaNow: dN,
    midAtAlert: mA,
    midNow: mN,
    midMovePct: mA != null && mA > 0 && mN != null ? +(((mN - mA) / mA) * 100).toFixed(2) : null,
    dteAtAlert: alert.dte ?? null,
    dteNow: now.dte ?? null,
    dteChanged: alert.dte != null && now.dte != null ? alert.dte !== now.dte : false,
  };
}

function fail(
  input: RevalidationInput,
  code: RevalidationCode,
  reason: string,
  extra: Partial<RevalidationResult> = {},
): RevalidationResult {
  return {
    ok: false,
    revalidatedContract: null,
    alertTimeContract: input.alertContract,
    actionable: false,
    researchOnly: true,
    drift: null,
    selectionScore: null,
    passedGates: [],
    failedGates: [],
    rejectionCode: code,
    reason,
    ...extra,
  };
}

/**
 * Revalidate the alert-time contract against a fresh chain. Never substitutes.
 */
export function revalidateContract(input: RevalidationInput): RevalidationResult {
  const profile = typeof input.profile === "string" ? PROFILES[input.profile] : input.profile;
  if (!profile) return fail(input, "NO_CONTRACTS", `unknown selection profile: ${String(input.profile)}`);
  const alert = input.alertContract;

  // Chain availability first (freshness proper is enforced by the selector below).
  if (!input.chainAvailable) {
    return fail(input, "CHAIN_UNAVAILABLE", `Options chain for ${alert.optionSymbol} is unavailable — entry rejected, alert-time contract preserved.`);
  }
  if (!input.freshContracts?.length) {
    return fail(input, "NO_CONTRACTS", `No option contracts returned — cannot revalidate ${alert.optionSymbol}.`);
  }

  // The contract must still EXIST by its exact symbol (no substitution).
  const target = input.freshContracts.find((c) => c.optionSymbol === alert.optionSymbol) ?? null;
  if (!target) {
    return fail(input, "CONTRACT_DISAPPEARED", `Contract ${alert.optionSymbol} is no longer in the chain — entry rejected (no substitution).`);
  }

  // Identity must match exactly — side, strike, expiration (DTE may roll by a day).
  const sameSide = String(target.side) === String(alert.side);
  const sameStrike = alert.strike == null || target.strike == null || Math.abs((target.strike ?? 0) - (alert.strike ?? 0)) < 1e-9;
  const sameExpiry = !alert.expiration || !target.expiration || String(target.expiration).slice(0, 10) === String(alert.expiration).slice(0, 10);
  if (!sameSide || !sameStrike || !sameExpiry) {
    return fail(
      input,
      "IDENTITY_MISMATCH",
      `Contract identity changed for ${alert.optionSymbol} (side/strike/expiration mismatch) — entry rejected.`,
      { drift: driftBetween(alert, target) },
    );
  }

  // Re-run the ONE centralized selector against a single-contract pool so every
  // gate + the chain/contract freshness + bearish policy is reused, not copied.
  const selection = selectContract(
    {
      underlying: input.underlying,
      spot: input.spot,
      side: alert.side,
      contracts: [target],
      session: input.session,
      chainAvailable: true,
      chainAsOfMs: input.chainAsOfMs,
      minsToClose: input.minsToClose,
      expRemainPct: input.expRemainPct,
      nowMs: input.nowMs,
    },
    profile,
  );

  const drift = driftBetween(alert, target);

  if (!selection.ok) {
    // The contract existed + matched identity but the profile excluded it. For
    // hard-filtered profiles (swing) that surfaces as NO_SIDE_CONTRACTS — clarify
    // the reason without duplicating any thresholds.
    const reason = selection.rejectionCode === "NO_SIDE_CONTRACTS"
      ? `${alert.optionSymbol} no longer meets the ${profile.name} requirements (liquidity / spread / delta / DTE) — entry rejected, alert-time contract preserved.`
      : selection.reason;
    return fail(input, selection.rejectionCode, reason, {
      drift,
      failedGates: Object.keys(selection.blockedByGate ?? {}),
    });
  }

  // The selector chose from a single-contract pool — it can only be our contract.
  const passedGates: string[] = [];
  if (isNum(target.spreadPct)) passedGates.push("spread");
  if (isNum(target.delta)) passedGates.push("delta");
  if (isNum(target.openInterest) || isNum(target.volume)) passedGates.push("liquidity");
  passedGates.push("freshness");

  return {
    ok: true,
    revalidatedContract: target, // SAME symbol as alert-time — never a substitute
    alertTimeContract: alert,
    actionable: selection.actionable, // a put is never actionable here (bearish gate policy)
    researchOnly: selection.researchOnly,
    drift,
    selectionScore: selection.score,
    passedGates,
    failedGates: [],
    rejectionCode: null,
    reason: `revalidated: ${alert.optionSymbol} still passes ${profile.name} gates${drift.spreadWidened ? " (spread widened but within limit)" : ""}.`,
  };
}

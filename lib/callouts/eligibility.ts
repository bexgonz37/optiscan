/**
 * callouts/eligibility.ts — PURE. The ONE non-negotiable "valid to enter NOW"
 * rule, shared by normal options Discord delivery and automatic paper-entry.
 *
 * A setup qualifies for a normal Discord alert AND a Supervisor paper candidate
 * only when EVERY verified gate passes: HIGH confidence, ACTIONABLE_NOW, actionable,
 * a valid & fresh two-sided option quote, acceptable spread/liquidity/contract
 * (all folded into the HIGH tier), risk passed, a valid entry window (not extended/
 * missed/invalidated/blocked/waiting/near/watch/research), and the bearish gate
 * permitting the direction. Everything else stays dashboard-only or research-only.
 *
 * This module NEVER fetches, fills, or fabricates. It only reads fields already
 * frozen on the callout and returns a verdict + a precise reason for observability.
 */
import type { Callout } from "./callout.ts";
import { confidenceTier } from "./confidence.ts";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Entry-window states that mean the move already ran / reversed — never now-valid. */
const LATE_ENTRY_STATES = new Set(["EXTENDED", "MISSED", "INVALIDATED", "WAIT_FOR_PULLBACK", "BLOCKED"]);

export interface EligibilityVerdict {
  ok: boolean;
  reason: string;
}

/** Does the callout carry a valid, non-crossed two-sided option quote? */
function hasTwoSidedQuote(k: Callout["contract"]): boolean {
  return !!k && isNum(k.bid) && isNum(k.ask) && (k.bid as number) > 0 && (k.ask as number) > 0 && (k.ask as number) >= (k.bid as number);
}

/**
 * The shared now-only rule. Returns a granular reason when it fails so the
 * dashboard/runtime status can show EXACTLY why a callout did not qualify.
 */
export function nowOnlyActionable(c: Callout, env: NodeJS.ProcessEnv = process.env): EligibilityVerdict {
  if (c.status !== "ACTIONABLE_NOW") return { ok: false, reason: `status ${c.status} is not ACTIONABLE_NOW` };
  if (!c.actionable) return { ok: false, reason: "not actionable" };
  const es = c.entryState ?? null;
  if (es !== "ACTIONABLE") return { ok: false, reason: `entry window ${es ?? "missing"} is not ACTIONABLE` };
  if (es != null && LATE_ENTRY_STATES.has(es)) return { ok: false, reason: `entry window ${es} — not valid now` };
  if (!hasTwoSidedQuote(c.contract)) return { ok: false, reason: "no valid two-sided option quote" };
  if (c.quoteFreshness !== "fresh") return { ok: false, reason: `option/underlying quote not fresh (${c.quoteFreshness})` };
  if (c.riskVerdict && c.riskVerdict.allowed === false) return { ok: false, reason: `risk veto: ${c.riskVerdict.failures.join("; ")}` };
  // The HIGH tier folds in spread/liquidity/contract-selector/session and confirms
  // the entry window is not early/late — it is the final quality authority.
  const tier = confidenceTier(c, env);
  if (tier !== "HIGH") return { ok: false, reason: `${tier.toLowerCase()}-confidence (need HIGH)` };
  return { ok: true, reason: "HIGH + ACTIONABLE_NOW + valid entry now" };
}

/**
 * Paper-candidate eligibility = the now-only rule PLUS the paper env gates and the
 * hard 0DTE / bearish protections. Order matters: the cheapest, most explanatory
 * env gates first, then the setup quality, then the special-case blocks.
 */
export function paperCandidateEligibility(c: Callout, env: NodeJS.ProcessEnv = process.env): EligibilityVerdict {
  if (env.PAPER_TRADING_ENABLED === "0") return { ok: false, reason: "paper trading disabled (PAPER_TRADING_ENABLED=0)" };
  if (env.PAPER_KILL_SWITCH === "1") return { ok: false, reason: "paper kill switch engaged (PAPER_KILL_SWITCH=1)" };
  if (env.PAPER_AUTO_ENTRY !== "1") return { ok: false, reason: "paper auto-entry disabled (PAPER_AUTO_ENTRY!=1)" };

  const base = nowOnlyActionable(c, env);
  if (!base.ok) return base;

  // Puts NEVER paper trade while bearish actionability is absent/off.
  if (c.direction === "bearish" && env.BEARISH_ACTIONABLE !== "1") {
    return { ok: false, reason: "bearish actionability disabled (BEARISH_ACTIONABLE!=1) — puts are research-only" };
  }
  // 0DTE respects PAPER_ALLOW_ZERO_DTE — surfaced, never silently bypassed.
  const dte = c.contract?.dte;
  if (isNum(dte) && (dte as number) <= 0 && env.PAPER_ALLOW_ZERO_DTE !== "1") {
    return { ok: false, reason: "0DTE paper entry disabled (PAPER_ALLOW_ZERO_DTE!=1)" };
  }
  return { ok: true, reason: base.reason };
}

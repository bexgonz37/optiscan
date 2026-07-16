/**
 * bearish-gate.ts — production safety gate for bearish/short outputs
 * (stabilization 2026-07-10).
 *
 * ROOT CAUSE of the poor short callouts (traced): the bearish path is the
 * bullish momentum engine mechanically inverted. A stock slightly red, or one
 * bearish 10-second read below VWAP, produces the same conviction machinery
 * as a confirmed breakout — but downside moves need breakdown confirmation
 * (level break + sell-volume acceleration) that the current logic does not
 * require. The day-trend gate (2026-07-09) blocks counter-trend shorts, but
 * with-trend weak drifts still slip through.
 *
 * Until the bearish strategy is rebuilt and validated, NO bearish output may
 * be actionable. Bearish candidates are still detected and logged — demoted
 * to WATCH with an explicit BEARISH_STRATEGY_DISABLED reason — so the
 * dashboard can show them in a research state and the rebuild has data.
 *
 * Bullish paths are untouched: the gate keys strictly on direction/side.
 * Re-enable (after rebuild + validation only): BEARISH_ACTIONABLE=1.
 */

export const BEARISH_DISABLED_REASON = "BEARISH_TRADING_OFF";

export function bearishActionable(): boolean {
  return process.env.BEARISH_ACTIONABLE === "1";
}

export function verifiedOptionsPutsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPTIONS_PUTS_ENABLED !== "0" && env.OPTIONS_PUT_CALLOUTS !== "0";
}

export interface BearishGateResult {
  action: string;
  gated: boolean;
  reason: string | null;
}

/** True when this alert expresses a bearish/short/put thesis. */
export function isBearishIntent(input: {
  direction?: string | null;
  optionSide?: string | null;
  side?: string | null;
}): boolean {
  const dir = String(input.direction ?? "").toLowerCase();
  const optSide = String(input.optionSide ?? input.side ?? "").toLowerCase();
  return dir === "bearish" || optSide === "put" || optSide === "short";
}

/**
 * Demote any actionable bearish decision to WATCH (research-only).
 * Non-bearish and non-actionable inputs pass through unchanged.
 */
export function gateBearishAction(
  input: { direction?: string | null; optionSide?: string | null; side?: string | null },
  action: string,
  env: NodeJS.ProcessEnv = process.env,
): BearishGateResult {
  const actionable = ["TRADE", "BUY", "ENTRY_CONFIRMED", "ACTIONABLE"].includes(String(action).toUpperCase());
  const optSide = String(input.optionSide ?? input.side ?? "").toLowerCase();
  const isVerifiedPut = optSide === "put";
  if (!actionable || env.BEARISH_ACTIONABLE === "1" || !isBearishIntent(input) || (isVerifiedPut && verifiedOptionsPutsEnabled(env))) {
    return { action, gated: false, reason: null };
  }
  return {
    action: "WAIT",
    gated: true,
    reason: `${BEARISH_DISABLED_REASON}: bearish stock/short ideas are research-only until bearish trading is enabled (set BEARISH_ACTIONABLE=1). Verified option puts use OPTIONS_PUTS_ENABLED and still pass the normal options gates.`,
  };
}

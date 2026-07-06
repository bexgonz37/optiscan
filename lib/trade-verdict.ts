/**
 * trade-verdict.ts — one clear TRADE / WAIT / SKIP answer from alert fields.
 *
 * Uses the same inputs as alert-capture (trade_bias, worth scores, risk flags).
 * TRADE also requires live speed proof (same 0.15%/min gate as shouldTrigger).
 */

export type TradeAction = "TRADE" | "WAIT" | "SKIP";
export type OptionSide = "CALL" | "PUT" | "NONE";

export const MIN_SPEED_PCT_PER_MIN = 0.15;
export const MIN_VOLUME_SURGE = 1.3;

export interface AlertVerdictInput {
  ticker?: string | null;
  direction?: string | null;
  trade_bias?: string | null;
  signal_score?: number | null;
  risk_score?: number | null;
  option_worth_score?: number | null;
  worth_verdict?: string | null;
  zero_dte_contract_score?: number | null;
  options_liquidity_score?: number | null;
  move_status?: string | null;
  risk_flags?: string | null;
  option_side?: string | null;
  strike?: number | null;
  expiration?: string | null;
  dte?: number | null;
  percent_move_at_alert?: number | null;
  relative_volume?: number | null;
  short_rate_at_alert?: number | null;
  volume_surge_at_alert?: number | null;
  long_call_score?: number | null;
  long_put_score?: number | null;
}

export interface TradeVerdict {
  action: TradeAction;
  side: OptionSide;
  headline: string;
  reason: string;
  confidence: number;
  contractLine: string | null;
  bullets: string[];
  /** Plain-English why BUY CALL/PUT did or didn't fire */
  logicLine: string;
  hasSpeedProof: boolean;
}

const BLOCKING_FLAGS = new Set([
  "Spread Too Wide",
  "Premium Too Expensive",
  "Move Exhausted",
  "Fake Breakout Risk",
]);

function parseFlags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.map(String) : [];
  } catch {
    return [];
  }
}

function sideFromDirection(direction: string | null | undefined): OptionSide {
  if (direction === "bullish") return "CALL";
  if (direction === "bearish") return "PUT";
  return "NONE";
}

function sideFromBias(bias: string | null | undefined, direction: string | null | undefined): OptionSide {
  if (bias === "long_call_candidate") return "CALL";
  if (bias === "long_put_candidate") return "PUT";
  return sideFromDirection(direction);
}

function contractLine(a: AlertVerdictInput): string | null {
  if (!a.strike || !a.option_side) return null;
  const side = String(a.option_side).toUpperCase().startsWith("P") ? "P" : "C";
  const exp = a.dte != null ? `${a.dte}DTE` : a.expiration ?? "";
  return `${a.ticker ?? "?"} $${a.strike}${side} ${exp}`.trim();
}

/** Same speed idea as shouldTrigger() in zero-dte.js — tape must be moving NOW. */
export function hasSpeedProof(a: AlertVerdictInput): boolean {
  const speed = a.short_rate_at_alert;
  const surge = a.volume_surge_at_alert;
  const dailyMove = Math.abs(Number(a.percent_move_at_alert ?? 0));
  const rvol = Number(a.relative_volume ?? 0);
  if (speed != null && Math.abs(speed) >= MIN_SPEED_PCT_PER_MIN) return true;
  if (surge != null && surge >= MIN_VOLUME_SURGE) return true;
  if (dailyMove >= 2.5) return true;
  if (rvol >= 2.5) return true;
  return false;
}

export function formatSpeedLine(a: AlertVerdictInput): string {
  const speed = a.short_rate_at_alert;
  const surge = a.volume_surge_at_alert;
  if (speed != null) {
    const ok = Math.abs(speed) >= MIN_SPEED_PCT_PER_MIN;
    return `Speed ${speed > 0 ? "+" : ""}${speed.toFixed(2)}%/min${ok ? " ✓" : " (too slow for TRADE)"}`;
  }
  if (surge != null) return `Volume surge ${surge.toFixed(1)}x`;
  const move = a.percent_move_at_alert;
  if (move != null) return `Day move ${move > 0 ? "+" : ""}${move.toFixed(1)}% (no live speed recorded)`;
  return "No live speed data — slower swing scan";
}

function skipVerdict(
  a: AlertVerdictInput,
  reason: string,
  bullets: string[],
  logicLine: string,
  hasSpeed: boolean,
): TradeVerdict {
  return {
    action: "SKIP",
    side: "NONE",
    headline: "SKIP — DON'T TRADE",
    reason,
    confidence: Math.round(Math.max(0, 100 - (a.risk_score ?? 50))),
    contractLine: contractLine(a),
    bullets,
    logicLine,
    hasSpeedProof: hasSpeed,
  };
}

/** Optional live tape — re-checks speed so stale BUY CALL downgrades if move stopped. */
export interface LiveTapeContext {
  shortRate?: number | null;
  surge?: number | null;
}

export function computeTradeVerdict(a: AlertVerdictInput, live?: LiveTapeContext): TradeVerdict {
  const merged: AlertVerdictInput = {
    ...a,
    short_rate_at_alert: live?.shortRate ?? a.short_rate_at_alert,
    volume_surge_at_alert: live?.surge ?? a.volume_surge_at_alert,
  };
  const flags = parseFlags(merged.risk_flags);
  const blocking = flags.filter((f) => BLOCKING_FLAGS.has(f));
  const bias = merged.trade_bias ?? "";
  const side = sideFromBias(bias, merged.direction);
  const setup = Number(merged.signal_score ?? 0);
  const risk = Number(merged.risk_score ?? 0);
  const worth = Number(merged.option_worth_score ?? 0);
  const contract = Number(merged.zero_dte_contract_score ?? 0);
  const liq = Number(merged.options_liquidity_score ?? 0);
  const verdict = String(merged.worth_verdict ?? "");
  const speedOk = hasSpeedProof(merged);
  const speedLine = formatSpeedLine(merged);

  const bullets: string[] = [
    speedLine,
    `Setup ${Math.round(setup)}/100 · Worth-it ${Math.round(worth)}/100 · Contract ${Math.round(contract)}/100`,
    `Risk ${Math.round(risk)}/100 · Liquidity ${Math.round(liq)}/100`,
  ];
  if (merged.long_call_score != null && merged.long_put_score != null) {
    bullets.push(`Call watch ${Math.round(merged.long_call_score)} · Put watch ${Math.round(merged.long_put_score)}`);
  }
  if (flags.length) bullets.push(`Flags: ${flags.join(", ")}`);
  if (live?.shortRate != null && a.short_rate_at_alert != null && Math.abs(live.shortRate) < MIN_SPEED_PCT_PER_MIN) {
    bullets.push(`Live speed now ${live.shortRate.toFixed(2)}%/min — move may have stalled since alert.`);
  }

  const logicBase =
    "BUY CALL/PUT only when: direction + contract quality pass AND tape speed ≥ 0.15%/min (or volume surge / big day move).";

  if (bias === "skip" || bias === "no_clean_setup" || merged.direction === "choppy" || merged.move_status === "exhausted") {
    return skipVerdict(merged, "No clean directional setup — tape is choppy or exhausted.", bullets, `${logicBase} Failed: choppy or exhausted.`, speedOk);
  }

  if (verdict === "Too Late / Skip" || verdict === "Too Choppy / Skip") {
    return skipVerdict(merged, verdict.replace(" / Skip", "") + " — too late or too choppy.", bullets, `${logicBase} Failed: ${verdict}.`, speedOk);
  }

  if (blocking.length) {
    return skipVerdict(merged, `${blocking[0]} — contract or move structure blocks a clean entry.`, bullets, `${logicBase} Failed: ${blocking[0]}.`, speedOk);
  }

  if (risk > 55) {
    return skipVerdict(merged, "Risk score too high for a new 0DTE entry.", bullets, `${logicBase} Failed: risk too high.`, speedOk);
  }

  const qualityGates =
    setup >= 75 &&
    worth >= 70 &&
    contract >= 55 &&
    liq >= 45 &&
    (bias === "long_call_candidate" || bias === "long_put_candidate");

  if (qualityGates && !speedOk) {
    return {
      action: "WAIT",
      side: side !== "NONE" ? side : sideFromDirection(merged.direction),
      headline: side === "PUT" ? "WAIT — PUT SETUP" : side === "CALL" ? "WAIT — CALL SETUP" : "WAIT",
      reason: "Scores look good but the stock isn't moving fast right now — need live speed ≥ 0.15%/min or a volume burst.",
      confidence: Math.round(setup * 0.4 + worth * 0.4 + contract * 0.2),
      contractLine: contractLine(merged),
      bullets,
      logicLine: `${logicBase} Quality passed but ${speedLine.toLowerCase()}.`,
      hasSpeedProof: false,
    };
  }

  if (qualityGates && speedOk) {
    const headline = side === "CALL" ? "BUY CALL" : side === "PUT" ? "BUY PUT" : "TRADE";
    const confidence = Math.round(setup * 0.35 + worth * 0.35 + contract * 0.2 + (100 - risk) * 0.1);
    return {
      action: "TRADE",
      side,
      headline,
      reason: side === "CALL"
        ? `Tape accelerating up (${speedLine}) with a liquid call contract.`
        : `Tape accelerating down (${speedLine}) with a liquid put contract.`,
      confidence: Math.min(99, confidence),
      contractLine: contractLine(merged),
      bullets,
      logicLine: `${logicBase} All checks passed.`,
      hasSpeedProof: true,
    };
  }

  const waitSide = side !== "NONE" ? side : sideFromDirection(merged.direction);
  const waitHeadline =
    waitSide === "CALL" ? "WAIT — CALL SETUP" : waitSide === "PUT" ? "WAIT — PUT SETUP" : "WAIT";

  let waitReason = "Setup forming — does not pass all entry gates yet.";
  if (bias === "wait_for_pullback" || verdict === "Wait for Pullback") {
    waitReason = "Direction is right but price is extended — wait for a pullback.";
  } else if (bias === "chase_risk" || verdict === "Chase Risk") {
    waitReason = "Move may be chasing — wait for confirmation or a better entry.";
  } else if (bias === "watch_only") {
    waitReason = "Watch only — contract or side score not strong enough to enter.";
  } else if (setup < 75) {
    waitReason = `Setup ${Math.round(setup)}/100 is below the 75 trade threshold.`;
  } else if (worth < 70) {
    waitReason = `Worth-it ${Math.round(worth)}/100 is below the 70 trade threshold.`;
  } else if (contract < 55) {
    waitReason = `Contract score ${Math.round(contract)}/100 is too low (need 55+).`;
  }

  return {
    action: "WAIT",
    side: waitSide,
    headline: waitHeadline,
    reason: waitReason,
    confidence: Math.round(setup * 0.4 + worth * 0.4 + contract * 0.2),
    contractLine: contractLine(merged),
    bullets,
    logicLine: `${logicBase} Waiting: ${waitReason}`,
    hasSpeedProof: speedOk,
  };
}

/**
 * trade-verdict.ts — one clear TRADE / WAIT / SKIP answer from alert fields.
 *
 * Uses the same inputs as alert-capture (trade_bias, worth scores, risk flags).
 * TRADE requires LIVE, direction-aligned speed proof: the tape must be moving
 * the right way at ≥ 0.15%/min right now (or a real volume burst). A big day
 * move or high RVOL alone is context — it never turns into BUY CALL/PUT.
 */

export type TradeAction = "TRADE" | "WAIT" | "SKIP";
export type OptionSide = "CALL" | "PUT" | "NONE";

export const MIN_SPEED_PCT_PER_MIN = 0.15;
export const MIN_VOLUME_SURGE = 1.3;
/** Speed this far against the bias means the move reversed — never TRADE. */
const REVERSAL_SPEED = 0.1;

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
  /** 'trade' = live 1s loop with speed data; 'research' = slower scan, never TRADE. */
  alert_tier?: string | null;
  /** ISO time the alert fired — TRADE is capped to fresh signals only. */
  alert_time?: string | null;
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

/** Quality gates for TRADE — exported for tier assignment at capture. */
export function passesQualityGates(a: AlertVerdictInput): boolean {
  const setup = Number(a.signal_score ?? 0);
  const worth = Number(a.option_worth_score ?? 0);
  const contract = Number(a.zero_dte_contract_score ?? 0);
  const liq = Number(a.options_liquidity_score ?? 0);
  const bias = a.trade_bias ?? "";
  return (
    setup >= 75 &&
    worth >= 70 &&
    contract >= 55 &&
    liq >= 45 &&
    (bias === "long_call_candidate" || bias === "long_put_candidate")
  );
}

/** Assign trade tier: TRADE at capture, or quality+speed fallback (not surge-only). */
export function resolveAlertTier(
  verdict: Pick<TradeVerdict, "action">,
  qualityGates: boolean,
  speedOk: boolean,
): "trade" | "research" {
  if (verdict.action === "TRADE") return "trade";
  if (qualityGates && speedOk) return "trade";
  return "research";
}

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

/** Optional live tape — re-checks speed so stale BUY CALL downgrades if move stopped. */
export interface LiveTapeContext {
  shortRate?: number | null;
  surge?: number | null;
  price?: number | null;
  /** Live scanner direction: bullish | bearish | choppy */
  direction?: string | null;
}

/** Discord / high-urgency: stricter than TRADE — must be unmistakably moving now. */
export const CLEAR_SIGNAL_MIN_CONFIDENCE = 82;
export const CLEAR_SIGNAL_MIN_SPEED = 0.2;

/** A BUY signal older than this can never re-show as TRADE — the contract,
 * strike, and premium it was based on are stale. Fresh signals only. */
export const MAX_FRESH_ALERT_AGE_MS = 15 * 60_000;

/** Minutes since the alert fired, or null when alert_time is missing. */
export function alertAgeMinutes(a: Pick<AlertVerdictInput, "alert_time">, nowMs = Date.now()): number | null {
  if (!a.alert_time) return null;
  const t = Date.parse(a.alert_time);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 60_000));
}

function isStaleForTrade(a: Pick<AlertVerdictInput, "alert_time">, nowMs = Date.now()): boolean {
  if (!a.alert_time) return false;
  const t = Date.parse(a.alert_time);
  if (!Number.isFinite(t)) return false;
  return nowMs - t > MAX_FRESH_ALERT_AGE_MS;
}

export function isLiveTapeAligned(side: OptionSide, live?: LiveTapeContext): boolean {
  if (!live || side === "NONE") return true;
  if (side === "CALL") {
    if (live.direction === "bearish") return false;
    if (live.shortRate != null && live.shortRate < 0) return false;
  }
  if (side === "PUT") {
    if (live.direction === "bullish") return false;
    if (live.shortRate != null && live.shortRate > 0) return false;
  }
  return true;
}

/**
 * REQUIRED for TRADE: the tape must be moving the right way, right now.
 * When `live` is present, only live shortRate/surge count — never borrow
 * alert-time values (prevents a stalled tape keeping BUY via stale surge).
 * Live surge alone never justifies a BUY against a flat/down (or up) tape.
 */
export function hasLiveSpeedProof(a: AlertVerdictInput, side: OptionSide, live?: LiveTapeContext): boolean {
  const hasLive = live != null;
  const speed = hasLive ? (live.shortRate ?? null) : a.short_rate_at_alert;
  const surge = hasLive ? (live.surge ?? null) : a.volume_surge_at_alert;
  if (speed == null && surge == null) return false;

  if (hasLive) {
    if (side === "CALL" && speed != null && speed <= 0) return false;
    if (side === "PUT" && speed != null && speed >= 0) return false;
  }

  if (speed != null) {
    if (side === "CALL" && speed >= MIN_SPEED_PCT_PER_MIN) return true;
    if (side === "PUT" && speed <= -MIN_SPEED_PCT_PER_MIN) return true;
    if (side === "NONE" && Math.abs(speed) >= MIN_SPEED_PCT_PER_MIN) return true;
    if (side === "CALL" && speed < -REVERSAL_SPEED) return false;
    if (side === "PUT" && speed > REVERSAL_SPEED) return false;
  }

  if (hasLive) return false; // live: volume burst without aligned speed is not enough
  return surge != null && surge >= MIN_VOLUME_SURGE;
}

/** Day move / RVOL — used for WAIT wording only, never enough for TRADE. */
export function hasContextSpeed(a: AlertVerdictInput): boolean {
  return Math.abs(Number(a.percent_move_at_alert ?? 0)) >= 2.5 || Number(a.relative_volume ?? 0) >= 2.5;
}

/** One-call helper for popup / Discord / UI filters: should this interrupt the user? */
export function isTradeEligible(a: AlertVerdictInput, live?: LiveTapeContext): boolean {
  return computeTradeVerdict(a, live).action === "TRADE";
}

/** Stricter gate for Discord — only unmistakable, direction-aligned moves. */
export function isClearTradeSignal(a: AlertVerdictInput, live?: LiveTapeContext): boolean {
  const v = computeTradeVerdict(a, live);
  if (v.action !== "TRADE" || v.side === "NONE") return false;
  if (a.alert_tier === "research") return false;
  if (v.confidence < CLEAR_SIGNAL_MIN_CONFIDENCE) return false;
  const speed = live?.shortRate ?? a.short_rate_at_alert;
  if (v.side === "CALL") {
    if ((speed ?? 0) < CLEAR_SIGNAL_MIN_SPEED) return false;
    if ((live?.direction ?? a.direction) === "bearish") return false;
  }
  if (v.side === "PUT") {
    if ((speed ?? 0) > -CLEAR_SIGNAL_MIN_SPEED) return false;
    if ((live?.direction ?? a.direction) === "bullish") return false;
  }
  return isLiveTapeAligned(v.side, live);
}

export function formatSpeedLine(a: AlertVerdictInput, live?: LiveTapeContext): string {
  const hasLive = live != null;
  const speed = hasLive ? (live.shortRate ?? null) : a.short_rate_at_alert;
  const surge = hasLive ? (live.surge ?? null) : a.volume_surge_at_alert;
  const fromLive = hasLive && live.shortRate != null;
  if (speed != null) {
    const ok = Math.abs(speed) >= MIN_SPEED_PCT_PER_MIN;
    return `Speed ${fromLive ? "now " : ""}${speed > 0 ? "+" : ""}${speed.toFixed(2)}%/min${ok ? " ✓" : " (too slow for TRADE)"}`;
  }
  if (surge != null) return `Volume surge ${surge.toFixed(1)}x`;
  const move = a.percent_move_at_alert;
  if (move != null) return `Day move ${move > 0 ? "+" : ""}${move.toFixed(1)}% (no live speed recorded)`;
  return "No live speed data — slower research scan";
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
  const isResearch = merged.alert_tier === "research";
  const speedOk = !isResearch && hasLiveSpeedProof(merged, side, live);
  const speedLine = formatSpeedLine(a, live);

  const bullets: string[] = [
    speedLine,
    `Setup ${Math.round(setup)}/100 · Worth-it ${Math.round(worth)}/100 · Contract ${Math.round(contract)}/100`,
    `Risk ${Math.round(risk)}/100 · Liquidity ${Math.round(liq)}/100`,
  ];
  if (merged.long_call_score != null && merged.long_put_score != null) {
    bullets.push(`Call watch ${Math.round(merged.long_call_score)} · Put watch ${Math.round(merged.long_put_score)}`);
  }
  if (flags.length) bullets.push(`Flags: ${flags.join(", ")}`);
  if (!speedOk && hasContextSpeed(a)) {
    bullets.push("Big day move / high volume is context only — BUY needs live speed right now.");
  }
  if (live?.shortRate != null && a.short_rate_at_alert != null && Math.abs(live.shortRate) < MIN_SPEED_PCT_PER_MIN) {
    bullets.push(`Live speed now ${live.shortRate.toFixed(2)}%/min — move may have stalled since alert.`);
  }

  const logicBase =
    "BUY CALL/PUT only when: direction + contract quality pass AND the tape is moving the right way ≥ 0.15%/min right now (or a live volume burst).";

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
    const why = isResearch
      ? "This came from the slower research scan — verify live speed on the chart before acting."
      : "Scores look good but the stock isn't moving the right way fast enough right now — need live speed ≥ 0.15%/min or a volume burst.";
    return {
      action: "WAIT",
      side: side !== "NONE" ? side : sideFromDirection(merged.direction),
      headline: side === "PUT" ? "WAIT — PUT SETUP" : side === "CALL" ? "WAIT — CALL SETUP" : "WAIT",
      reason: why,
      confidence: Math.round(setup * 0.4 + worth * 0.4 + contract * 0.2),
      contractLine: contractLine(merged),
      bullets,
      logicLine: `${logicBase} Quality passed but ${speedLine.toLowerCase()}.`,
      hasSpeedProof: false,
    };
  }

  if (qualityGates && speedOk) {
    if (live != null && !isLiveTapeAligned(side, live)) {
      const against =
        side === "CALL"
          ? "Tape turned down — stock is not pushing up right now."
          : "Tape turned up — stock is not pushing down right now.";
      return {
        action: "WAIT",
        side,
        headline: side === "PUT" ? "WAIT — PUT SETUP" : side === "CALL" ? "WAIT — CALL SETUP" : "WAIT",
        reason: against,
        confidence: Math.round(setup * 0.35 + worth * 0.35 + contract * 0.2),
        contractLine: contractLine(merged),
        bullets: [...bullets, against],
        logicLine: `${logicBase} Quality passed but live tape disagrees.`,
        hasSpeedProof: false,
      };
    }
    // Freshness gate (live re-checks only, never the historical at-alert view):
    // an old BUY was priced off a contract/premium that no longer exists. Even
    // if the tape re-accelerates, demand a NEW alert instead of reviving this one.
    if (live != null && isStaleForTrade(merged)) {
      const ageMin = alertAgeMinutes(merged) ?? 0;
      const staleWhy = `This signal fired ${ageMin} min ago — too old to act on. The contract and entry it was based on are stale; wait for a fresh signal.`;
      return {
        action: "WAIT",
        side,
        headline: side === "PUT" ? "WAIT — PUT SETUP" : side === "CALL" ? "WAIT — CALL SETUP" : "WAIT",
        reason: staleWhy,
        confidence: Math.round(setup * 0.3 + worth * 0.3 + contract * 0.2),
        contractLine: contractLine(merged),
        bullets: [...bullets, staleWhy],
        logicLine: `${logicBase} Blocked: signal older than ${Math.round(MAX_FRESH_ALERT_AGE_MS / 60_000)} min — stale signals never re-arm as BUY.`,
        hasSpeedProof: false,
      };
    }
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

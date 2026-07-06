/**
 * language-modes.js — the two wording modes and the public-safety guard.
 *
 * MODE "private": my labels (0DTE Call Watch, 0DTE Put Watch, A+ prefixes,
 * Wait for Pullback, ...). MODE "public": screenshot/stream/Discord-safe
 * labels only. Public output must NEVER contain directive trading language;
 * containsBannedPublicLanguage() is the runtime + test-time guard, and the
 * Discord sender refuses any payload that fails it.
 *
 * Pure functions — no network, no DB. Safe to unit test.
 */

export const LANGUAGE_MODES = ["private", "public"];

/** Words/phrases that must never appear in public-mode output (whole-word). */
const BANNED_PUBLIC_PATTERNS = [
  /\bbuy\b/i,
  /\bsell\b/i,
  /\bbuy now\b/i,
  /\bsell now\b/i,
  /\bstrong buy\b/i,
  /\btake this (trade|call|put)\b/i,
  /\btake (calls?|puts?)\b/i,
  /\bbuy (calls?|puts?)\b/i,
  /\bguaranteed?\b/i,
  /\beasy money\b/i,
  /\bcopy (this )?trade\b/i,
];

/** True if text contains language unsafe for public/education mode. */
export function containsBannedPublicLanguage(text) {
  const t = String(text ?? "");
  return BANNED_PUBLIC_PATTERNS.some((re) => re.test(t));
}

// ── 0DTE label sets (primary) ────────────────────────────────────────────────

/**
 * Private 0DTE label from trade bias + structural flags. Flag problems win
 * over bias (a wide-spread A+ tape is still untradable); A+ prefix only on
 * setup >= 90 with a directional bias.
 */
export function privateLabel0dte({ bias, setupScore, direction, riskFlags = [] }) {
  if (riskFlags.includes("Spread Too Wide")) return "Spread Too Wide";
  if (riskFlags.includes("Premium Too Expensive")) return "Premium Too Expensive";
  const s = Number(setupScore ?? 0);
  switch (bias) {
    case "long_call_candidate": return s >= 90 ? "A+ 0DTE Call Watch" : "0DTE Call Watch";
    case "long_put_candidate": return s >= 90 ? "A+ 0DTE Put Watch" : "0DTE Put Watch";
    case "wait_for_pullback": return "Wait for Pullback";
    case "chase_risk": return "Chase Risk";
    case "no_clean_setup": return "Too Choppy";
    case "skip": return "Skip";
    case "watch_only":
    default:
      if (direction === "bullish") return "Bullish 0DTE Setup";
      if (direction === "bearish") return "Bearish 0DTE Setup";
      return "Momentum Continuation";
  }
}

/** Public 0DTE label — direction is allowed, call/put wording is not. */
export function publicLabel0dte({ direction, setupScore }) {
  const s = Number(setupScore ?? 0);
  if (s >= 70 && direction === "bullish") return "Bullish Momentum Alert";
  if (s >= 70 && direction === "bearish") return "Bearish Momentum Alert";
  if (s >= 60) return "0DTE Watchlist Candidate";
  if (s >= 50) return "Momentum Setup Detected";
  return "Educational Only";
}

// ── Legacy score-band labels (still used by swing-radar + manual alerts) ────

export function privateLabel(setupScore, opts = {}) {
  const s = Number(setupScore ?? 0);
  if (opts.riskLabel === "Extreme Risk / Avoid") return "Skip / Too Risky";
  if (s >= 90) return "A+ Setup";
  if (s >= 80) return "High-Quality Alert";
  if (s >= 70) return "Watchlist Candidate";
  if (s >= 60) return "Needs Confirmation";
  return "Low Quality / Ignore";
}

export function privateSideHint(side) {
  if (side === "call") return "Possible Call Setup";
  if (side === "put") return "Possible Put Setup";
  return null;
}

export function publicLabel(setupScore, opts = {}) {
  const s = Number(setupScore ?? 0);
  if (opts.riskLabel === "Extreme Risk / Avoid") return "Risk Warning";
  if (s >= 80) return "High-Quality Scanner Alert";
  if (s >= 70) return "Watchlist Candidate";
  if (s >= 60) return "Momentum Alert";
  return "Educational Only";
}

/** Risk score (0-100, higher = riskier) -> label. */
export function riskLabel(riskScore) {
  const r = Number(riskScore ?? 0);
  if (r < 30) return "Low Risk";
  if (r < 55) return "Medium Risk";
  if (r < 75) return "High Risk";
  return "Extreme Risk / Avoid";
}

/** Suggested action chip: Watch / Confirm / Skip (Journal is always manual). */
export function suggestedAction(setupScore, riskScore) {
  const s = Number(setupScore ?? 0);
  const r = Number(riskScore ?? 0);
  if (r >= 75 || s < 60) return "Skip";
  if (s >= 80 && r < 55) return "Watch";
  return "Confirm";
}

/** Direction label; choppy/unknown reads as Volatile (both-ways risk). */
export function directionLabel(direction) {
  if (direction === "bullish") return "Bullish momentum";
  if (direction === "bearish") return "Bearish momentum";
  return "Volatile / Unclear";
}

/** Plain-English one-liner for stock vs 0DTE alert cards (session-aware). */
export function alertKindExplanation({ asset_class, session }) {
  const ac = String(asset_class ?? "options").toLowerCase();
  const sess = String(session ?? "regular").toLowerCase();
  if (ac === "stock") {
    if (sess === "premarket") return "Premarket share callout — no options session yet.";
    if (sess === "afterhours") return "After-hours share callout — extended session only.";
    return "Share callout — underlying only, no option contract.";
  }
  if (sess === "regular") return "0DTE option callout during regular market hours.";
  if (sess === "premarket") return "0DTE setup noted before the open — options trade at 9:30 ET.";
  if (sess === "afterhours") return "0DTE context after the close — new option entries wait for open.";
  return "0DTE option momentum callout.";
}

/** Section divider label when grouping alerts by session. */
export function sessionGroupLabel(session, assetClass) {
  const ac = String(assetClass ?? "options").toLowerCase();
  const sess = String(session ?? "regular").toLowerCase();
  if (ac === "stock") {
    if (sess === "premarket") return "Premarket · Shares";
    if (sess === "afterhours") return "After hours · Shares";
    return "Extended · Shares";
  }
  return "Regular hours · 0DTE options";
}

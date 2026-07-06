/**
 * language-modes.js — the two wording modes and the public-safety guard.
 *
 * MODE "private": labels only I see (A+ Setup, Possible Call Setup, ...).
 * MODE "public": screenshot/stream/Discord-safe labels. Public output must
 * NEVER contain directive trading language; containsBannedPublicLanguage()
 * is the runtime + test-time guard for that, and the Discord sender refuses
 * any payload that fails it.
 *
 * Pure functions — no network, no DB. Safe to unit test.
 */

export const LANGUAGE_MODES = ["private", "public"];

/** Words/phrases that must never appear in public-mode output (whole-word). */
const BANNED_PUBLIC_PATTERNS = [
  /\bbuy\b/i,
  /\bsell\b/i,
  /\bbuy now\b/i,
  /\bstrong buy\b/i,
  /\btake this (trade|call|put)\b/i,
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

/** Score band -> label, per spec:
 * 90-100 A+ / 80-89 High-Quality / 70-79 Watchlist / 60-69 Needs Confirmation
 * / <60 Low Quality. Extreme risk overrides to Skip in private mode. */
export function privateLabel(setupScore, opts = {}) {
  const s = Number(setupScore ?? 0);
  if (opts.riskLabel === "Extreme Risk / Avoid") return "Skip / Too Risky";
  if (s >= 90) return "A+ Setup";
  if (s >= 80) return "High-Quality Alert";
  if (s >= 70) return "Watchlist Candidate";
  if (s >= 60) return "Needs Confirmation";
  return "Low Quality / Ignore";
}

/** Secondary private hint for direction (allowed in private mode only). */
export function privateSideHint(side) {
  if (side === "call") return "Possible Call Setup";
  if (side === "put") return "Possible Put Setup";
  return null;
}

/** Public/education-mode label. Never directive. */
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

/** Direction label; "neutral"/unknown reads as Volatile (both-ways risk). */
export function directionLabel(direction) {
  if (direction === "bullish") return "Bullish momentum";
  if (direction === "bearish") return "Bearish momentum";
  return "Volatile / Unclear";
}

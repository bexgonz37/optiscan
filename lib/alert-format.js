/**
 * alert-format.js — pure payload formatters for every notification channel.
 *
 * formatPrivatePopup: full detail, private-mode labels (browser popup only).
 * formatPublicAlert:  education-safe wording for screenshots/streams.
 * formatDiscordAlert: public wording by default; the sender additionally
 *                     runtime-guards with containsBannedPublicLanguage and
 *                     refuses to send anything that fails.
 *
 * Pure functions — unit tested for public-wording safety.
 */

import {
  privateLabel,
  privateSideHint,
  publicLabel,
  riskLabel,
  suggestedAction,
  directionLabel,
  containsBannedPublicLanguage,
} from "./language-modes.js";

const liqWord = (n) => (n >= 80 ? "Good" : n >= 50 ? "Fair" : "Thin");
const num = (v, fb = "—") => (typeof v === "number" && Number.isFinite(v) ? v : fb);

export function formatPrivatePopup(a = {}) {
  const rl = riskLabel(a.riskScore);
  const label = privateLabel(a.setupScore, { riskLabel: rl });
  const hint = privateSideHint(a.optionSide);
  return {
    mode: "private",
    title: `${label}: ${a.ticker ?? "?"}`,
    direction: directionLabel(a.direction),
    sideHint: hint,
    setupScore: num(a.setupScore, 0),
    riskScore: num(a.riskScore, 0),
    riskLabel: rl,
    liquidity: `${liqWord(Number(a.liquidityScore ?? 0))} (${Math.round(Number(a.liquidityScore ?? 0))}/100)`,
    catalyst: `${(a.catalystType ?? "no_clear_catalyst").replace(/_/g, " ")} · ${a.catalystQuality ?? "unknown"}`,
    move: num(a.movePct, null),
    relVol: num(a.relVol, null),
    contractArea: a.optionSymbol
      ? `${a.strike ?? ""}${String(a.optionSide ?? "").toUpperCase().slice(0, 1)} ${a.expiration ?? ""} · Δ${num(a.delta, "—")}`
      : null,
    suggestedAction: `${suggestedAction(a.setupScore, a.riskScore)} / Journal`,
    explanation: a.explanation ?? "",
  };
}

export function formatPublicAlert(a = {}) {
  const rl = riskLabel(a.riskScore);
  return {
    mode: "public",
    title: `${publicLabel(a.setupScore, { riskLabel: rl })}: ${a.ticker ?? "?"}`,
    summary: "Momentum + catalyst scan hit.",
    setupScore: num(a.setupScore, 0),
    liquidity: liqWord(Number(a.liquidityScore ?? 0)),
    risk: rl.replace(" / Avoid", ""),
    note: "Educational market signal only. Not financial advice.",
    explanation: a.publicExplanation ?? "",
  };
}

/** Discord message body (markdown-ish). ALWAYS public wording. */
export function formatDiscordAlert(a = {}) {
  const p = formatPublicAlert(a);
  const lines = [
    `**${p.title}**`,
    p.summary,
    `Setup Score: ${p.setupScore}/100 · Options Liquidity: ${p.liquidity} · Risk: ${p.risk}`,
    p.explanation ? p.explanation : null,
    `_${p.note}_`,
  ].filter(Boolean);
  const content = lines.join("\n");
  return { content, safe: !containsBannedPublicLanguage(content) };
}

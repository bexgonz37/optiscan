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
import { computeTradeVerdict } from "./trade-verdict.ts";

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

/** Discord message body. Public mode = education-safe; private mode = direct verdict. */
export function formatDiscordAlert(a = {}, { languageMode = "public" } = {}) {
  if (languageMode === "private") {
    const v = computeTradeVerdict({
      ticker: a.ticker,
      direction: a.direction,
      trade_bias: a.tradeBias ?? a.trade_bias,
      signal_score: a.setupScore ?? a.signal_score,
      risk_score: a.riskScore ?? a.risk_score,
      option_worth_score: a.optionWorthScore ?? a.option_worth_score,
      worth_verdict: a.worthVerdict ?? a.worth_verdict,
      zero_dte_contract_score: a.zeroDteContractScore ?? a.zero_dte_contract_score,
      options_liquidity_score: a.liquidityScore ?? a.options_liquidity_score,
      move_status: a.moveStatus ?? a.move_status,
      risk_flags: typeof a.riskFlags === "string" ? a.riskFlags : a.risk_flags,
      option_side: a.optionSide ?? a.option_side,
      strike: a.strike,
      expiration: a.expiration,
      dte: a.dte,
      percent_move_at_alert: a.movePct ?? a.percent_move_at_alert,
      long_call_score: a.longCallScore ?? a.long_call_score,
      long_put_score: a.longPutScore ?? a.long_put_score,
      short_rate_at_alert: a.shortRate ?? a.short_rate_at_alert,
      volume_surge_at_alert: a.volumeSurge ?? a.volume_surge_at_alert,
    });
    const lines = [
      `**${a.ticker ?? "?"}** — **${v.headline}**`,
      v.contractLine,
      v.reason,
      `Setup ${Math.round(Number(a.setupScore ?? a.signal_score ?? 0))}/100 · Worth-it ${Math.round(Number(a.optionWorthScore ?? a.option_worth_score ?? 0))}/100 · Confidence ${v.confidence}%`,
      `_Research signal — not financial advice._`,
    ].filter(Boolean);
    return { content: lines.join("\n"), safe: true };
  }

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

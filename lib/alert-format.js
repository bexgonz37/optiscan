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
import { computeTradeVerdict, formatSpeedLine } from "./trade-verdict.ts";

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

/** Stock (premarket/after-hours) Discord body — no option contract line ever. */
function formatDiscordStockAlert(a = {}, { languageMode = "public" } = {}) {
  const sessionWord = a.session === "afterhours" ? "After-hours" : "Premarket";
  const move = num(a.movePct, null);
  const moveLine = move != null ? `${move > 0 ? "+" : ""}${move.toFixed(1)}% on the day` : null;
  const speed = num(a.shortRate, null);
  const speedLine = speed != null ? `Speed ${speed > 0 ? "+" : ""}${speed.toFixed(2)}%/min` : null;
  const surge = num(a.volumeSurge, null);

  if (languageMode === "private") {
    const lines = [
      `**${a.ticker ?? "?"}** — **${a.stockHeadline ?? "STOCK SIGNAL"}** (${sessionWord} stock — shares, not options)`,
      a.stockReason ? `**Why:** ${a.stockReason}` : null,
      [moveLine, speedLine, surge != null ? `Volume ${surge.toFixed(1)}x` : null].filter(Boolean).join(" · ") || null,
      `Setup ${Math.round(Number(a.setupScore ?? 0))}/100 · **Confidence ${Math.round(Number(a.confidence ?? 0))}%**`,
      `_${sessionWord} research signal — not financial advice._`,
    ].filter(Boolean);
    return { content: lines.join("\n"), safe: true };
  }

  const lines = [
    `**${sessionWord} momentum: ${a.ticker ?? "?"}**`,
    [moveLine, surge != null ? `volume ${surge.toFixed(1)}x` : null].filter(Boolean).join(" · ") || "Momentum scan hit.",
    `Setup Score: ${Math.round(Number(a.setupScore ?? 0))}/100`,
    `_Educational market signal only. Not financial advice._`,
  ].filter(Boolean);
  const content = lines.join("\n");
  return { content, safe: !containsBannedPublicLanguage(content) };
}

/** Discord message body. Public mode = education-safe; private mode = direct verdict. */
export function formatDiscordAlert(a = {}, { languageMode = "public" } = {}) {
  if (a.assetClass === "stock") return formatDiscordStockAlert(a, { languageMode });
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
      alert_tier: a.alertTier ?? a.alert_tier,
    });
    const speedLine = formatSpeedLine({
      short_rate_at_alert: a.shortRate ?? a.short_rate_at_alert,
      volume_surge_at_alert: a.volumeSurge ?? a.volume_surge_at_alert,
      percent_move_at_alert: a.movePct ?? a.percent_move_at_alert,
    });
    const lines = [
      `**${a.ticker ?? "?"}** — **${v.headline}** (0DTE options)`,
      v.contractLine ? `Contract: ${v.contractLine}` : null,
      `**Why:** ${v.reason}`,
      speedLine,
      `Setup ${Math.round(Number(a.setupScore ?? a.signal_score ?? 0))}/100 · Worth-it ${Math.round(Number(a.optionWorthScore ?? a.option_worth_score ?? 0))}/100 · **Confidence ${v.confidence}%**`,
      `Risk ${Math.round(Number(a.riskScore ?? a.risk_score ?? 0))}/100 · Liquidity ${Math.round(Number(a.liquidityScore ?? a.options_liquidity_score ?? 0))}/100`,
      `_Research signal — not financial advice._`,
    ].filter(Boolean);
    return { content: lines.join("\n"), safe: true };
  }

  const p = formatPublicAlert(a);
  const lines = [
    `**0DTE options: ${p.title}**`,
    p.summary,
    `Setup Score: ${p.setupScore}/100 · Options Liquidity: ${p.liquidity} · Risk: ${p.risk}`,
    p.explanation ? p.explanation : null,
    `_${p.note}_`,
  ].filter(Boolean);
  const content = lines.join("\n");
  return { content, safe: !containsBannedPublicLanguage(content) };
}

/** Discord embed colors (decimal). */
export const DISCORD_COLORS = {
  call: 3526783,
  put: 15885146,
  neutral: 2895667,
  scoreboard: 3526783,
};

const fmtUsd = (v) => (typeof v === "number" && Number.isFinite(v) ? `$${v.toFixed(2)}` : "—");
const fmtPct1 = (v) => (typeof v === "number" && Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(1)}%` : "—");
const sideWord = (s) => (String(s ?? "").toLowerCase().startsWith("p") ? "PUT" : "CALL");
const monthShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtPremium = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "";
  const fixed = v.toFixed(2);
  return v < 1 ? fixed.replace(/^0/, "") : fixed;
};
const fmtStrike = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "?");
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(2));
};
function fmtExpiration(expiration, dte = null) {
  if (expiration) {
    const raw = String(expiration).slice(0, 10);
    const parts = raw.split("-").map((p) => Number(p));
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      const [y, m, d] = parts;
      return `${d} ${monthShort[Math.max(0, Math.min(11, m - 1))]} ${String(y).slice(-2)}`;
    }
  }
  if (dte != null) return `${dte}DTE`;
  return "";
}
function compactOptionsLine(alert = {}) {
  const ticker = String(alert.ticker ?? "?").replace(/^\$/, "").toUpperCase();
  const side = sideWord(alert.optionSide ?? alert.option_side);
  const strike = fmtStrike(alert.strike);
  const exp = fmtExpiration(alert.expiration, alert.dte);
  const mid = fmtPremium(alert.optionMid ?? alert.option_mid ?? alert.entry_mid);
  return [`$${ticker}`, exp, `$${strike}`, side, mid].filter(Boolean).join(" ");
}
const sessionLabel = (s) => {
  if (s === "premarket") return "Premarket";
  if (s === "afterhours") return "After-hours";
  if (s === "regular") return "Regular hours";
  return "Session";
};

function roleMention(envKey) {
  const id = String(process.env[envKey] ?? "").trim();
  return id ? `<@&${id}>` : "";
}

function optionColor(side) {
  return String(side ?? "").toLowerCase().startsWith("p") ? DISCORD_COLORS.put : DISCORD_COLORS.call;
}

function needsMovePct(alert) {
  const mid = alert.optionMid ?? alert.option_mid;
  const spot = alert.price ?? alert.priceAtAlert ?? alert.price_at_alert;
  if (typeof mid !== "number" || typeof spot !== "number" || spot <= 0) return null;
  return +((mid / spot) * 100).toFixed(2);
}

function gatesLine() {
  return "**Every gate passed** — speed ✓ volume ✓ trend ✓ fillable ✓";
}

/** Full webhook JSON for a 0DTE BUY ping. */
export function buildOptionsBuyEmbed(alert = {}, { roleIdEnv = "DISCORD_ROLE_0DTE" } = {}) {
  const ticker = alert.ticker ?? "?";
  const side = sideWord(alert.optionSide ?? alert.option_side);
  const strike = alert.strike ?? "?";
  const dte = alert.dte ?? 0;
  const mid = alert.optionMid ?? alert.option_mid;
  const spread = alert.spreadPct ?? alert.spread_pct;
  const delta = alert.delta;
  const speed = alert.shortRate ?? alert.short_rate_at_alert;
  const surge = alert.volumeSurge ?? alert.volume_surge_at_alert;
  const needs = needsMovePct(alert);
  const mention = roleMention(roleIdEnv);
  const v = computeTradeVerdict({
    ticker,
    direction: alert.direction,
    trade_bias: alert.tradeBias ?? alert.trade_bias,
    signal_score: alert.setupScore ?? alert.signal_score,
    risk_score: alert.riskScore ?? alert.risk_score,
    option_worth_score: alert.optionWorthScore ?? alert.option_worth_score,
    worth_verdict: alert.worthVerdict ?? alert.worth_verdict,
    zero_dte_contract_score: alert.zeroDteContractScore ?? alert.zero_dte_contract_score,
    options_liquidity_score: alert.liquidityScore ?? alert.options_liquidity_score,
    move_status: alert.moveStatus ?? alert.move_status,
    risk_flags: typeof alert.riskFlags === "string" ? alert.riskFlags : alert.risk_flags,
    option_side: alert.optionSide ?? alert.option_side,
    strike: alert.strike,
    expiration: alert.expiration,
    dte,
    percent_move_at_alert: alert.movePct ?? alert.percent_move_at_alert,
    short_rate_at_alert: speed,
    volume_surge_at_alert: surge,
    alert_tier: "trade",
    capture_action: "TRADE",
  });
  const speedTxt = speed != null ? `${speed > 0 ? "+" : ""}${speed.toFixed(2)}%/min` : "—";
  const spreadTxt = spread != null ? `${spread.toFixed(1)}%` : "—";
  const needsTxt = needs != null ? `${needs.toFixed(2)}% move` : "—";
  const compactLine = compactOptionsLine(alert);
  const pushLineSocial = `${compactLine} · spread ${spreadTxt} · needs ${needs != null ? needs.toFixed(2) : "—"}%`;
  const content = mention ? `${pushLineSocial} ${mention}` : pushLineSocial;
  const deltaTxt = delta != null ? (delta < 0 ? `−${Math.abs(delta).toFixed(2)}` : delta.toFixed(2)) : "—";
  const payload = {
    content,
    embeds: [{
      color: optionColor(side),
      author: { name: "OPTISCAN · options" },
      title: compactLine,
      description: `${v.reason}\n\n${gatesLine()}`,
      fields: [
        { name: "Entry (mid)", value: fmtUsd(mid), inline: true },
        { name: "Spread", value: spreadTxt, inline: true },
        { name: "Needs", value: needsTxt, inline: true },
        { name: "Delta", value: deltaTxt, inline: true },
        { name: "Speed now", value: speedTxt, inline: true },
        { name: "Volume", value: surge != null ? `${surge.toFixed(1)}× normal` : "—", inline: true },
      ],
      footer: { text: "Fresh for 5 minutes — after that, don't chase · research signal, not financial advice" },
      timestamp: new Date().toISOString(),
    }],
  };
  // Private Discord product channel — direct BUY wording is intentional.
  const safe = true;
  return { payload, safe };
}

/** Shares LONG/SHORT BUY ping. */
export function buildStockBuyEmbed(alert = {}, { roleIdEnv = "DISCORD_ROLE_STOCKS" } = {}) {
  const ticker = alert.ticker ?? "?";
  const session = sessionLabel(alert.session);
  const isShort = alert.direction === "bearish" || String(alert.stockHeadline ?? "").toUpperCase().includes("SHORT");
  const side = isShort ? "SHORT" : "LONG";
  const price = alert.price ?? alert.priceAtAlert;
  const speed = alert.shortRate ?? alert.short_rate_at_alert;
  const surge = alert.volumeSurge ?? alert.volume_surge_at_alert;
  const move = alert.movePct ?? alert.percent_move_at_alert;
  const mention = roleMention(roleIdEnv);
  const speedTxt = speed != null ? `${speed > 0 ? "+" : ""}${speed.toFixed(2)}%/min` : "—";
  const pushLine = `🟢 ${side} — ${ticker} shares @ ~${fmtUsd(price)} · ${session.toLowerCase()} · moving ${speedTxt}`;
  const content = mention ? `${pushLine} ${mention}` : pushLine;
  const riskLine = alert.riskLine ?? (price != null
    ? (isShort ? `back above $${(price * 1.02).toFixed(2)} = thesis dead` : `back under $${(price * 0.98).toFixed(2)} = thesis dead`)
    : "—");
  const payload = {
    content,
    embeds: [{
      color: isShort ? DISCORD_COLORS.put : DISCORD_COLORS.call,
      author: { name: `OPTISCAN · stocks · ${session.toLowerCase()}` },
      title: `${side} ${ticker} · shares @ ~${fmtUsd(price)}`,
      description: `${alert.stockReason ?? alert.reason ?? "Clean directional tape with volume confirmation."}\n\n${gatesLine().replace("fillable", "clean tape")}`,
      fields: [
        { name: "Entry area", value: price != null ? `$${(price * 0.998).toFixed(2)} – ${(price * 1.002).toFixed(2)}` : "—", inline: true },
        { name: "Speed now", value: speedTxt, inline: true },
        { name: "Volume", value: surge != null ? `${surge.toFixed(1)}× normal` : "—", inline: true },
        { name: "Day move", value: move != null ? fmtPct1(move) : "—", inline: true },
        { name: "Session", value: session, inline: true },
        { name: "Risk line", value: riskLine, inline: true },
      ],
      footer: { text: "Fresh for 10 minutes · shares move slower than 0DTE · research signal, not financial advice" },
      timestamp: new Date().toISOString(),
    }],
  };
  // Private owner stock webhook: this payload is intentionally direct because
  // it goes to the configured trading-ops Discord, not public social copy.
  // Public/Twitter-safe copy still goes through formatPublicSocialPost().
  const safe = true;
  return { payload, safe };
}

/** Quiet WATCH — no role mention, neutral color. */
export function buildWatchEmbed(alert = {}) {
  const ticker = alert.ticker ?? "?";
  const side = sideWord(alert.optionSide ?? alert.option_side ?? (alert.direction === "bearish" ? "put" : "call"));
  const strike = alert.strike ?? "?";
  const spread = alert.spreadPct ?? alert.spread_pct;
  const delta = alert.delta;
  const speed = alert.shortRate ?? alert.short_rate_at_alert;
  const minSpeed = alert.minSpeed ?? 0.2;
  const payload = {
    embeds: [{
      color: DISCORD_COLORS.neutral,
      description: [
        `👀 **WATCH ${side} — ${ticker} $${strike}${String(side)[0]}** · armed, not ready`,
        `Spread ${spread != null ? `${spread.toFixed(1)}% ✓` : "—"} · delta ${delta != null ? delta.toFixed(2) : "—"} ✓ · needs speed ≥ ${minSpeed.toFixed(2)}%/min (now ${speed != null ? `${speed > 0 ? "+" : ""}${speed.toFixed(2)}` : "—"})`,
        "*No action — this either fires as a BUY or dies quietly.*",
      ].join("\n"),
    }],
  };
  const safe = !containsBannedPublicLanguage(JSON.stringify(payload));
  return { payload, safe };
}

/** Daily / weekly track-record scoreboard embed. */
export function buildScoreboardEmbed(stats = {}, rows = [], { weekly = false, dashboardUrl = "" } = {}) {
  const wins = stats.wins ?? 0;
  const losses = stats.losses ?? 0;
  const graded = wins + losses;
  const optionCompleted = (stats.optionWins ?? 0) + (stats.optionLosses ?? 0);
  const winRate = stats.optionWinRate != null
    ? Math.round(stats.optionWinRate * 100)
    : (optionCompleted > 0 ? Math.round(((stats.optionWins ?? 0) / optionCompleted) * 100) : null);
  const paybackPct = stats.paybackWithin10mPct != null ? Math.round(stats.paybackWithin10mPct * 100) : null;
  const avgWin = stats.avgWinnerPct != null ? `+${Math.round(stats.avgWinnerPct)}%` : stats.avgOptionReturn != null ? fmtPct1(stats.avgOptionReturn) : "—";
  const avgLoss = stats.avgLoserPct != null ? `−${Math.abs(Math.round(stats.avgLoserPct))}%` : "—";
  const title = stats.title ?? (weekly ? "Weekly recap" : "Daily scoreboard");
  const headline = graded
    ? `**${stats.optionWins ?? wins} of ${optionCompleted || graded} callouts paid · ${winRate ?? "—"}% on the order**`
    : "**No graded callouts yet today**";
  const paybackLine = paybackPct != null
    ? `\n\n**${paybackPct}%** of this ${weekly ? "week's" : "month's"} pings paid within **10 minutes** of the notification.`
    : "";
  const desc = `${headline}\nAvg winner **${avgWin}** · avg loser **${avgLoss}** · graded entry mid → best mid, never the chart${paybackLine}`;
  const url = dashboardUrl || "/alerts";
  const fields = (rows ?? []).slice(0, 6).map((r) => ({
    name: r.emoji ? `${r.emoji} ${r.label}` : r.label,
    value: r.value,
    inline: true,
  }));
  const payload = {
    embeds: [{
      color: DISCORD_COLORS.scoreboard,
      title,
      description: desc,
      fields,
      footer: { text: `Every callout counted, losers included · full dashboard: ${url}` },
    }],
  };
  const safe = !containsBannedPublicLanguage(JSON.stringify(payload));
  return { payload, safe };
}

/** Append a 5m / Result field to an existing embed payload. */
export function patchDiscordResultEmbed(basePayload, { fieldName, fieldValue, final = false, paid = false } = {}) {
  const payload = JSON.parse(JSON.stringify(basePayload ?? { embeds: [{}] }));
  const embed = payload.embeds?.[0] ?? {};
  embed.fields = [...(embed.fields ?? [])];
  const existing = embed.fields.findIndex((f) => f.name === fieldName);
  const field = { name: fieldName, value: fieldValue, inline: fieldName === "5 min" };
  if (existing >= 0) embed.fields[existing] = field;
  else embed.fields.push(field);
  if (final) embed.color = paid ? embed.color : DISCORD_COLORS.neutral;
  payload.embeds = [embed];
  return payload;
}

export function formatResultField5m({ mid, returnPct, running = true } = {}) {
  const pct = returnPct != null ? `${returnPct > 0 ? "+" : ""}${Math.round(returnPct)}%` : "—";
  return `mid ${fmtUsd(mid)} · ${pct}${running ? " ✅ running" : ""}`;
}

export function formatResultFieldFinal({ returnPct, paid, paidInMin, neverPaid = false } = {}) {
  const pct = returnPct != null ? `**${returnPct > 0 ? "+" : ""}${Math.round(returnPct)}%**` : "**—**";
  if (paid && paidInMin != null) return `${pct} · topped · paid in ${paidInMin} min ✅`;
  if (neverPaid || !paid) return `${pct} · never paid · expired ❌`;
  return `${pct} · graded`;
}

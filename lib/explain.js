/**
 * explain.js — deterministic, rules-based explanation builder.
 *
 * Produces the six-section read for every alert:
 *   why it triggered / what supports it / what makes it risky /
 *   options liquidity read / what would confirm / what would invalidate.
 *
 * Everything is templated from REAL computed values (scores, rates, spread,
 * OI, move status). No model calls, nothing invented — AI is OPTIONAL by
 * design: these templates ARE the fallback and the default. If a value is
 * unknown it says so.
 *
 * 0DTE stance on news: catalysts are optional context. "No news" is stated
 * neutrally — it is NEVER listed as a risk for a momentum tape.
 *
 * Private mode may reference call/put watch zones; public mode is educational
 * only and must pass containsBannedPublicLanguage() (enforced by tests and by
 * the Discord sender at runtime).
 */

import { directionLabel, riskLabel, suggestedAction } from "./language-modes.js";
import { MOVE_STATUS_LABEL } from "./zero-dte.js";

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const pct = (n, d = 1) => (isNum(n) ? `${n > 0 ? "+" : ""}${n.toFixed(d)}%` : "n/a");

function catalystContext(a) {
  const q = a.catalystQuality ?? "unknown";
  if (!a.catalystType || a.catalystType === "no_clear_catalyst" || q === "unknown") {
    return "No news driver found — pure momentum tape (context only, not a penalty).";
  }
  const type = String(a.catalystType).replace(/_/g, " ");
  if (q === "stale") return `Background note: ${type} headline exists but is old (stale) — context only.`;
  return `Context: ${q} ${type} headline${a.catalystSummary ? ` — "${String(a.catalystSummary).slice(0, 80)}"` : ""}.`;
}

/** Build all six sections. Returns { sections, text } for the given mode. */
export function buildExplanation(a = {}, mode = "private") {
  const dir = directionLabel(a.direction);
  const rl = riskLabel(a.riskScore);
  const action = suggestedAction(a.setupScore, a.riskScore);
  const liq = Number(a.liquidityScore ?? 0);
  const dirUp = a.direction !== "bearish";
  const statusLabel = a.moveStatus ? (MOVE_STATUS_LABEL[a.moveStatus] ?? a.moveStatus) : null;

  const whyBits = [`${a.ticker ?? "This ticker"} is moving ${pct(a.movePct)}`];
  if (isNum(a.shortRate) && Math.abs(a.shortRate) >= 0.1) whyBits.push(`${dirUp ? "accelerating up" : "accelerating down"} at ~${Math.abs(a.shortRate).toFixed(2)}%/min`);
  if (a.levelBreak) whyBits.push(dirUp ? "breaking toward/through high of day" : "breaking toward/through low of day");
  if (a.vwapAligned != null) whyBits.push(a.vwapAligned ? (dirUp ? "holding above VWAP" : "holding below VWAP") : "fighting VWAP");
  if (isNum(a.relVol) && a.relVol >= 1.5) whyBits.push(`on ${a.relVol}x relative volume`);
  else if (isNum(a.surge) && a.surge >= 1.3) whyBits.push(`with volume surging ${a.surge}x`);
  const whyTriggered = whyBits.join(", ") + ".";

  const supports = [];
  if (statusLabel && (a.moveStatus === "early" || a.moveStatus === "continuing")) supports.push(`move reads as ${statusLabel} — still going, not late`);
  if (a.levelBreak) supports.push(dirUp ? "high-of-day break with participation" : "low-of-day break with participation");
  if (a.vwapAligned) supports.push(dirUp ? "buyers defending VWAP" : "sellers rejecting VWAP");
  if ((isNum(a.surge) && a.surge >= 1.3) || (isNum(a.relVol) && a.relVol >= 2)) supports.push("volume confirms the move");
  if (isNum(a.zeroDteScore) && a.zeroDteScore >= 65) supports.push(`0DTE contracts are workable (${Math.round(a.zeroDteScore)}/100)`);
  if (!supports.length) supports.push("little confirmation beyond the raw move");

  const risks = [];
  if (a.moveStatus === "extended_risky") risks.push("extended and decelerating — classic chase shape");
  if (a.moveStatus === "exhausted") risks.push("momentum has already rolled over");
  if (isNum(a.efficiency) && a.efficiency < 0.3) risks.push(`tape is choppy (efficiency ${a.efficiency}) — whipsaw risk`);
  if (isNum(a.spreadPct) && a.spreadPct > 8) risks.push(`option spreads are wide (${a.spreadPct}%)`);
  if (isNum(a.ivPct) && a.ivPct > 250) risks.push(`IV is hot (~${Math.round(a.ivPct)}%) — premium priced for chaos`);
  if (isNum(a.minsToClose) && a.minsToClose < 45) risks.push("late-day: theta cliff and closing rotations");
  for (const f of a.riskFlags ?? []) if (!risks.some((r) => r.toLowerCase().includes(f.toLowerCase().slice(0, 6)))) risks.push(f);
  if (!risks.length) risks.push("no outsized structural red flags; normal 0DTE risk still applies (fast theta, fast reversals)");

  const liquidityRead = liq >= 80
    ? `Options liquidity is good (${Math.round(liq)}/100): spreads and depth are workable for fast entries/exits.`
    : liq >= 50
      ? `Options liquidity is fair (${Math.round(liq)}/100): tradable but check the live spread before acting.`
      : `Options liquidity is poor (${Math.round(liq)}/100): thin and/or wide — the signal may not be actionable.`;

  const confirm = [
    dirUp ? "holding above VWAP" : "holding below VWAP",
    dirUp ? "breaking/holding high of day" : "breaking/holding low of day",
    "volume expanding on the next push",
    `${dirUp ? "call" : "put"} spreads staying tight`,
  ];
  const invalidate = [
    dirUp ? "losing VWAP" : "reclaiming VWAP against the move",
    dirUp ? "rejecting at high of day" : "bouncing hard off low of day",
    "volume fading while price stalls",
    "spreads widening or IV spiking",
  ];

  const sections = {
    whyTriggered, supports, risks, liquidityRead, confirm, invalidate, action,
    riskLabel: rl, moveStatus: statusLabel, catalystContext: catalystContext(a),
  };

  if (mode === "public") {
    const text = [
      whyTriggered,
      statusLabel ? `Move status: ${statusLabel}.` : null,
      liquidityRead,
      `Risk read: ${rl}.`,
      "Educational scanner alert for research only. Not financial advice.",
    ].filter(Boolean).join(" ");
    return { sections, text };
  }

  const text = [
    `Why it triggered: ${whyTriggered}`,
    statusLabel ? `Move status: ${statusLabel}${a.worthItVerdict ? ` · Option still worth it: ${a.worthItVerdict}` : ""}.` : null,
    `Supports: ${supports.join("; ")}.`,
    `Risks: ${risks.join("; ")}.`,
    `Liquidity: ${liquidityRead}`,
    `Would confirm: ${confirm.join("; ")}.`,
    `Would invalidate: ${invalidate.join("; ")}.`,
    sections.catalystContext,
    `Read: ${dir} · ${rl} · suggested handling: ${action} / Journal.`,
  ].filter(Boolean).join("\n");
  return { sections, text };
}

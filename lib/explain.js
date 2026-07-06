/**
 * explain.js — deterministic, rules-based explanation builder.
 *
 * Produces the six-section read for every alert:
 *   why it triggered / what supports it / what makes it risky /
 *   options liquidity read / what would confirm / what would invalidate.
 *
 * Everything is templated from REAL computed values (scores, relVol, spread,
 * OI, catalyst classification). No model calls, nothing invented — if a value
 * is unknown it says so. An LLM layer can be added later for prose polish,
 * but decisions stay deterministic per the system design.
 *
 * Private mode may reference call/put setup zones; public mode is educational
 * only and must pass containsBannedPublicLanguage() (enforced by tests and by
 * the Discord sender at runtime).
 */

import { directionLabel, riskLabel, suggestedAction } from "./language-modes.js";

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const pct = (n, d = 1) => (isNum(n) ? `${n > 0 ? "+" : ""}${n.toFixed(d)}%` : "n/a");

function catalystPhrase(a) {
  const type = (a.catalystType ?? "no_clear_catalyst").replace(/_/g, " ");
  const q = a.catalystQuality ?? "unknown";
  if (a.catalystType === "no_clear_catalyst" || q === "unknown") {
    return "no clear catalyst was found in recent headlines — the move is unexplained";
  }
  if (q === "stale") return `the ${type} headline is old (stale) relative to today's move`;
  return `a ${q} ${type} catalyst${a.catalystSummary ? `: "${String(a.catalystSummary).slice(0, 90)}"` : ""}`;
}

/** Build all six sections. Returns { sections, text } for the given mode. */
export function buildExplanation(a = {}, mode = "private") {
  const dir = directionLabel(a.direction);
  const rl = riskLabel(a.riskScore);
  const action = suggestedAction(a.setupScore, a.riskScore);
  const absMove = Math.abs(Number(a.movePct ?? 0));
  const extended = absMove > 8;
  const liq = Number(a.liquidityScore ?? 0);

  const whyTriggered = [
    `${a.ticker ?? "This ticker"} moved ${pct(a.movePct)}`,
    isNum(a.relVol) ? `on ${a.relVol}x relative volume` : "with relative volume unknown",
    `and ${catalystPhrase(a)}.`,
  ].join(" ");

  const supports = [];
  if (isNum(a.relVol) && a.relVol >= 2) supports.push(`relative volume ${a.relVol}x confirms real participation`);
  if (a.catalystQuality === "strong" || a.catalystQuality === "medium") supports.push(`the catalyst is ${a.catalystQuality} and recent`);
  if (liq >= 60) supports.push("the options market is liquid enough to research");
  if (a.hasUnusualFlow) supports.push("unusual options volume is confirming the equity move");
  if (a.trendAligned) supports.push("short-term trend structure agrees with the direction");
  if (!supports.length) supports.push("little independent confirmation beyond the price move itself");

  const risks = [];
  if (extended) risks.push(`the move is already extended (${pct(a.movePct)}) — chasing risk is high`);
  if (a.catalystType === "no_clear_catalyst") risks.push("no documented catalyst behind the move");
  if (a.catalystQuality === "stale") risks.push("the only catalyst found is stale");
  if (isNum(a.spreadPct) && a.spreadPct > 12) risks.push(`option spreads are wide (${a.spreadPct}%)`);
  if (isNum(a.openInterest) && a.openInterest < 200) risks.push(`open interest is thin (${a.openInterest})`);
  if (isNum(a.ivPct) && a.ivPct > 150) risks.push(`implied volatility is extreme (~${Math.round(a.ivPct)}%)`);
  if (!risks.length) risks.push("no outsized structural red flags detected; normal market risk still applies");

  const liquidityRead = liq >= 80
    ? `Options liquidity is good (${Math.round(liq)}/100): spreads and depth are workable.`
    : liq >= 50
      ? `Options liquidity is fair (${Math.round(liq)}/100): tradable but check the spread on the specific contract.`
      : `Options liquidity is poor (${Math.round(liq)}/100): contracts are thin and/or wide — signal may not be actionable.`;

  const confirm = [
    a.direction === "bearish"
      ? "price staying below VWAP with sustained volume"
      : "price holding above VWAP with sustained volume",
    "relative volume staying elevated on the next bars",
    a.catalystType === "no_clear_catalyst" ? "a real catalyst emerging in headlines" : "follow-up coverage of the catalyst",
    "option spreads staying tight as volume continues",
  ];

  const invalidate = [
    a.direction === "bearish" ? "a reclaim of VWAP against the move" : "a loss of VWAP",
    "volume fading while price stalls",
    "spreads widening or option volume drying up",
    extended ? "failure to hold after this extended a move" : "an immediate full retrace of the move",
  ];

  const sections = { whyTriggered, supports, risks, liquidityRead, confirm, invalidate, action, riskLabel: rl };

  if (mode === "public") {
    const text = [
      `${whyTriggered}`,
      liquidityRead,
      `Risk read: ${rl}.`,
      "Educational scanner alert for research only. Not financial advice.",
    ].join(" ");
    return { sections, text };
  }

  const text = [
    `Why it triggered: ${whyTriggered}`,
    `Supports: ${supports.join("; ")}.`,
    `Risks: ${risks.join("; ")}.`,
    `Liquidity: ${liquidityRead}`,
    `Would confirm: ${confirm.join("; ")}.`,
    `Would invalidate: ${invalidate.join("; ")}.`,
    `Read: ${dir} · ${rl} · suggested handling: ${action} / Journal.`,
  ].join("\n");
  return { sections, text };
}

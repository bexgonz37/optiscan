/**
 * agents/portfolio.ts — the Supervisor's PORTFOLIO-MANAGER layer. PURE.
 *
 * The base Supervisor (agents/supervisor.ts) already dedups one canonical result
 * per (ticker,direction,horizon), enforces the absolute risk veto, and applies
 * lifecycle hysteresis. This layer runs AFTER callouts are built and answers the
 * portfolio-manager questions the desk cares about:
 *
 *   1. RANK every idea against every other idea (setup + contract quality,
 *      liquidity, spread, freshness, evidence, validated probability, status,
 *      and core-universe priority) — quality dominates, core is a tie-breaker
 *      bonus, never a hard veto (§1, §5, §7).
 *   2. RECONCILE conflicting theses per ticker: if bullish and bearish ideas both
 *      look actionable and neither clearly dominates, do NOT emit contradictory
 *      actionable alerts — demote to a single WATCH describing the disagreement
 *      (§2).
 *   3. ANTI-CHASE: never keep an idea ACTIONABLE once the entry window has run —
 *      downgrade extended entries to WAIT_FOR_PULLBACK/EXTENDED (§4).
 *   4. SELECT only the strongest few for Discord (owner cap + quality + owner
 *      category/direction/quality gates) — fewer, higher-quality alerts (§1, §6).
 *
 * It NEVER fabricates data, changes contract selection, weakens a risk/freshness
 * gate, or makes a hard-blocked idea actionable. It only ranks, reconciles
 * lifecycle status, and chooses what reaches Discord — all from fields already on
 * the callout.
 */
import type { Callout } from "../callouts/callout.ts";
import { confidenceTier } from "../callouts/confidence.ts";
import {
  ownerSettings, tickerPriorityRank, isPriorityTicker, type OwnerSettings, type AlertCategory,
} from "../owner-settings.ts";

/** Points a status contributes to portfolio quality (more advanced = stronger).
 * Late/retrospective states are penalized hard so a completed move can never
 * outrank a genuinely early, valid setup (§10). */
const STATUS_QUALITY: Record<string, number> = {
  ACTIONABLE_NOW: 18, NEAR_TRIGGER: 10, WAIT_FOR_PULLBACK: 4, DEVELOPING: 4,
  EXTENDED: -15, MISSED: -30, WATCH: 0, RESEARCH_ONLY: -4,
};

/** Statuses that are candidates for a Discord alert (before owner gating). */
const ALERTABLE = new Set(["ACTIONABLE_NOW", "NEAR_TRIGGER", "DEVELOPING", "WAIT_FOR_PULLBACK"]);
const EARLY_ONLY = new Set(["NEAR_TRIGGER", "DEVELOPING"]);

/** How far ahead one side must score before it "dominates" the other. */
function dominanceMargin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OWNER_THESIS_MARGIN);
  return Number.isFinite(n) && n >= 0 ? n : 12;
}

/**
 * Composite quality of a single callout (roughly 0–130). Built ONLY from fields
 * already verified upstream — no new market data, no fabrication.
 */
export function scoreCalloutQuality(c: Callout, s: OwnerSettings): number {
  let q = typeof c.contractScore === "number" ? c.contractScore : 0; // setup/contract quality 0–100
  q += STATUS_QUALITY[c.status] ?? 0;

  const k = c.contract;
  if (k) {
    // Liquidity + spread: tight, liquid contracts are what a desk actually trades.
    if (k.spreadPct != null) q -= Math.min(30, Math.max(0, k.spreadPct) * 3);
    if (k.openInterest != null) q += k.openInterest >= 1000 ? 6 : k.openInterest >= 200 ? 2 : k.openInterest < 50 ? -8 : 0;
    if (k.volume != null) q += k.volume >= 500 ? 3 : k.volume >= 100 ? 1 : 0;
  } else {
    q -= 25; // no valid contract → not a real trade
  }

  // Freshness gate is already enforced; here it only shades ranking.
  if (c.quoteFreshness !== "fresh") q -= 20;

  // Evidence + VALIDATED probability nudge ranking; an experimental probability
  // never adds edge (research only).
  if (c.evidenceStatus === "ESTABLISHED_EVIDENCE") q += 8;
  if (c.probability != null && !c.probabilityIsExperimental) q += (c.probability - 0.5) * 40;

  // Core-universe priority: a small bonus so ties favor the desk's core names,
  // WITHOUT letting a weak core idea outrank a strong non-core one.
  if (isPriorityTicker(c.ticker, s)) q += 6;

  // §10 — TIMING outranks retrospective strength. A genuinely valid entry window
  // is rewarded; a completed/extended/missed/reversing move is penalized hard so
  // it cannot be selected over a lower-scoring but early, valid setup.
  const es = c.entryState ?? null;
  if (es === "ACTIONABLE") q += 12;
  else if (es === "NEAR_TRIGGER") q += 4;
  else if (es === "EXTENDED" || es === "MISSED" || es === "INVALIDATED") q -= 30;
  else if (es === "WAIT_FOR_PULLBACK" || es === "BLOCKED") q -= 8;

  return Math.round(q * 100) / 100;
}

export type ThesisVerdict = "bullish" | "bearish" | "mixed" | "none";

export interface TickerThesis {
  ticker: string;
  verdict: ThesisVerdict;
  bestBullish: number | null;
  bestBearish: number | null;
}

function isStrong(c: Callout): boolean {
  return c.status === "ACTIONABLE_NOW" || c.status === "NEAR_TRIGGER";
}

/**
 * §2 — Reconcile conflicting theses per ticker. Returns copies of the callouts
 * with contradictory actionable ideas demoted to WATCH (with a disagreement note),
 * plus the per-ticker verdict for audit. Bullish-only or bearish-only tickers pass
 * through unchanged.
 */
export function reconcileTheses(
  callouts: Callout[],
  s: OwnerSettings,
  env: NodeJS.ProcessEnv = process.env,
): { callouts: Callout[]; theses: TickerThesis[] } {
  const margin = dominanceMargin(env);
  const byTicker = new Map<string, Callout[]>();
  for (const c of callouts) byTicker.set(c.ticker, [...(byTicker.get(c.ticker) ?? []), c]);

  const theses: TickerThesis[] = [];
  const out = new Map<string, Callout>(); // key → possibly-adjusted callout

  for (const [ticker, group] of byTicker) {
    const strongBull = group.filter((c) => c.direction === "bullish" && isStrong(c));
    const strongBear = group.filter((c) => c.direction === "bearish" && isStrong(c));
    const bestBull = strongBull.length ? Math.max(...strongBull.map((c) => scoreCalloutQuality(c, s))) : null;
    const bestBear = strongBear.length ? Math.max(...strongBear.map((c) => scoreCalloutQuality(c, s))) : null;

    let verdict: ThesisVerdict = "none";
    if (bestBull != null && bestBear != null) {
      if (bestBull - bestBear >= margin) verdict = "bullish";
      else if (bestBear - bestBull >= margin) verdict = "bearish";
      else verdict = "mixed";
    } else if (bestBull != null) verdict = "bullish";
    else if (bestBear != null) verdict = "bearish";

    theses.push({ ticker, verdict, bestBullish: bestBull, bestBearish: bestBear });

    for (const c of group) {
      let adjusted = c;
      const conflicts = bestBull != null && bestBear != null; // both sides have a strong idea
      if (conflicts && isStrong(c)) {
        if (verdict === "mixed") {
          adjusted = demoteToWatch(c, `Market mixed on ${ticker}: bullish and bearish theses disagree — watch, no actionable entry.`);
        } else if (verdict === "bullish" && c.direction === "bearish") {
          adjusted = demoteToWatch(c, `Opposing thesis: bullish ${ticker} dominates right now — bearish idea held as watch.`);
        } else if (verdict === "bearish" && c.direction === "bullish") {
          adjusted = demoteToWatch(c, `Opposing thesis: bearish ${ticker} dominates right now — bullish idea held as watch.`);
        }
      }
      out.set(adjusted.key, adjusted);
    }
  }

  // Preserve original order.
  return { callouts: callouts.map((c) => out.get(c.key) ?? c), theses };
}

function demoteToWatch(c: Callout, note: string): Callout {
  return { ...c, status: "WATCH", actionable: false, thesisNote: note };
}

/**
 * §4 — Anti-chase. If an idea is ACTIONABLE_NOW but its own lifecycle/reasons say
 * the move already extended past the entry, downgrade it so we never headline a
 * chase. Uses only information already on the callout.
 */
export function antiChaseCallout(c: Callout): Callout {
  if (c.status !== "ACTIONABLE_NOW") return c;
  const text = `${c.lifecycleStatus ?? ""} ${c.reason ?? ""} ${(c.contractReasons ?? []).join(" ")}`.toLowerCase();
  const extended = /extended|overextended|chase|already ran|past entry|too far/.test(text)
    || c.lifecycleStatus === "EXTENDED";
  if (!extended) return c;
  return {
    ...c,
    status: "WAIT_FOR_PULLBACK",
    actionable: false,
    thesisNote: c.thesisNote ?? "Entry window passed — wait for a pullback into the zone rather than chasing.",
  };
}

/** Which owner alert category a callout belongs to. */
function categoryOf(c: Callout): AlertCategory {
  if (String(c.horizon).toLowerCase() === "stock") return "stocks";
  return c.direction === "bearish" ? "puts" : "options";
}

export interface DiscordSelection {
  eligibleKeys: Set<string>;
  ranking: { key: string; ticker: string; quality: number }[];
  suppressed: { key: string; reason: string }[];
}

/**
 * §1/§6/§7 — Choose the strongest few callouts for Discord. Ranks by quality
 * (core priority as tie-break), applies owner gates (direction enabled, category
 * enabled, min setup quality, early-alerts), then caps at maxDiscordAlerts. A
 * mixed-thesis WATCH is allowed through as the single disagreement message.
 */
export function selectForDiscord(callouts: Callout[], s: OwnerSettings): DiscordSelection {
  const suppressed: { key: string; reason: string }[] = [];
  const eligible: { c: Callout; quality: number }[] = [];

  for (const c of callouts) {
    const mixedWatch = c.status === "WATCH" && Boolean(c.thesisNote);
    if (!ALERTABLE.has(c.status) && !mixedWatch) {
      suppressed.push({ key: c.key, reason: `status ${c.status} is not alertable` });
      continue;
    }
    if (c.direction === "bullish" && !s.bullishEnabled) { suppressed.push({ key: c.key, reason: "bullish alerts disabled by owner" }); continue; }
    if (c.direction === "bearish" && !s.bearishEnabled) { suppressed.push({ key: c.key, reason: "bearish alerts disabled by owner" }); continue; }
    if (!s.categories.has(categoryOf(c))) { suppressed.push({ key: c.key, reason: `category ${categoryOf(c)} disabled by owner` }); continue; }
    if (EARLY_ONLY.has(c.status) && !s.earlyAlertsEnabled) { suppressed.push({ key: c.key, reason: "early-stage alert disabled by owner" }); continue; }
    // CONFIDENCE GATE: only HIGH-confidence setups send a normal Discord alert.
    // MEDIUM/LOW stay dashboard-only until they become HIGH. The two explicit
    // exceptions are the owner's opt-in early-stage alerts (NEAR_TRIGGER/DEVELOPING,
    // already gated above) and the single mixed-thesis WATCH disagreement notice
    // (a risk-reduction message, not a trade recommendation).
    if (!EARLY_ONLY.has(c.status) && !mixedWatch && confidenceTier(c) !== "HIGH") {
      suppressed.push({ key: c.key, reason: `not HIGH confidence (${confidenceTier(c).toLowerCase()}) — dashboard only` });
      continue;
    }
    const quality = scoreCalloutQuality(c, s);
    if (quality < s.minSetupQuality) { suppressed.push({ key: c.key, reason: `below min setup quality (${quality} < ${s.minSetupQuality})` }); continue; }
    eligible.push({ c, quality });
  }

  // Rank: quality desc, then core-universe priority, then ticker for determinism.
  eligible.sort((a, b) =>
    b.quality - a.quality
    || tickerPriorityRank(a.c.ticker, s) - tickerPriorityRank(b.c.ticker, s)
    || (a.c.key < b.c.key ? -1 : a.c.key > b.c.key ? 1 : 0));

  const eligibleKeys = new Set<string>();
  const ranking = eligible.map((e) => ({ key: e.c.key, ticker: e.c.ticker, quality: e.quality }));
  for (let i = 0; i < eligible.length; i++) {
    if (i < s.maxDiscordAlerts) eligibleKeys.add(eligible[i].c.key);
    else suppressed.push({ key: eligible[i].c.key, reason: `outside top ${s.maxDiscordAlerts} by quality` });
  }
  return { eligibleKeys, ranking, suppressed };
}

export interface PortfolioReview {
  callouts: Callout[];
  theses: TickerThesis[];
  ranking: { key: string; ticker: string; quality: number }[];
  eligibleKeys: Set<string>;
  suppressed: { key: string; reason: string }[];
}

/**
 * Full portfolio pass: anti-chase → thesis reconciliation → rank + select. The
 * returned callouts carry adjusted lifecycle status / thesis notes / portfolioRank;
 * eligibleKeys is the set the runtime should actually deliver to Discord.
 */
export function reviewPortfolio(
  input: Callout[],
  env: NodeJS.ProcessEnv = process.env,
): PortfolioReview {
  const s = ownerSettings(env);
  const chased = input.map(antiChaseCallout);
  const { callouts: reconciled, theses } = reconcileTheses(chased, s, env);
  const selection = selectForDiscord(reconciled, s);
  const withRank = reconciled.map((c) => ({
    ...c,
    portfolioRank: scoreCalloutQuality(c, s),
  }));
  return {
    callouts: withRank,
    theses,
    ranking: selection.ranking,
    eligibleKeys: selection.eligibleKeys,
    suppressed: selection.suppressed,
  };
}

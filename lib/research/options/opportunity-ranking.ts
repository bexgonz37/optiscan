/**
 * The deterministic opportunity-ranking objective.
 *
 * WHY THIS EXISTS
 *
 * OptiScan was much better at REJECTING candidates than at answering the only question a
 * subscriber actually cares about: among what is available right now, which setup and
 * which executable contract offers the best forward reward for the risk? Opportunity cases
 * persisted `rank: null`, `rankExplanation: null` and `rejectedContracts: []`, so not only
 * was there no ranking objective, there was no record of the comparison either.
 *
 * DESIGN RULES
 *
 *   1. Missing data is NEVER zero. A missing component is recorded in `unavailable` and
 *      excluded from the weighted mean, so an unknown never masquerades as a bad score
 *      (which would silently bury contracts whose data simply had not arrived).
 *   2. Confidence is EVIDENCE STRENGTH, not probability of profit. Nothing here estimates
 *      a win rate; `evidenceCompleteness` measures how much of the picture we actually have.
 *   3. Ranking runs AFTER hard gates and never overrides them. A hard blocker is fatal and
 *      is reported, not scored around.
 *   4. Ranking never bypasses directional authority: candidates contradicting the symbol's
 *      authoritative direction are hard-blocked here too, so a "better" contract can never
 *      reintroduce the CALL/PUT conflict.
 *   5. It is PURE and total: same input, same output, no clock, no I/O, no env.
 */
import type { StrategyDef } from "./strategy-catalog.ts";

export const RANKING_VERSION = "opportunity-ranking@1";

/** A component score in [0,1], or null when the evidence for it is absent. */
export type Component = number | null;

export interface RankableOpportunity {
  candidateId: string;
  symbol: string;
  strategy: string;
  direction: "bullish" | "bearish";
  side: "call" | "put";
  optionSymbol: string;

  // ── setup evidence ────────────────────────────────────────────────
  /** matched / required early signals, 0..1 */
  strategyScore: Component;
  /** how much of the expected move has already happened, 0..1 (lower is earlier) */
  fractionMove: Component;
  /** % of the move's reward still ahead */
  rewardRemainingPct: number | null;
  /** % distance from the level that invalidates the thesis */
  invalidationDistancePct: number | null;
  /** % the option premium already expanded before we could act */
  premiumExpansionPct: number | null;
  /** ms since the candidate first became eligible */
  candidateAgeMs: number | null;
  /** relative volume vs baseline */
  relVolume: number | null;
  /** % distance to the level being played */
  levelProximityPct: number | null;
  /** true when compressing into a level (a coil), false when already expanded */
  compression: boolean | null;
  /** aligned with broader market direction */
  marketAligned: boolean | null;
  sectorAligned: boolean | null;
  hasCatalyst: boolean | null;

  // ── executable evidence ───────────────────────────────────────────
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  quoteAgeMs: number | null;
  delta: number | null;
  gamma: number | null;
  iv: number | null;
  thetaPerDayPct: number | null;
  dte: number | null;
  openInterest: number | null;
  optionVolume: number | null;
  /** underlying's expected move over the holding horizon, % */
  expectedMovePct: number | null;
  /** contracts absorbable at the quoted ask without moving the book */
  estimatedCapacity: number | null;

  // ── context ───────────────────────────────────────────────────────
  strategyDef: StrategyDef | null;
  /** the symbol's authoritative direction, if one is already established */
  authoritativeDirection: "bullish" | "bearish" | null;
  /** gates that already failed. Non-empty means unrankable. */
  hardBlockers: string[];
}

export interface RankedComponent {
  key: string;
  value: Component;
  weight: number;
  /** why it scored what it scored, in plain terms */
  note: string;
}

export interface RankedPenalty {
  key: string;
  magnitude: number;
  note: string;
}

export interface RankedOpportunity {
  candidateId: string;
  symbol: string;
  strategy: string;
  optionSymbol: string;
  direction: "bullish" | "bearish";
  rank: number;
  /** null when hard-blocked: a blocked candidate has no score, it is simply out. */
  totalScore: number | null;
  components: RankedComponent[];
  penalties: RankedPenalty[];
  unavailable: string[];
  hardBlockers: string[];
  /** How complete the evidence was, 0..1. Evidence strength, NOT probability of profit. */
  evidenceCompleteness: number;
  rankingVersion: string;
}

export interface RankingResult {
  rankingVersion: string;
  selected: RankedOpportunity | null;
  runnersUp: RankedOpportunity[];
  blocked: RankedOpportunity[];
  /** Per runner-up: exactly why the winner beat it. */
  outrankedReasons: { candidateId: string; reason: string }[];
  /** Per blocked candidate: exactly why it is untradeable however good it looks. */
  rejectedReasons: { candidateId: string; reason: string }[];
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Map a value to 0..1 where `good` scores 1 and `bad` scores 0, linearly, either direction. */
function ramp(value: number | null, good: number, bad: number): Component {
  if (value == null || !Number.isFinite(value)) return null;
  if (good === bad) return null;
  return clamp01((value - bad) / (good - bad));
}

const bool = (v: boolean | null): Component => (v == null ? null : v ? 1 : 0);

/**
 * Component weights.
 *
 * Executable reality (spread, liquidity, capacity, quote freshness) is weighted at 0.34
 * in total — deliberately close to setup quality's 0.33. The audited population failed
 * mostly on execution, not on setup recognition: 59.9% of alerts never gained 5%, and the
 * gates were already rejecting on spread and liquidity. A ranking that scored setups
 * heavily and execution lightly would recreate that failure.
 */
export const COMPONENT_WEIGHTS: Record<string, number> = Object.freeze({
  // setup quality — 0.33
  strategyFit: 0.10,
  earliness: 0.09,
  rewardRemaining: 0.08,
  levelProximity: 0.03,
  compression: 0.03,
  // executable reality — 0.34
  spread: 0.10,
  liquidity: 0.09,
  quoteFreshness: 0.06,
  capacity: 0.05,
  premiumRealism: 0.04,
  // contract fit for the intended move — 0.21
  deltaFit: 0.07,
  gammaForHorizon: 0.06,
  dteFit: 0.05,
  moveCoverage: 0.03,
  // context — 0.12
  marketAlignment: 0.05,
  invalidationClarity: 0.04,
  catalyst: 0.03,
});

/** Penalties are subtracted AFTER the weighted mean, so they can express hard distaste. */
export const PENALTY_WEIGHTS: Record<string, number> = Object.freeze({
  premiumChase: 0.20,
  staleQuote: 0.15,
  wideSpread: 0.15,
  lotteryDistance: 0.12,
  thetaBurn: 0.10,
  poorCapacity: 0.10,
  lateDetection: 0.08,
  weakRewardRemaining: 0.10,
  missingCriticalEvidence: 0.10,
  conflictingContext: 0.05,
});

function scoreComponents(o: RankableOpportunity): RankedComponent[] {
  const def = o.strategyDef;
  const [dLo, dHi] = def?.preferredDelta ?? [0.35, 0.55];
  const absDelta = o.delta == null ? null : Math.abs(o.delta);

  // Delta fit: 1 at the band centre, falling to 0 one half-width outside it.
  let deltaFit: Component = null;
  if (absDelta != null) {
    const mid = (dLo + dHi) / 2;
    const half = Math.max(1e-6, (dHi - dLo) / 2);
    deltaFit = clamp01(1 - Math.abs(absDelta - mid) / (half * 2));
  }

  // Gamma matters more the shorter the horizon; for multi-week theses it is noise.
  const shortHorizon = o.dte != null && o.dte <= 7;
  const gammaForHorizon: Component = o.gamma == null
    ? null
    : shortHorizon ? ramp(o.gamma, 0.05, 0) : 0.5;

  const dteFit: Component = (() => {
    if (o.dte == null || !def) return null;
    const bands = def.preferredDte;
    const band = o.dte <= 0 ? "0dte" : o.dte <= 7 ? "1-7dte" : o.dte <= 14 ? "8-14dte"
      : o.dte <= 30 ? "15-30dte" : o.dte <= 90 ? "31-90dte" : "longer";
    return bands.includes(band as never) ? 1 : 0;
  })();

  // Does the expected underlying move actually reach this strike? A contract needing more
  // than the expected move is a lottery ticket, however cheap.
  const moveCoverage: Component = (o.expectedMovePct == null || o.levelProximityPct == null)
    ? null
    : clamp01(o.expectedMovePct / Math.max(0.01, o.levelProximityPct));

  return [
    { key: "strategyFit", value: o.strategyScore == null ? null : clamp01(o.strategyScore), weight: COMPONENT_WEIGHTS.strategyFit, note: "matched vs required early signals" },
    { key: "earliness", value: o.fractionMove == null ? null : clamp01(1 - o.fractionMove), weight: COMPONENT_WEIGHTS.earliness, note: "how much of the move is still ahead" },
    { key: "rewardRemaining", value: ramp(o.rewardRemainingPct, 40, 0), weight: COMPONENT_WEIGHTS.rewardRemaining, note: "% of the move's reward not yet taken" },
    { key: "levelProximity", value: ramp(o.levelProximityPct, 0, 2), weight: COMPONENT_WEIGHTS.levelProximity, note: "distance to the level being played" },
    { key: "compression", value: bool(o.compression), weight: COMPONENT_WEIGHTS.compression, note: "coiling into the level rather than already extended" },

    { key: "spread", value: ramp(o.spreadPct, 0, 10), weight: COMPONENT_WEIGHTS.spread, note: "ask-to-bid cost as a % of premium" },
    { key: "liquidity", value: o.openInterest == null ? null : clamp01(Math.log10(1 + Math.max(0, o.openInterest)) / 4), weight: COMPONENT_WEIGHTS.liquidity, note: "open interest, log-scaled" },
    { key: "quoteFreshness", value: ramp(o.quoteAgeMs, 0, 120_000), weight: COMPONENT_WEIGHTS.quoteFreshness, note: "age of the quote we would transact against" },
    { key: "capacity", value: o.estimatedCapacity == null ? null : clamp01(Math.log10(1 + Math.max(0, o.estimatedCapacity)) / 3), weight: COMPONENT_WEIGHTS.capacity, note: "size absorbable at the quoted ask" },
    { key: "premiumRealism", value: o.ask == null ? null : (o.ask >= 0.20 && o.ask <= 10 ? 1 : o.ask < 0.20 ? 0.2 : 0.5), weight: COMPONENT_WEIGHTS.premiumRealism, note: "premium in a range a subscriber can actually size" },

    { key: "deltaFit", value: deltaFit, weight: COMPONENT_WEIGHTS.deltaFit, note: "distance from the strategy's preferred delta band" },
    { key: "gammaForHorizon", value: gammaForHorizon, weight: COMPONENT_WEIGHTS.gammaForHorizon, note: "gamma weighted for the intended holding horizon" },
    { key: "dteFit", value: dteFit, weight: COMPONENT_WEIGHTS.dteFit, note: "expiry inside the strategy's declared bands" },
    { key: "moveCoverage", value: moveCoverage, weight: COMPONENT_WEIGHTS.moveCoverage, note: "expected move vs distance the contract needs" },

    { key: "marketAlignment", value: (() => { const m = bool(o.marketAligned); const s = bool(o.sectorAligned); if (m == null && s == null) return null; return clamp01(((m ?? 0.5) * 0.6) + ((s ?? 0.5) * 0.4)); })(), weight: COMPONENT_WEIGHTS.marketAlignment, note: "agreement with market and sector" },
    { key: "invalidationClarity", value: ramp(o.invalidationDistancePct, 8, 0), weight: COMPONENT_WEIGHTS.invalidationClarity, note: "room before the thesis is proven wrong" },
    { key: "catalyst", value: bool(o.hasCatalyst), weight: COMPONENT_WEIGHTS.catalyst, note: "an identifiable reason for the move" },
  ];
}

function scorePenalties(o: RankableOpportunity, components: RankedComponent[]): RankedPenalty[] {
  const out: RankedPenalty[] = [];
  const chaseLimit = (o.strategyDef?.chaseLimitPct ?? 0.6) * 100;

  if (o.premiumExpansionPct != null && o.premiumExpansionPct > chaseLimit) {
    out.push({ key: "premiumChase", magnitude: PENALTY_WEIGHTS.premiumChase * clamp01((o.premiumExpansionPct - chaseLimit) / Math.max(1, chaseLimit)), note: `premium already expanded ${o.premiumExpansionPct}% vs ${chaseLimit}% limit` });
  }
  if (o.quoteAgeMs != null && o.quoteAgeMs > 120_000) {
    out.push({ key: "staleQuote", magnitude: PENALTY_WEIGHTS.staleQuote, note: `quote ${Math.round(o.quoteAgeMs / 1000)}s old` });
  }
  if (o.spreadPct != null && o.spreadPct > 10) {
    out.push({ key: "wideSpread", magnitude: PENALTY_WEIGHTS.wideSpread * clamp01((o.spreadPct - 10) / 20), note: `spread ${o.spreadPct}%` });
  }
  // A contract needing more than the expected move to pay is a lottery ticket.
  if (o.expectedMovePct != null && o.levelProximityPct != null && o.levelProximityPct > o.expectedMovePct * 1.5) {
    out.push({ key: "lotteryDistance", magnitude: PENALTY_WEIGHTS.lotteryDistance, note: `needs ${o.levelProximityPct}% vs ${o.expectedMovePct}% expected move` });
  }
  if (o.thetaPerDayPct != null && o.thetaPerDayPct > 15) {
    out.push({ key: "thetaBurn", magnitude: PENALTY_WEIGHTS.thetaBurn * clamp01((o.thetaPerDayPct - 15) / 35), note: `theta ${o.thetaPerDayPct}%/day` });
  }
  if (o.estimatedCapacity != null && o.estimatedCapacity < 10) {
    out.push({ key: "poorCapacity", magnitude: PENALTY_WEIGHTS.poorCapacity, note: `only ~${o.estimatedCapacity} contracts absorbable` });
  }
  if (o.candidateAgeMs != null && o.candidateAgeMs > 15 * 60_000) {
    out.push({ key: "lateDetection", magnitude: PENALTY_WEIGHTS.lateDetection * clamp01((o.candidateAgeMs - 900_000) / 900_000), note: `first eligible ${Math.round(o.candidateAgeMs / 60000)}m ago` });
  }
  if (o.rewardRemainingPct != null && o.rewardRemainingPct < 10) {
    out.push({ key: "weakRewardRemaining", magnitude: PENALTY_WEIGHTS.weakRewardRemaining, note: `only ${o.rewardRemainingPct}% reward left` });
  }
  if (o.marketAligned === false) {
    out.push({ key: "conflictingContext", magnitude: PENALTY_WEIGHTS.conflictingContext, note: "trading against the broader market" });
  }
  // Missing EXECUTION evidence is penalised; missing nice-to-haves are not. You cannot
  // responsibly recommend a contract whose spread or liquidity you do not know.
  const critical = ["spread", "liquidity", "quoteFreshness", "deltaFit"];
  const missingCritical = components.filter((c) => critical.includes(c.key) && c.value == null);
  if (missingCritical.length) {
    out.push({
      key: "missingCriticalEvidence",
      magnitude: PENALTY_WEIGHTS.missingCriticalEvidence * (missingCritical.length / critical.length),
      note: `missing ${missingCritical.map((c) => c.key).join(", ")}`,
    });
  }
  return out;
}

export function rankOne(o: RankableOpportunity): Omit<RankedOpportunity, "rank"> {
  const hardBlockers = [...o.hardBlockers];
  // Directional authority is not a scoring input. A candidate that contradicts the
  // symbol's established direction is out, whatever it scores.
  if (o.authoritativeDirection && o.authoritativeDirection !== o.direction) {
    hardBlockers.push(`DIRECTION_CONFLICT:symbol is ${o.authoritativeDirection}, candidate is ${o.direction}`);
  }

  const components = scoreComponents(o);
  const unavailable = components.filter((c) => c.value == null).map((c) => c.key);
  const penalties = hardBlockers.length ? [] : scorePenalties(o, components);

  if (hardBlockers.length) {
    return {
      candidateId: o.candidateId, symbol: o.symbol, strategy: o.strategy,
      optionSymbol: o.optionSymbol, direction: o.direction,
      totalScore: null, components, penalties, unavailable, hardBlockers,
      evidenceCompleteness: +(1 - unavailable.length / components.length).toFixed(4),
      rankingVersion: RANKING_VERSION,
    };
  }

  // Weighted mean over PRESENT components only. Missing never contributes zero.
  const present = components.filter((c) => c.value != null);
  const weightSum = present.reduce((a, c) => a + c.weight, 0);
  const weighted = weightSum > 0
    ? present.reduce((a, c) => a + c.weight * (c.value as number), 0) / weightSum
    : 0;
  const penaltyTotal = penalties.reduce((a, p) => a + p.magnitude, 0);

  return {
    candidateId: o.candidateId, symbol: o.symbol, strategy: o.strategy,
    optionSymbol: o.optionSymbol, direction: o.direction,
    totalScore: +clamp01(weighted - penaltyTotal).toFixed(6),
    components, penalties, unavailable, hardBlockers,
    evidenceCompleteness: +(1 - unavailable.length / components.length).toFixed(4),
    rankingVersion: RANKING_VERSION,
  };
}

/** Why did `winner` beat `loser`? Names the components that actually moved the gap. */
export function explainOutranking(
  winner: Omit<RankedOpportunity, "rank">,
  loser: Omit<RankedOpportunity, "rank">,
): string {
  if (loser.hardBlockers.length) return `blocked: ${loser.hardBlockers.join("; ")}`;
  const byKey = new Map(loser.components.map((c) => [c.key, c]));
  const gaps: { key: string; delta: number }[] = [];
  for (const w of winner.components) {
    const l = byKey.get(w.key);
    if (!l || w.value == null || l.value == null) continue;
    gaps.push({ key: w.key, delta: w.weight * (w.value - l.value) });
  }
  gaps.sort((a, b) => b.delta - a.delta);
  const top = gaps.filter((g) => g.delta > 0).slice(0, 3)
    .map((g) => `${g.key} +${g.delta.toFixed(3)}`);
  const lp = loser.penalties.reduce((a, p) => a + p.magnitude, 0);
  const wp = winner.penalties.reduce((a, p) => a + p.magnitude, 0);
  const parts: string[] = [];
  if (top.length) parts.push(`stronger on ${top.join(", ")}`);
  if (lp > wp) parts.push(`runner-up penalised ${lp.toFixed(3)} vs ${wp.toFixed(3)} (${loser.penalties.map((p) => p.key).join(", ")})`);
  if (!parts.length) parts.push("higher weighted score with no single dominant component");
  return `${(winner.totalScore ?? 0).toFixed(4)} vs ${(loser.totalScore ?? 0).toFixed(4)}: ${parts.join("; ")}`;
}

/**
 * Rank a set of opportunities available at ONE instant.
 *
 * Ties are broken deterministically — score, then evidence completeness, then candidateId —
 * so the same input always produces the same winner. (The strategy catalog taught us what
 * an accidental, position-dependent tie-break costs.)
 */
export function rankOpportunities(candidates: RankableOpportunity[]): RankingResult {
  const scored = candidates.map((c) => ({ input: c, out: rankOne(c) }));
  const blocked = scored.filter((s) => s.out.hardBlockers.length);
  const rankable = scored.filter((s) => !s.out.hardBlockers.length);

  rankable.sort((a, b) => {
    const d = (b.out.totalScore ?? 0) - (a.out.totalScore ?? 0);
    if (d !== 0) return d;
    const e = b.out.evidenceCompleteness - a.out.evidenceCompleteness;
    if (e !== 0) return e;
    return a.out.candidateId.localeCompare(b.out.candidateId);
  });

  const ranked: RankedOpportunity[] = rankable.map((s, i) => ({ ...s.out, rank: i + 1 }));
  const blockedRanked: RankedOpportunity[] = blocked.map((s) => ({ ...s.out, rank: 0 }));
  const selected = ranked[0] ?? null;
  const runnersUp = ranked.slice(1);

  return {
    rankingVersion: RANKING_VERSION,
    selected,
    runnersUp,
    blocked: blockedRanked,
    outrankedReasons: selected
      ? runnersUp.map((r) => ({ candidateId: r.candidateId, reason: explainOutranking(selected, r) }))
      : [],
    rejectedReasons: blockedRanked.map((b) => ({
      candidateId: b.candidateId,
      reason: b.hardBlockers.join("; "),
    })),
  };
}

export interface RankBreakdownDb {
  prepare(sql: string): { run(...a: unknown[]): { changes?: number } };
}

/** Persist the whole comparison — winner and runners-up — so it stays explainable later. */
export function persistRankBreakdownOnDb(
  db: RankBreakdownDb,
  input: {
    decisionId: string;
    symbol: string;
    sessionDate: string | null;
    result: RankingResult;
    nowMs: number;
  },
): { written: number } {
  const rows = [
    ...(input.result.selected ? [{ r: input.result.selected, selected: true }] : []),
    ...input.result.runnersUp.map((r) => ({ r, selected: false })),
    ...input.result.blocked.map((r) => ({ r, selected: false })),
  ];
  const outranked = new Map(input.result.outrankedReasons.map((x) => [x.candidateId, x.reason]));
  const rejected = new Map(input.result.rejectedReasons.map((x) => [x.candidateId, x.reason]));
  let written = 0;
  for (const { r, selected } of rows) {
    try {
      db.prepare(
        `INSERT INTO opportunity_rank_breakdown
           (decision_id, ranking_version, symbol, session_date, strategy, direction, option_symbol,
            rank, is_selected, total_score, components_json, penalties_json, unavailable_json,
            hard_blockers_json, outranked_reason, rejected_reason, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.decisionId, r.rankingVersion, input.symbol, input.sessionDate,
        r.strategy, r.direction, r.optionSymbol, r.rank, selected ? 1 : 0,
        r.totalScore, JSON.stringify(r.components), JSON.stringify(r.penalties),
        JSON.stringify(r.unavailable), JSON.stringify(r.hardBlockers),
        outranked.get(r.candidateId) ?? null, rejected.get(r.candidateId) ?? null,
        input.nowMs,
      );
      written += 1;
    } catch { /* persistence must never break a decision */ }
  }
  return { written };
}

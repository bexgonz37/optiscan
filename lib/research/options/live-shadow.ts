/**
 * live-shadow.ts — THE SHADOW LANE, WIRED TO LIVE CANDIDATES AND WIRED TO NOTHING ELSE.
 *
 * The measurement modules for Phases F–K already existed and were already
 * tested. What they did not have was a SUBJECT: they were exercised against
 * fixtures, so every finding they produced described a hypothetical candidate
 * rather than the ones production is actually rejecting. A shadow that never
 * sees live input cannot explain a live outcome, and the 9 CALL / 93 PUT
 * opening mix is a live outcome.
 *
 * This module is the seam. The monitor hands it what it already computed at the
 * moment production decided; this replays the alternative semantics over the
 * SAME instant and writes the divergence down.
 *
 * ── WHY THIS CANNOT CONTAMINATE PRODUCTION ──────────────────────────────────
 *
 * Not as a convention, as a shape:
 *
 *  1. `observeLiveShadow` returns `void`. There is no verdict for a caller to
 *     read, so there is no call site that could branch on one. Every other
 *     export is a reader.
 *  2. It accepts only values production has ALREADY computed. It fetches
 *     nothing, so it cannot spend a provider request, and it cannot see a bar
 *     production did not have — no shadow finding can depend on data the live
 *     decision lacked.
 *  3. Every path is wrapped so a shadow fault is swallowed at the boundary. A
 *     measurement that could throw into the scan would be a measurement that
 *     changes the scan.
 *  4. The buffers are fixed-size rings. A long session cannot turn observation
 *     into a memory leak, and the cost of the whole lane is bounded before it
 *     starts.
 *
 * ── WHAT IT IS MEASURING ────────────────────────────────────────────────────
 *
 *  F  STAGE15_CHAIN_GATE_SHADOW_V1 — would a real plausibility gate have saved
 *     the chain request, and what would it have cost to save it?
 *  G  OPTIONS_FEATURE_SEMANTICS_V2  — production's HOD/LOD/VWAP/cumVol window is
 *     whatever bar array it was handed. Is that the current session?
 *  H  DIRECTION_AWARE_LATE_PHASE_V1 — production's fractionMove is
 *     direction-blind, so a PUT and a CALL at the session low are read as
 *     equally early. One of them is not.
 *  I  BEARISH_SIGNAL_DEDUPE — `downside_acceleration` and `downside_momentum`
 *     are emitted from ONE boolean in `activeSignals`. What is the second copy
 *     worth to the strategies that list both?
 *  J  TIE_DIAGNOSTICS — when the top of the board ties, who wins, and does the
 *     winner change the direction of the trade?
 *
 * Phase K (relative volume) lives in `rvol-shadow.ts`: it is the only one of the
 * six that needs a database read, and mixing an I/O path into a module whose
 * safety argument is "it does no I/O" would weaken the argument for all five.
 */
import type { Bar } from "./features.ts";
import type { StrategyScore } from "./discovery.ts";
import { getStrategy } from "./strategy-catalog.ts";
import { tradingDay, etSessionOpenMs } from "../../trading-session.ts";
import {
  evaluateStage15Shadow, measureStage15Shadow, stage15ShadowConfig,
  STAGE15_SHADOW_VERSION,
  type Stage15Attempt, type Stage15Evidence, type Stage15ShadowConfig, type Stage15ShadowResult,
} from "./stage15-shadow.ts";
import {
  compareSessionWindow, compareLatePhase, measureDuplicationEffect,
  summarizeDuplication, measureStrategyTies,
  FEATURE_SEMANTICS_SHADOW_VERSION,
  type SessionWindowComparison, type LatePhaseComparison,
  type DuplicationEffect, type TieObservation,
} from "./feature-semantics-shadow.ts";

export const LIVE_SHADOW_VERSIONS = Object.freeze({
  stage15: STAGE15_SHADOW_VERSION,
  featureSemantics: FEATURE_SEMANTICS_SHADOW_VERSION,
  directionAwareLatePhase: "DIRECTION_AWARE_LATE_PHASE_SHADOW_V1",
  bearishDedupe: "BEARISH_SIGNAL_DEDUPE_SHADOW_V1",
  tieDiagnostics: "STRATEGY_TIE_DIAGNOSTIC_V1",
} as const);

/**
 * Everything the monitor already holds at the moment it decides about a chain.
 *
 * Every field is optional except the identity ones, because the live snapshot
 * is genuinely sparse and a shadow that required complete input would only ever
 * observe the easy candidates — the opposite of the population worth studying.
 */
export interface LiveShadowInput {
  symbol: string;
  atMs: number;
  tier: 0 | 1 | 2;
  /** Bars production computed its features from, exactly as it received them. */
  bars?: readonly Bar[] | null;
  price?: number | null;
  /** Production's own HOD/LOD at decision time, for the late-phase comparison. */
  hod?: number | null;
  lod?: number | null;
  /** Production's direction-blind fractionMove, as recorded on the candidate. */
  productionFractionMove?: number | null;
  /** The side production selected, or would have. Null when nothing was selected. */
  side?: "call" | "put" | null;
  strategyKey?: string | null;
  /** The full scored board, already ordered as production ordered it. */
  considered?: readonly StrategyScore[] | null;
  /** Early-signal keys active for this candidate. */
  activeSignals?: ReadonlySet<string> | null;
  /**
   * Decision-time underlying values, exactly as production computed them.
   *
   * The caller passes RAW VALUES rather than an assembled `Stage15Evidence`,
   * so a production module never has to name a shadow type — the isolation
   * guard can then forbid every import of a measurement module, type-only ones
   * included, instead of carving out an exception a later change could widen.
   */
  underlying?: {
    velPct?: number | null;
    accelPct?: number | null;
    relVolume?: number | null;
    dayDollarVolume?: number | null;
    compressionPct?: number | null;
    aboveVwap?: boolean | null;
  } | null;
  /** Strategy score at decision time, 0..1. */
  strategyScore?: number | null;
  /** True when the candidate could never reach subscribers. */
  researchOnly?: boolean | null;
  /** Outcome fields, filled in on the post-chain observation. */
  contractsReturned?: number | null;
  selectedOcc?: boolean | null;
  becameCase?: boolean | null;
}

/* ---------------------------------------------------------------------------
 * ONE OBSERVATION
 * -------------------------------------------------------------------------*/

export interface LiveShadowRecord {
  symbol: string;
  atMs: number;
  tier: 0 | 1 | 2;
  /** F — what the frozen V1 gate would have said, and why. */
  stage15: Stage15ShadowResult | null;
  /** G — production's window against a properly sliced current session. */
  sessionWindow: SessionWindowComparison | null;
  /** H — direction-blind against direction-aware earliness. */
  latePhase: LatePhaseComparison | null;
  /** I — what the duplicated bearish pair is worth to the winning strategy. */
  duplication: DuplicationEffect | null;
  /** J — the tie state at the top of the board. */
  tie: LiveTieRecord | null;
}

/**
 * A tie at the top, described precisely enough to be actionable.
 *
 * `winnerChangesDirection` is the field this exists for. A tie broken by matched
 * count is only a curiosity if both candidates trade the same way; it is a
 * DIRECTION DECISION made by catalog structure if they do not, and that is the
 * shape that could produce 93 puts against 9 calls without any market reason.
 */
export interface LiveTieRecord {
  version: typeof LIVE_SHADOW_VERSIONS.tieDiagnostics;
  symbol: string;
  atMs: number;
  topScore: number;
  /** Every strategy sharing the top score, in production's own order. */
  tiedKeys: string[];
  tiedSides: string[];
  matchedCounts: number[];
  /** Applicable strategies on the board at all. */
  eligibleCount: number;
  winnerKey: string;
  winnerSide: string;
  winnerMatchedCount: number;
  /** True when the winner beat a tied rival on matched keys alone. */
  wonByMatchedCount: boolean;
  /** True when at least one tied rival would have traded the other way. */
  winnerChangesDirection: boolean;
  /** The named case: lower_high_continuation taking a tie from a non-put rival. */
  lowerHighWonTieOverOtherSide: boolean;
}

const LOWER_HIGH_KEY = "lower_high_continuation";

/** Pure. Everything this returns is a description; nothing is a decision. */
export function evaluateLiveShadow(
  input: LiveShadowInput,
  cfg: Stage15ShadowConfig,
  sessionStartMs: number | null,
): LiveShadowRecord {
  const symbol = String(input.symbol ?? "").toUpperCase();

  const evidence = stage15EvidenceOf(input);
  const stage15 = evidence ? evaluateStage15Shadow(evidence, cfg) : null;

  const bars = input.bars ?? null;
  const price = typeof input.price === "number" && Number.isFinite(input.price) ? input.price : null;
  const sessionWindow = bars && bars.length && price != null && sessionStartMs != null
    ? compareSessionWindow(bars, price, sessionStartMs)
    : null;

  const side = input.side === "call" || input.side === "put" ? input.side : null;
  const latePhase = side && price != null
    ? compareLatePhase(price, input.hod ?? null, input.lod ?? null, side)
    : null;

  const duplication = input.strategyKey && input.activeSignals
    ? duplicationFor(input.strategyKey, input.activeSignals)
    : null;

  const tie = input.considered ? tieRecord(symbol, input.atMs, input.considered) : null;

  return { symbol, atMs: input.atMs, tier: input.tier, stage15, sessionWindow, latePhase, duplication, tie };
}

/**
 * The Stage-1.5 gate's evidence, assembled from what the candidate already held.
 *
 * Every field is read off values production computed. Nothing is fetched, and
 * nothing can be seen here that the live decision did not already have — which
 * is what keeps the Phase-F counterfactual honest about what a real gate would
 * have known at the moment it would have fired.
 *
 * Returns null when there is no underlying block at all: a gate evaluated
 * against nothing would report a PASS on every field being unknown, and a
 * hundred of those would drown the population that carries real evidence.
 */
function stage15EvidenceOf(input: LiveShadowInput): Stage15Evidence | null {
  const u = input.underlying;
  if (!u) return null;
  return {
    symbol: String(input.symbol ?? "").toUpperCase(),
    velPct: u.velPct ?? null,
    accelPct: u.accelPct ?? null,
    relVolume: u.relVolume ?? null,
    dayDollarVolume: u.dayDollarVolume ?? null,
    compressionPct: u.compressionPct ?? null,
    aboveVwap: u.aboveVwap ?? null,
    // The underlying quoted spread is not on the snapshot. Absent, never guessed
    // — `evaluateStage15Shadow` records it as an unknown and skips the floor.
    spreadPct: null,
    strategyScore: input.strategyScore ?? null,
    researchOnly: input.researchOnly ?? null,
    tier: input.tier,
  };
}

function duplicationFor(strategyKey: string, active: ReadonlySet<string>): DuplicationEffect | null {
  const def = getStrategy(strategyKey);
  if (!def) return null;
  return measureDuplicationEffect(strategyKey, def.earlySignals, active);
}

/**
 * The tie at the top of one board.
 *
 * Reads the board in the order production already sorted it, so `board[0]` is
 * production's actual winner rather than this module's opinion of one — a
 * re-sort here would measure a different tie-break than the one that shipped.
 * Only APPLICABLE strategies count: an inapplicable strategy sharing the top
 * score was never in the running and would inflate the tie rate.
 */
function tieRecord(
  symbol: string,
  atMs: number,
  considered: readonly StrategyScore[],
): LiveTieRecord | null {
  const applicable = considered.filter((s) => s?.applicable);
  if (applicable.length === 0) return null;
  const top = applicable[0];
  const tied = applicable.filter((s) => s.score === top.score);
  if (tied.length < 2) return null;

  const sideOf = (key: string): string => getStrategy(key)?.side ?? "either";
  const winnerSide = sideOf(top.key);
  const rivals = tied.filter((s) => s.key !== top.key);

  // "Won by matched count" means the winner did not out-score anyone — it had
  // the same ratio and strictly more matched keys than every rival it beat.
  const wonByMatchedCount = rivals.length > 0
    && rivals.every((r) => top.matched.length > r.matched.length);

  // A rival "would have traded the other way" only when both sides are
  // committed. An `either`-sided strategy takes its direction from velocity, so
  // it is not evidence of a structural direction flip.
  const winnerChangesDirection = winnerSide !== "either"
    && rivals.some((r) => {
      const rs = sideOf(r.key);
      return rs !== "either" && rs !== winnerSide;
    });

  return {
    version: LIVE_SHADOW_VERSIONS.tieDiagnostics,
    symbol,
    atMs,
    topScore: top.score,
    tiedKeys: tied.map((s) => s.key),
    tiedSides: tied.map((s) => sideOf(s.key)),
    matchedCounts: tied.map((s) => s.matched.length),
    eligibleCount: applicable.length,
    winnerKey: top.key,
    winnerSide,
    winnerMatchedCount: top.matched.length,
    wonByMatchedCount,
    winnerChangesDirection,
    lowerHighWonTieOverOtherSide:
      top.key === LOWER_HIGH_KEY && wonByMatchedCount && winnerChangesDirection,
  };
}

/* ---------------------------------------------------------------------------
 * THE BOUNDED STORE
 * -------------------------------------------------------------------------*/

/**
 * Ring capacity per stream.
 *
 * Sized for a full RTH session at the promotion ceiling, not for the universe:
 * ~25 promotions a minute for 390 minutes is far more than any report needs, and
 * a shadow lane that grew with the universe would be a storage defect wearing a
 * science project's clothes. Oldest observations are dropped, because a
 * divergence measured three hours ago has already been counted in the summary.
 */
export const LIVE_SHADOW_RING_MAX = 500;

interface LiveShadowState {
  records: LiveShadowRecord[];
  attempts: Stage15Attempt[];
  duplications: DuplicationEffect[];
  ties: LiveTieRecord[];
  tieBoards: TieObservation[][];
  counters: {
    observed: number;
    stage15Pass: number;
    stage15Reject: number;
    sessionWindowDivergent: number;
    sessionWindowCompared: number;
    latePhaseDisagrees: number;
    latePhaseCompared: number;
    duplicationAffected: number;
    tiesAtTop: number;
    faults: number;
  };
}

type G = typeof globalThis & { __optiscanOptionsLiveShadow?: LiveShadowState };

function shadowState(): LiveShadowState {
  const g = globalThis as G;
  return (g.__optiscanOptionsLiveShadow ??= {
    records: [], attempts: [], duplications: [], ties: [], tieBoards: [],
    counters: {
      observed: 0, stage15Pass: 0, stage15Reject: 0,
      sessionWindowDivergent: 0, sessionWindowCompared: 0,
      latePhaseDisagrees: 0, latePhaseCompared: 0,
      duplicationAffected: 0, tiesAtTop: 0, faults: 0,
    },
  });
}

function push<T>(ring: T[], v: T): void {
  ring.push(v);
  if (ring.length > LIVE_SHADOW_RING_MAX) ring.splice(0, ring.length - LIVE_SHADOW_RING_MAX);
}

/**
 * Observe one live candidate. RETURNS NOTHING, BY DESIGN.
 *
 * The absent return value is the enforcement mechanism for "shadow only": a
 * caller cannot gate on what it is not given. If this ever needs to return a
 * verdict, that is the moment the shadow is being promoted to authority, and it
 * should be an explicit and reviewed change rather than a signature drift.
 */
export function observeLiveShadow(
  input: LiveShadowInput,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const s = shadowState();
  try {
    if (env.OPTIONS_LIVE_SHADOW === "0") return;
    const cfg = stage15ShadowConfig(env);
    const sessionStartMs = sessionStartFor(input.atMs);
    const rec = evaluateLiveShadow(input, cfg, sessionStartMs);

    s.counters.observed += 1;
    if (rec.stage15) {
      if (rec.stage15.verdict === "PASS") s.counters.stage15Pass += 1;
      else s.counters.stage15Reject += 1;
    }
    if (rec.sessionWindow) {
      s.counters.sessionWindowCompared += 1;
      if (rec.sessionWindow.materiallyDifferent) s.counters.sessionWindowDivergent += 1;
    }
    if (rec.latePhase) {
      s.counters.latePhaseCompared += 1;
      if (rec.latePhase.disagrees) s.counters.latePhaseDisagrees += 1;
    }
    if (rec.duplication) {
      push(s.duplications, rec.duplication);
      if (rec.duplication.benefitsFromDuplication && rec.duplication.inflation !== 0) {
        s.counters.duplicationAffected += 1;
      }
    }
    if (rec.tie) {
      push(s.ties, rec.tie);
      s.counters.tiesAtTop += 1;
    }
    if (input.considered) push(s.tieBoards, tieBoardOf(input.considered));

    push(s.records, rec);

    // The Stage-1.5 counterfactual needs the OUTCOME beside the evidence, so it
    // is only recorded once the chain attempt has actually resolved. Recording
    // it at decision time would leave every attempt looking like a zero.
    const evidence = stage15EvidenceOf(input);
    if (evidence && input.contractsReturned != null) {
      push(s.attempts, {
        evidence,
        contractsReturned: Math.max(0, Number(input.contractsReturned) || 0),
        selectedOcc: input.selectedOcc === true,
        becameCase: input.becameCase === true,
        optionOutcome: null, // never imputed here; grading fills this in elsewhere
      });
    }
  } catch {
    // A shadow that can throw into the scan is a shadow with authority.
    s.counters.faults += 1;
  }
}

function tieBoardOf(considered: readonly StrategyScore[]): TieObservation[] {
  return considered
    .filter((c) => c?.applicable)
    .map((c) => ({
      key: c.key,
      score: c.score,
      matchedCount: c.matched.length,
      side: (getStrategy(c.key)?.side ?? "either") as TieObservation["side"],
    }));
}

/**
 * Start of the CURRENT session for a timestamp.
 *
 * Returns null outside a regular session rather than guessing, so the window
 * comparison is simply absent premarket and after hours instead of being
 * computed against a boundary that has not happened yet.
 */
function sessionStartFor(atMs: number): number | null {
  try {
    const open = etSessionOpenMs(tradingDay(atMs));
    if (!Number.isFinite(open) || atMs < open) return null;
    return open;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * READERS
 * -------------------------------------------------------------------------*/

/**
 * The whole shadow lane as one report. READ-ONLY.
 *
 * `stage15.wouldSaveChainRequests` is deliberately never returned alone — the
 * report it comes from carries the four columns that say what the saving costs,
 * because a savings number without a cost number will always look like a good
 * idea.
 */
export function liveShadowReport(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const s = shadowState();
  const c = s.counters;
  const pct = (a: number, b: number) => (b > 0 ? +((a / b) * 100).toFixed(2) : null);
  return {
    versions: { ...LIVE_SHADOW_VERSIONS },
    authority: "SHADOW_ONLY — no production decision reads any field in this report",
    observed: c.observed,
    faults: c.faults,
    ringMax: LIVE_SHADOW_RING_MAX,
    stage15: {
      ...measureStage15Shadow(s.attempts, stage15ShadowConfig(env)),
      liveDecisionsSeen: c.stage15Pass + c.stage15Reject,
      liveRejectRatePct: pct(c.stage15Reject, c.stage15Pass + c.stage15Reject),
      attemptsWithOutcome: s.attempts.length,
    },
    featureSemanticsV2: {
      version: FEATURE_SEMANTICS_SHADOW_VERSION,
      compared: c.sessionWindowCompared,
      divergent: c.sessionWindowDivergent,
      divergentPct: pct(c.sessionWindowDivergent, c.sessionWindowCompared),
      worstPriorSessionBars: s.records.reduce(
        (a, r) => Math.max(a, r.sessionWindow?.priorSessionBars ?? 0), 0),
    },
    directionAwareLatePhase: {
      version: LIVE_SHADOW_VERSIONS.directionAwareLatePhase,
      compared: c.latePhaseCompared,
      disagrees: c.latePhaseDisagrees,
      disagreesPct: pct(c.latePhaseDisagrees, c.latePhaseCompared),
    },
    bearishDedupe: {
      ...summarizeDuplication(s.duplications),
      version: LIVE_SHADOW_VERSIONS.bearishDedupe,
      affectedLive: c.duplicationAffected,
    },
    tieDiagnostics: {
      ...measureStrategyTies(s.tieBoards),
      version: LIVE_SHADOW_VERSIONS.tieDiagnostics,
      tiesRecorded: s.ties.length,
      wonByMatchedCount: s.ties.filter((t) => t.wonByMatchedCount).length,
      winnerChangedDirection: s.ties.filter((t) => t.winnerChangesDirection).length,
      lowerHighWonTieOverOtherSide: s.ties.filter((t) => t.lowerHighWonTieOverOtherSide).length,
    },
  };
}

/** The most recent observations, newest last. For a diagnostic surface. */
export function liveShadowRecords(limit = 50): LiveShadowRecord[] {
  const s = shadowState();
  return s.records.slice(Math.max(0, s.records.length - Math.max(1, limit)));
}

/** Ties recorded this session, newest last. The direction-flip evidence. */
export function liveShadowTies(limit = 50): LiveTieRecord[] {
  const s = shadowState();
  return s.ties.slice(Math.max(0, s.ties.length - Math.max(1, limit)));
}

/** Test-only: drop every buffer so ordering cannot leak between tests. */
export function __resetLiveShadowForTest(): void {
  delete (globalThis as G).__optiscanOptionsLiveShadow;
}

/**
 * entry-window.ts — deterministic, FORWARD-LOOKING entry-window + anti-late model.
 * PURE (no I/O, no future data). Uses ONLY entry-time information (the live tape
 * snapshot + quote/spread age) to answer, for one candidate:
 *
 *   • What must happen NEXT before there is a valid entry?
 *   • Is there a valid entry RIGHT NOW, or is this early / late / a chase / missed?
 *   • What invalidates it / what is the do-not-enter condition?
 *
 * The root problem it fixes: an "ACTIONABLE" callout used to mean only "a tradable
 * contract exists" — it never checked whether the UNDERLYING had just set up a
 * valid long/short, already extended, or reversed. This gate requires live
 * momentum confirmation and blocks late/retrospective entries.
 *
 * It NEVER promises profitability, fabricates a target/probability, or weakens a
 * freshness/liquidity/risk gate — it only classifies lifecycle state and produces
 * forward-looking wait/entry/invalidation language.
 */

export type EntryState =
  | "EARLY"            // setup forming, no trigger yet
  | "NEAR_TRIGGER"     // approaching the trigger; watch for confirmation
  | "ACTIONABLE"       // trigger confirmed AND still inside the valid entry window
  | "WAIT_FOR_PULLBACK"// valid thesis but price is ahead of the entry zone
  | "EXTENDED"         // move already ran and is stalling — do not chase
  | "MISSED"           // the valid entry window has passed
  | "INVALIDATED"      // price is moving against the thesis (e.g. a call while falling)
  | "BLOCKED";         // stale quote / spread too wide — cannot act

export interface EntryWindowConfig {
  /** Above this |VWAP distance %| the entry zone is passed (→ wait for pullback). */
  maxEntryVwapDistPct: number;
  /** Above this |VWAP distance %| the move is extended/missed (no chase). */
  extendedVwapDistPct: number;
  /** Minimum relative volume for a confirmed (actionable) entry. */
  minRelVol: number;
  /** Quote age (ms) beyond which we cannot act on the option quote. */
  staleQuoteMs: number;
}

export function entryWindowConfig(env: NodeJS.ProcessEnv = process.env): EntryWindowConfig {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    // Momentum calibration (2026-07-14): a real breakout entry sits ~0.5–1.5%
    // above VWAP while it is accelerating — the old 0.6% zone was a mean-reversion
    // "buy the VWAP retest" band that structurally EXCLUDED breakout call/put
    // setups (e.g. NVDA's 10:30 breakout at +0.7–0.9% above VWAP), so they never
    // fired ACTIONABLE. Widen the band to catch breakouts; the accelerating +
    // relVol + fresh-quote gates still keep us out of the exhaustion top, and
    // anything beyond the extended cap is still "no chase". Fully env-overridable.
    maxEntryVwapDistPct: num(env.ENTRY_MAX_VWAP_DIST_PCT, 1.5),
    extendedVwapDistPct: num(env.ENTRY_EXTENDED_VWAP_DIST_PCT, 3.0),
    minRelVol: num(env.ENTRY_MIN_RELVOL, 1.2),
    staleQuoteMs: num(env.ENTRY_STALE_QUOTE_MS, 12_000),
  };
}

export interface MomentumSnapshot {
  /** Short-window rate of change of the underlying (sign = current direction). */
  shortRate: number | null;
  /** Acceleration: > 0 building, < 0 decelerating (a late move decelerates). */
  accel: number | null;
  /** Whether the underlying is above VWAP right now. */
  aboveVwap: boolean | null;
  /** Signed distance from VWAP in %: + above, − below. */
  vwapDistPct: number | null;
  /** Day move %. */
  movePct: number | null;
  /** Relative volume (confirmation). */
  relVol: number | null;
}

export interface EntryWindowInput {
  side: "call" | "put";
  regularSession: boolean;
  momentum: MomentumSnapshot | null;   // null = no live confirmation available
  quoteAgeMs: number | null;
  spreadPct: number | null;
  maxSpreadPct: number;                // reuse the contract-selector spread limit
  cfg?: EntryWindowConfig;
}

export interface EntryWindowResult {
  state: EntryState;
  /** NEXT REQUIRED CONDITION — what to wait for before entering. */
  waitFor: string;
  /** VALID ENTRY ONLY IF — the condition that makes an entry valid. */
  validEntry: string;
  /** DO NOT ENTER IF / DO NOT CHASE. */
  doNotEnter: string;
  /** CURRENT STATE — plain-English "where are we now". */
  currently: string;
  /** ALREADY HAPPENED — historical context (never the entry itself). */
  alreadyHappened: string | null;
  reasons: string[];
  /** True only when state === ACTIONABLE (there is a valid entry right now). */
  actionable: boolean;
}

/** Current tape direction from the short-window rate. */
function dirOf(m: MomentumSnapshot): "up" | "down" | "flat" {
  const r = m.shortRate ?? 0;
  if (r > 0.02) return "up";
  if (r < -0.02) return "down";
  return "flat";
}

/**
 * Assess the forward-looking entry window for one candidate. Deterministic; uses
 * only the provided entry-time snapshot.
 */
export function assessEntryWindow(input: EntryWindowInput): EntryWindowResult {
  const cfg = input.cfg ?? entryWindowConfig();
  const wantUp = input.side === "call";
  const dirWord = wantUp ? "up" : "down";
  const levelWord = wantUp ? "above VWAP / prior high" : "below VWAP / prior low";
  const reasons: string[] = [];

  // 1. Execution gate: a stale quote or blown-out spread can never be actionable.
  if (input.quoteAgeMs != null && input.quoteAgeMs > cfg.staleQuoteMs) {
    reasons.push(`option quote is ${(input.quoteAgeMs / 1000).toFixed(1)}s old (> ${(cfg.staleQuoteMs / 1000).toFixed(0)}s)`);
    return blocked("Wait for a fresh two-sided option quote.", reasons);
  }
  if (input.spreadPct != null && input.spreadPct > input.maxSpreadPct) {
    reasons.push(`spread ${input.spreadPct.toFixed(1)}% > ${input.maxSpreadPct}% limit`);
    return blocked("Wait for the option spread to tighten inside the limit.", reasons);
  }

  // 2. No live momentum = no forward-looking confirmation → never actionable.
  const m = input.momentum;
  if (!m || (m.shortRate == null && m.aboveVwap == null && m.vwapDistPct == null)) {
    return {
      state: "EARLY",
      waitFor: `Live momentum confirmation (${dirWord} move, ${levelWord}) before any entry.`,
      validEntry: `Only once the underlying confirms a fresh ${dirWord} move on volume.`,
      doNotEnter: "Do not enter on the option quote alone — the underlying has not confirmed.",
      currently: "No live entry confirmation yet — watching.",
      alreadyHappened: null,
      reasons: ["no live momentum snapshot — cannot confirm a forward-looking entry"],
      actionable: false,
    };
  }

  const dir = dirOf(m);
  const aligned = wantUp ? (dir === "up") : (dir === "down");
  const opposed = wantUp ? (dir === "down") : (dir === "up");
  const dist = m.vwapDistPct == null ? null : Math.abs(m.vwapDistPct);
  const onFavorableSide = wantUp
    ? (m.aboveVwap == null ? (m.vwapDistPct ?? 0) >= 0 : m.aboveVwap === true)
    : (m.aboveVwap == null ? (m.vwapDistPct ?? 0) <= 0 : m.aboveVwap === false);
  // "Building" is direction-relative: a call move accelerates up (accel ≥ 0), a
  // put move accelerates down (accel ≤ 0). A decelerating move is a late move.
  const accelerating = wantUp ? (m.accel ?? 0) >= 0 : (m.accel ?? 0) <= 0;
  const confirmedVol = (m.relVol ?? 0) >= cfg.minRelVol;
  const moved = Math.abs(m.movePct ?? 0) > 0.2;

  // 3. Moving AGAINST the thesis (the "call while it's falling" case) → invalidated.
  if (opposed && !onFavorableSide) {
    return {
      state: "INVALIDATED",
      waitFor: `A brand-new ${dirWord} setup — this one is moving against the trade.`,
      validEntry: "Not valid — do not enter against the current direction.",
      doNotEnter: `Do not enter: the underlying is moving ${dir} / on the wrong side of VWAP.`,
      currently: `Moving ${dir} — thesis invalidated.`,
      alreadyHappened: moved ? `Any earlier ${dirWord} move has reversed.` : null,
      reasons: [...reasons, `underlying is ${dir} and on the wrong side of VWAP for a ${input.side}`],
      actionable: false,
    };
  }

  // 4. Extension / anti-chase. A big |VWAP distance| means the move already ran.
  if (dist != null && dist >= cfg.extendedVwapDistPct) {
    const state: EntryState = accelerating ? "WAIT_FOR_PULLBACK" : (moved ? "MISSED" : "EXTENDED");
    return {
      state,
      waitFor: `A pullback toward the ${levelWord} entry zone (within ${cfg.maxEntryVwapDistPct}% of VWAP).`,
      validEntry: `Only on a controlled pullback into the entry zone — not at the current extended price.`,
      doNotEnter: `Do not chase: price is ${dist.toFixed(2)}% from VWAP (extended past the entry).`,
      currently: state === "MISSED" ? "Entry window has passed (move already ran)." : "Extended past the entry — wait or stand aside.",
      alreadyHappened: `The ${dirWord} move already ran ${dist.toFixed(2)}% from VWAP.`,
      reasons: [...reasons, `extended ${dist.toFixed(2)}% from VWAP (≥ ${cfg.extendedVwapDistPct}%)`, accelerating ? "still accelerating" : "decelerating"],
      actionable: false,
    };
  }

  // 5. Past the ideal entry zone but not extended → wait for pullback.
  if (dist != null && dist > cfg.maxEntryVwapDistPct) {
    return {
      state: "WAIT_FOR_PULLBACK",
      waitFor: `A pullback into the entry zone (within ${cfg.maxEntryVwapDistPct}% of VWAP).`,
      validEntry: `Only near the ${levelWord} entry zone — not ${dist.toFixed(2)}% away.`,
      doNotEnter: `Do not enter ${dist.toFixed(2)}% from VWAP — wait for the pullback.`,
      currently: "Ahead of the entry zone — waiting for a pullback.",
      alreadyHappened: `Price has moved ${dist.toFixed(2)}% from VWAP.`,
      reasons: [...reasons, `${dist.toFixed(2)}% from VWAP (> ${cfg.maxEntryVwapDistPct}% entry zone)`],
      actionable: false,
    };
  }

  // 6. Inside the entry zone. Confirmed + aligned + accelerating on volume ⇒ actionable.
  if (aligned && onFavorableSide && accelerating && confirmedVol && input.regularSession) {
    return {
      state: "ACTIONABLE",
      waitFor: "Trigger confirmed — enter now while the window is open.",
      validEntry: `Valid now: ${dirWord} and ${levelWord}, inside the entry zone on confirming volume.`,
      doNotEnter: `Do not enter if it loses ${wantUp ? "VWAP" : "the lower reclaim"} or relative volume fades.`,
      currently: "Trigger confirmed and inside the entry window.",
      alreadyHappened: null,
      reasons: [...reasons, `${dir} on the favorable side, accelerating, relVol ${(m.relVol ?? 0).toFixed(2)}`],
      actionable: true,
    };
  }

  // 7. Near the trigger but not fully confirmed (weak volume, decelerating, or not
  //    yet aligned) → near-trigger / early. Never actionable.
  const nearTrigger = onFavorableSide || aligned;
  return {
    state: nearTrigger ? "NEAR_TRIGGER" : "EARLY",
    waitFor: `A confirmed ${dirWord} move ${levelWord} on relative volume ≥ ${cfg.minRelVol}${!input.regularSession ? " (during regular hours)" : ""}.`,
    validEntry: `Valid once it holds ${levelWord} with volume confirmation, inside the entry zone.`,
    doNotEnter: "Do not front-run — wait for the trigger to actually confirm.",
    currently: nearTrigger ? "Approaching the trigger — not confirmed yet." : "Setup forming — no trigger yet.",
    alreadyHappened: null,
    reasons: [...reasons,
      !confirmedVol ? `relVol ${(m.relVol ?? 0).toFixed(2)} < ${cfg.minRelVol}` : "",
      !accelerating ? "decelerating" : "",
      !input.regularSession ? "outside regular hours" : "",
    ].filter(Boolean),
    actionable: false,
  };
}

function blocked(waitFor: string, reasons: string[]): EntryWindowResult {
  return {
    state: "BLOCKED",
    waitFor,
    validEntry: "Not valid until execution conditions (fresh quote, tight spread) are met.",
    doNotEnter: "Do not enter on a stale quote or blown-out spread.",
    currently: "Blocked on execution quality.",
    alreadyHappened: null,
    reasons,
    actionable: false,
  };
}

/** Map an entry-window state onto a callout candidate status. */
export function entryStateToCandidateStatus(state: EntryState): string {
  switch (state) {
    case "ACTIONABLE": return "ACTIONABLE_NOW";
    case "NEAR_TRIGGER": return "NEAR_TRIGGER";
    case "EARLY": return "DEVELOPING";
    case "WAIT_FOR_PULLBACK": return "WAIT_FOR_PULLBACK";
    case "EXTENDED": return "EXTENDED";
    case "MISSED": return "MISSED";
    case "INVALIDATED": return "INVALIDATED";
    case "BLOCKED": return "WATCH";
    default: return "WATCH";
  }
}

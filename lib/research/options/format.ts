/**
 * Discord copy for options callouts. Pure formatting only.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Frozen decision-time entry: round((bid + ask) / 2, 2). */
export function entryMidpoint(bid: number, ask: number): number { return round2((bid + ask) / 2); }

const SETUP_SENTENCE: Record<string, string> = {
  breakout_forming: "Compression into the level; breakout pressure building.",
  confirmed_breakout: "Level broke and holding with volume.",
  opening_range_breakout: "Opening-range break with volume.",
  premarket_level_break: "Premarket level break near the open.",
  sr_reclaim: "Reclaiming a lost level with acceptance.",
  pullback_continuation: "Controlled pullback resuming with the trend.",
  trend_continuation: "With-trend momentum resuming at VWAP.",
  vol_compression_expansion: "Compression resolving into expansion.",
  momentum_acceleration: "Momentum accelerating early, not extended.",
  reversal_bounce: "Reclaim at an extreme; early reversal forming.",
  failed_breakout: "Breakout rejected; fade setup.",
  momentum_breakdown: "Support broke with downside momentum and put flow confirmation.",
  failed_breakout_reversal: "Breakout failed and reversed through the trigger area.",
  vwap_rejection: "VWAP rejected and sellers kept control.",
  support_break_retest: "Support broke and failed its retest.",
  lower_high_continuation: "Lower high continuation with bearish structure intact.",
  bearish_opening_range_break: "Opening range broke lower with confirmation.",
  gap_failure: "Gap failed and downside continuation confirmed.",
  relative_weakness_continuation: "Relative weakness continued versus the broader tape.",
  downside_catalyst_continuation: "Bearish catalyst continuation with contract confirmation.",
  index_intraday_momentum: "Index trend leg with breadth.",
  zero_dte_index: "0DTE index level break/hold.",
  short_dated_directional: "Clean short-dated directional setup.",
  longer_dated_swing: "Higher-conviction multi-week setup.",
  earnings_continuation: "Post-earnings gap holding; continuation.",
  earnings_reversal: "Post-earnings gap failing; reversal.",
  unusual_options_activity: "Unusual options flow with directional skew.",
};

export function setupSentence(strategyKey: string): string {
  return SETUP_SENTENCE[strategyKey] ?? "Early forming setup near a decision level.";
}

const mmdd = (iso: string): string => {
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}` : iso;
};
const strikeStr = (n: number) => Number(n.toFixed(2)).toString();
const px = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(2));

export interface CompactAlertInput {
  symbol: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
  entryMid: number;
  t1: number;
  t2: number;
  stop: number;
  strategyKey: string;
  underlyingPrice?: number | null;
  keyLevel?: number | null;
  dte?: number | null;
}

export function formatCompactAlert(i: CompactAlertInput): string {
  const call = i.side === "call";
  const sym = i.symbol.toUpperCase();
  const lines: string[] = [];
  lines.push(`**WATCHING ${sym} $${strikeStr(i.strike)} ${call ? "CALL" : "PUT"}** - exp ${mmdd(i.expiration)}`);
  lines.push(setupSentence(i.strategyKey));
  if (i.underlyingPrice != null && i.underlyingPrice > 0) {
    const level = i.keyLevel != null && i.keyLevel > 0 ? ` | watching $${px(i.keyLevel)}` : "";
    lines.push(`${sym} @ $${px(i.underlyingPrice)}${level}`);
  }
  lines.push(`Entry around $${i.entryMid.toFixed(2)} | Targets $${i.t1.toFixed(2)} / $${i.t2.toFixed(2)}`);
  if (i.dte != null && i.dte <= 0) lines.push("0DTE: high risk, small size.");
  else if (i.dte != null && i.dte <= 2) lines.push("Short-dated: manage risk.");
  return lines.join("\n");
}

export interface PrivateLiveAlertInput extends CompactAlertInput {
  optionSymbol?: string | null;
  alertTimeEt?: string | null;
  timingClass?: "EARLY" | "TIMELY";
  actionableReason?: string | null;
  invalidation?: string | null;
  bid?: number | null;
  ask?: number | null;
  spreadPct?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  delta?: number | null;
  quoteAgeMs?: number | null;
  confidence?: number | null;
  detailUrl?: string | null;
  reasonSignals?: string[] | null;
  includeInternalLink?: boolean;
  /** Which lane produced this opening — OWNER_ONLY, PAPER, RESEARCH, SUBSCRIBER_APPROVED. */
  lane?: AlertLane | null;
  /** Readiness state of the strategy at send time (strategy_readiness_state.state). */
  readinessState?: string | null;
  /** Strategy version, or UNKNOWN_LEGACY_VERSION when the row predates attribution. */
  strategyVersion?: string | null;
  /** Living Opportunity Case this opening belongs to. */
  opportunityCaseId?: string | null;
  /** The mirrored paper position id, once reserved. Present => the exact trade is tracked. */
  paperTradeId?: number | null;
  /** Rank among the opportunities live at send time, e.g. "2 of 7". */
  rankLabel?: string | null;
  /** Evidence strength for the strategy at send time, where the readiness board has it. */
  evidenceStrength?: string | null;
}

export type AlertLane = "OWNER_ONLY" | "PAPER" | "RESEARCH" | "SUBSCRIBER_APPROVED";

/**
 * An opening may only present itself as a plain actionable trade when the strategy
 * is subscriber-approved AND it is being sent on the subscriber lane. Everything else
 * — owner testing, paper, research, a demoted or research-only strategy — has to say
 * so in the message itself.
 */
export function openingIsSubscriberGrade(
  lane: AlertLane | null | undefined,
  readinessState: string | null | undefined,
): boolean {
  return lane === "SUBSCRIBER_APPROVED"
    && String(readinessState ?? "").trim().toUpperCase() === "SUBSCRIBER_APPROVED";
}

export interface PlainEnglishAlertReasonInput {
  symbol: string;
  side: "call" | "put";
  strategyKey?: string | null;
  conditionIds?: string[] | null;
  sourceReason?: string | null;
}

const sentence = (value: string): string => {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const first = clean.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? clean;
  const bounded = first.length > 180 ? `${first.slice(0, 177).trimEnd()}...` : first;
  return /[.!?]$/.test(bounded) ? bounded : `${bounded}.`;
};

/**
 * Discord is a trader-facing surface, not an internal trace. This mapper accepts
 * deterministic condition IDs but never emits those IDs or raw gate language.
 */
export function plainEnglishAlertReason(input: PlainEnglishAlertReasonInput): string {
  const sym = input.symbol.toUpperCase();
  const signals = new Set((input.conditionIds ?? []).map((value) => String(value).toLowerCase()));
  const source = `${input.sourceReason ?? ""} ${input.strategyKey ?? ""}`.toLowerCase();
  const has = (...needles: string[]) => needles.some((needle) => signals.has(needle) || source.includes(needle));

  if (has("support_break") && has("failed_reclaim")) {
    return `${sym} broke support and failed to reclaim it.`;
  }
  if (has("support_break") && has("below_vwap_or_rejection") && has("downside_momentum", "downside_acceleration")) {
    return `${sym} broke support, stayed below VWAP, and bearish momentum increased.`;
  }
  if (has("below_vwap_or_rejection", "vwap_rejection") && has("downside_momentum", "momentum_breakdown")) {
    return `${sym} stayed below VWAP and bearish momentum increased.`;
  }
  if (source.includes("reclaimed vwap") && source.includes("resistance")) {
    return `${sym} reclaimed VWAP and broke above resistance with rising momentum.`;
  }
  if (source.includes("reclaimed vwap") && source.includes("momentum")) {
    return `${sym} reclaimed VWAP and momentum accelerated.`;
  }
  if (has("reclaimed_vwap", "sr_reclaim") && has("momentum_acceleration")) {
    return `${sym} reclaimed VWAP and momentum accelerated.`;
  }
  if (has("opening_range_breakout", "bearish_opening_range_break") && has("volume_confirmation", "volume")) {
    return input.side === "put"
      ? `${sym} broke below the opening range with rising volume.`
      : `${sym} broke the opening range with rising volume.`;
  }

  const byStrategy: Record<string, string> = {
    momentum_breakdown: `${sym} broke support and bearish momentum increased.`,
    failed_breakout_reversal: `${sym} failed at resistance and bearish momentum increased.`,
    failed_breakout: `${sym} failed at resistance and started moving lower.`,
    vwap_rejection: `${sym} stayed below VWAP and sellers remained in control.`,
    support_break_retest: `${sym} broke support and failed to reclaim it.`,
    lower_high_continuation: `${sym} formed a lower high and bearish momentum continued.`,
    bearish_opening_range_break: `${sym} broke below the opening range with bearish momentum.`,
    gap_failure: `${sym} lost its gap and bearish momentum increased.`,
    relative_weakness_continuation: `${sym} remained weaker than the broader market and continued lower.`,
    downside_catalyst_continuation: `${sym} continued lower after a bearish catalyst.`,
    sr_reclaim: `${sym} reclaimed a key level and held it.`,
    opening_range_breakout: `${sym} broke the opening range with rising momentum.`,
    confirmed_breakout: `${sym} broke above resistance and held the breakout.`,
    breakout_forming: `${sym} pressed against resistance as momentum increased.`,
    momentum_acceleration: input.side === "put"
      ? `${sym} stayed weak as bearish momentum increased.`
      : `${sym} gained momentum above a key level.`,
    pullback_continuation: input.side === "put"
      ? `${sym} failed to recover from a pullback and resumed lower.`
      : `${sym} held its pullback and resumed higher.`,
    trend_continuation: input.side === "put"
      ? `${sym} remained in a downtrend and bearish momentum continued.`
      : `${sym} remained in an uptrend and bullish momentum continued.`,
  };
  const mapped = input.strategyKey ? byStrategy[input.strategyKey] : null;
  if (mapped) return mapped;

  const candidate = sentence(String(input.sourceReason ?? ""));
  const looksInternal = /[_=[\]{}]|\b(?:gate|subscriber|pipeline|score|threshold|condition|blocker)\b/i.test(candidate);
  if (candidate && !looksInternal) {
    return candidate.toUpperCase().includes(sym) ? candidate : `${sym} ${candidate.charAt(0).toLowerCase()}${candidate.slice(1)}`;
  }
  return input.side === "put"
    ? `${sym} moved below a key level as bearish momentum increased.`
    : `${sym} moved above a key level as bullish momentum increased.`;
}

/**
 * The trade plan an owner opening must carry, and the entry convention each number is
 * measured against.
 *
 * ── Why the convention is spelled out rather than assumed ────────────────────
 *
 * Four different entry prices exist for the same callout, and the message used to show one
 * of them with no label at all:
 *
 *   - the BID–ASK zone in the heading, which is what the contract was quoted at;
 *   - the FROZEN MIDPOINT, which is what T1/T2/stop are derived from and what the exit
 *     rules in `grade.ts` compare a refreshed mark against;
 *   - the PAPER FILL, `conservativeEntryFill(bid, ask)`, which is what realized return,
 *     MFE and MAE are computed from;
 *   - the ASK, which PRE_MOVE contexts record as what the owner would actually have paid.
 *
 * Reconciling those into one number is a trading-policy decision that would move targets
 * and exits, and is deliberately NOT made here. What IS fixed is the silence: every price
 * below now says which convention it belongs to, so the reader is never left inferring it.
 *
 * ── Why Target 2 is labelled reference-only ──────────────────────────────────
 *
 * The live exit rule closes the WHOLE position at Target 1 (`decideOptionExit`, first
 * branch: `exitFill >= pos.target` -> `target_hit`, status EXITED). There is no partial
 * exit, no runner and no profit-lock anywhere in the production risk path. Printing T2 as
 * a second target would describe a position management that does not exist.
 */
function contractPlanLines(i: PrivateLiveAlertInput): string[] {
  const out: string[] = [];
  const has = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n > 0;

  out.push(
    `Entry shown: live bid/ask at callout · frozen entry $${px(i.entryMid)} (midpoint)`,
    "Targets and stop below are measured from the frozen entry.",
  );
  if (has(i.t1)) out.push(`Target 1: $${px(i.t1)} — FULL EXIT. The position closes here.`);
  if (has(i.stop)) out.push(`Stop: $${px(i.stop)}`);
  if (has(i.t2)) {
    out.push(`Target 2: $${px(i.t2)} — REFERENCE ONLY. Not an active target; nothing is held past Target 1.`);
  }
  out.push("");
  return out;
}

/** Primary Alerts-channel opening message. Technical evidence remains in the dossier. */
export function formatPrivateLiveAlert(i: PrivateLiveAlertInput): string {
  const call = i.side === "call";
  const sym = i.symbol.toUpperCase();
  const entryZone = i.bid != null && i.ask != null
    ? Math.abs(i.ask - i.bid) < 0.005
      ? `$${i.bid.toFixed(2)}`
      : `$${i.bid.toFixed(2)}–$${i.ask.toFixed(2)}`
    : `$${i.entryMid.toFixed(2)}`;
  const reason = plainEnglishAlertReason({
    symbol: sym,
    side: i.side,
    strategyKey: i.strategyKey,
    conditionIds: i.reasonSignals,
    sourceReason: i.actionableReason,
  });
  // A non-approved strategy must never read as a subscriber-ready trade. On
  // 2026-08-06 an unlabelled "🟢 SPY CALL ALERT" went out for breakout_forming while
  // that strategy was RESEARCH_ONLY / INSUFFICIENT_EVIDENCE, with nothing in the
  // message to say so.
  const subscriberGrade = openingIsSubscriberGrade(i.lane, i.readinessState);
  const laneLabel = i.lane ?? "OWNER_ONLY";
  // Owner openings are live forward-validation, not silence and not a subscriber call. They say
  // so, and they state that the exact contract below is the one being paper tracked.
  const paperTracked = i.paperTradeId != null && i.paperTradeId > 0;
  const heading = subscriberGrade
    ? `${call ? "🟢" : "🔴"} ${sym} ${call ? "CALL" : "PUT"} ALERT`
    : paperTracked
      ? `🔬 ${sym} ${call ? "CALL" : "PUT"} · OWNER VALIDATION — PAPER TRACKED`
      : `🔬 ${sym} ${call ? "CALL" : "PUT"} · OWNER WATCH · ${laneLabel} · NOT SUBSCRIBER-APPROVED`;
  const lines = [
    heading,
    "",
    `${sym} ${mmdd(i.expiration)} $${strikeStr(i.strike)} ${call ? "Call" : "Put"}`,
    `Entry: ${entryZone}`,
    "",
    `Why: ${reason}`,
    "",
  ];
  if (!subscriberGrade) {
    lines.push(
      ...contractPlanLines(i),
      `Lane: ${laneLabel} · Readiness: ${i.readinessState ?? "UNKNOWN"}`,
      `Strategy: ${i.strategyKey ?? "unknown"}@${i.strategyVersion ?? "UNKNOWN_LEGACY_VERSION"}`,
      ...(i.rankLabel ? [`Rank: ${i.rankLabel}${i.evidenceStrength ? ` · Evidence: ${i.evidenceStrength}` : ""}`]
        : i.evidenceStrength ? [`Evidence: ${i.evidenceStrength}`] : []),
      ...(i.opportunityCaseId ? [`Case: ${i.opportunityCaseId}`] : []),
      ...(i.optionSymbol ? [`Contract: ${i.optionSymbol}`] : []),
      paperTracked
        ? `Paper: tracking THIS contract from $${px(i.entryMid)} · position #${i.paperTradeId}`
        : "Paper: NOT yet mirrored — this opening is not being tracked.",
      "Research/paper simulation — not a subscriber recommendation.",
      "",
    );
  }
  lines.push("Educational purposes only. Options are high risk.");
  if (i.includeInternalLink === true && i.detailUrl) {
    lines.push("", `View details: ${i.detailUrl}`);
  }
  return lines.join("\n");
}

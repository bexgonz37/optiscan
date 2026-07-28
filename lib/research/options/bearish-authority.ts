/**
 * Deterministic bearish/PUT authority for the independent options path.
 *
 * This is the final authority for bearish subscriber delivery. Legacy scanner
 * rows, UI labels, AI output, and generic confidence scores may feed evidence
 * into this module, but they cannot bypass it.
 */
import { tradingDay } from "../../trading-session.ts";
import type { DeliveryInput } from "./delivery.ts";

export type BearishAuthorityState =
  | "BEARISH_BLOCK"
  | "BEARISH_RESEARCH"
  | "BEARISH_WATCH"
  | "BEARISH_READY"
  | "BEARISH_SEND";

export interface BearishAuthorityInput {
  symbol: string;
  side: "call" | "put";
  strategy: string;
  researchOnly: boolean;
  quality?: number | null;
  threshold?: number | null;
  matchedSignals?: number | null;
  requiredSignals?: number | null;
  strategyScore?: number | null;
  fractionMove?: number | null;
  deliveryInput: DeliveryInput;
  nowMs: number;
}

export interface BearishAuthorityDecision {
  state: BearishAuthorityState;
  maySubscriberSend: boolean;
  ownerReview: boolean;
  reasonCode: string;
  reasons: string[];
  blockers: string[];
  passed: string[];
  actionableReason: string | null;
  invalidation: string | null;
}

export interface BearishLegacyEscalationInput {
  legacyAlertId: number;
  symbol: string;
  occ: string | null;
  side: string | null;
  strategyFamily: string | null;
  signalScore: number | null;
  liquidityScore: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadPct: number | null;
  volume: number | null;
  openInterest: number | null;
  delta: number | null;
  timestamp: string;
  suppressionReason: string;
  nowMs?: number;
}

interface DbLike {
  prepare(sql: string): {
    get?: (...a: unknown[]) => unknown;
    run: (...a: unknown[]) => unknown;
  };
  exec?: (sql: string) => unknown;
}

const BEARISH_STRATEGIES = new Set([
  "momentum_breakdown",
  "failed_breakout_reversal",
  "vwap_rejection",
  "support_break_retest",
  "lower_high_continuation",
  "bearish_opening_range_break",
  "gap_failure",
  "relative_weakness_continuation",
  "downside_catalyst_continuation",
  "failed_breakout",
  "opening_range_breakout",
  "premarket_level_break",
  "momentum_acceleration",
  "pullback_continuation",
  "trend_continuation",
  "unusual_options_activity",
]);

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function bearishPipelineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BEARISH_PIPELINE_ENABLED === "1" || env.BEARISH_ACTIONABLE === "1";
}

export function bearishSubscriberDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BEARISH_SUBSCRIBER_DELIVERY_ENABLED === "1" || env.BEARISH_ACTIONABLE === "1";
}

export function bearishOwnerAlertsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BEARISH_OWNER_ALERTS_ENABLED === "1";
}

export function bearishStrategyFamilies(): string[] {
  return Array.from(BEARISH_STRATEGIES).sort();
}

function feature(input: BearishAuthorityInput): Record<string, any> {
  const fs = input.deliveryInput.featureSnapshot;
  const u = (fs && typeof fs === "object" ? (fs as any).underlying : null) ?? {};
  return u && typeof u === "object" ? u : {};
}

function contractBlockers(input: BearishAuthorityInput, env: NodeJS.ProcessEnv): string[] {
  const c = input.deliveryInput.contract;
  const blockers: string[] = [];
  const bid = num(c.bid);
  const ask = num(c.ask);
  const spread = num(c.spreadPct);
  const volume = num(c.volume);
  const oi = num(c.openInterest);
  const delta = Math.abs(num(c.delta) ?? 0);
  const dte = num(c.dte) ?? 0;
  const entryMid = num(input.deliveryInput.entry?.mid);
  const isZeroDte = dte <= 0;
  const maxSpread = Number(env.BEARISH_MAX_SPREAD_PCT ?? (isZeroDte ? 4 : 8));
  const minVol = Number(env.BEARISH_MIN_CONTRACT_VOLUME ?? (isZeroDte ? 1000 : 250));
  const minOi = Number(env.BEARISH_MIN_OPEN_INTEREST ?? (isZeroDte ? 1000 : 500));
  const minDelta = Number(env.BEARISH_MIN_ABS_DELTA ?? 0.35);
  const maxDelta = Number(env.BEARISH_MAX_ABS_DELTA ?? 0.65);
  const maxPremium = Number(env.BEARISH_MAX_PREMIUM ?? (isZeroDte ? 5 : 20));
  const maxAge = Number(env.BEARISH_MAX_QUOTE_AGE_MS ?? (isZeroDte ? 10_000 : 30_000));

  if (!c.optionSymbol || !String(c.optionSymbol).includes("P")) blockers.push("missing_or_non_put_occ");
  if (c.side !== "put") blockers.push("contract_side_not_put");
  if (bid == null || ask == null || bid <= 0 || ask <= 0) blockers.push("missing_fresh_bid_ask");
  if (bid != null && ask != null && ask < bid) blockers.push("crossed_quote");
  if (spread == null || spread > maxSpread) blockers.push(`spread_too_wide (${spread ?? "na"} > ${maxSpread})`);
  if (volume == null || volume < minVol) blockers.push(`insufficient_volume (${volume ?? "na"} < ${minVol})`);
  if (oi == null || oi < minOi) blockers.push(`insufficient_oi (${oi ?? "na"} < ${minOi})`);
  if (!delta || delta < minDelta || delta > maxDelta) blockers.push(`delta_out_of_band (${delta || "na"} not ${minDelta}-${maxDelta})`);
  if (entryMid == null || entryMid <= 0) blockers.push("missing_frozen_entry");
  if (entryMid != null && entryMid > maxPremium) blockers.push(`premium_too_high (${entryMid} > ${maxPremium})`);
  if (c.quoteAgeMs != null && c.quoteAgeMs > maxAge) blockers.push(`stale_quote (${c.quoteAgeMs} > ${maxAge})`);
  return blockers;
}

function riskBlockers(input: BearishAuthorityInput): string[] {
  const e = input.deliveryInput.entry;
  const blockers: string[] = [];
  if (!e || e.mid == null || e.mid <= 0) blockers.push("missing_frozen_entry");
  if (!e || e.stop == null || e.stop <= 0) blockers.push("missing_stop");
  if (!e || e.t1 == null || e.t1 <= e.mid) blockers.push("missing_t1");
  if (!e || e.t2 == null || e.t2 <= e.t1) blockers.push("missing_t2");
  if (e?.stop != null && e?.mid != null && e.stop >= e.mid) blockers.push("stop_not_below_entry");
  return blockers;
}

function timingBlockers(input: BearishAuthorityInput, env: NodeJS.ProcessEnv): string[] {
  const blockers: string[] = [];
  const dte = num(input.deliveryInput.contract.dte) ?? 0;
  const isZeroDte = dte <= 0;
  const fraction = num(input.fractionMove);
  const maxFraction = Number(env.BEARISH_MAX_FRACTION_MOVE ?? (isZeroDte ? 0.65 : 0.8));
  if (fraction != null && fraction >= maxFraction) blockers.push(`late_phase_fraction_move (${fraction} >= ${maxFraction})`);
  const chase = input.deliveryInput.observedUnderlyingPrice > 0
    ? ((input.deliveryInput.observedUnderlyingPrice - input.deliveryInput.currentUnderlyingPrice) / input.deliveryInput.observedUnderlyingPrice) * 100
    : 0;
  if (chase > input.deliveryInput.chaseLimitPct) blockers.push("late_chase_exceeded");
  if (isZeroDte && env.BEARISH_0DTE_LATE_SESSION_ENABLED !== "1") {
    const date = new Date(input.nowMs);
    const etMinutes = (date.getUTCHours() - 4) * 60 + date.getUTCMinutes();
    if (etMinutes >= 15 * 60) blockers.push("zero_dte_late_session_disabled");
  }
  return blockers;
}

function bearishConfirmations(input: BearishAuthorityInput): { passed: string[]; blockers: string[] } {
  const f = feature(input);
  const passed: string[] = [];
  const blockers: string[] = [];
  const vel = num(f.velPct);
  const accel = num(f.accelPct);
  const shortMomentum = num(f.shortMomentumPct);
  const trendSlope = num(f.trendSlopePctPerBar);
  const vwapDist = num(f.vwapDistPct);
  const current = num(input.deliveryInput.currentUnderlyingPrice);
  const observed = num(input.deliveryInput.observedUnderlyingPrice);

  if (vel != null && vel < 0) passed.push("downside_momentum");
  if (accel != null && accel < 0) passed.push("downside_acceleration");
  if (shortMomentum != null && shortMomentum < 0) passed.push("negative_short_momentum");
  if (trendSlope != null && trendSlope < 0) passed.push("lower_high_or_downtrend");
  if (f.aboveVwap === false || (vwapDist != null && vwapDist < 0)) passed.push("below_vwap_or_rejection");
  if (f.lodBreak === true) passed.push("support_break");
  if (f.nearestSupportDistPct != null && Number(f.nearestSupportDistPct) <= 0.5) passed.push("support_retest_nearby");
  if (String((input.deliveryInput.featureSnapshot as any)?.chain?.direction ?? "").includes("put")) passed.push("put_flow_skew");
  if (current != null && observed != null && current < observed) passed.push("current_underlying_below_detection");

  if (!passed.includes("below_vwap_or_rejection") && !passed.includes("support_break")) {
    blockers.push("missing_bearish_structure");
  }
  if (passed.filter((x) => x !== "current_underlying_below_detection").length < 2) {
    blockers.push("insufficient_bearish_confirmations");
  }
  return { passed, blockers };
}

export function evaluateBearishAuthority(
  input: BearishAuthorityInput,
  env: NodeJS.ProcessEnv = process.env,
): BearishAuthorityDecision {
  if (input.side !== "put") {
    return {
      state: "BEARISH_SEND",
      maySubscriberSend: true,
      ownerReview: false,
      reasonCode: "not_bearish",
      reasons: ["non-bearish candidate uses the normal call path"],
      blockers: [],
      passed: [],
      actionableReason: null,
      invalidation: null,
    };
  }

  const reasons: string[] = [];
  const blockers: string[] = [];
  const passed: string[] = [];
  if (!bearishPipelineEnabled(env)) {
    return {
      state: "BEARISH_RESEARCH",
      maySubscriberSend: false,
      ownerReview: false,
      reasonCode: "bearish_pipeline_disabled",
      reasons: ["BEARISH_PIPELINE_ENABLED!=1"],
      blockers: ["bearish_pipeline_disabled"],
      passed,
      actionableReason: null,
      invalidation: null,
    };
  }
  if (input.researchOnly) blockers.push("candidate_marked_research_only");
  if (!BEARISH_STRATEGIES.has(input.strategy)) blockers.push(`unsupported_bearish_strategy:${input.strategy}`);
  const quality = num(input.quality);
  const threshold = num(input.threshold);
  if (quality != null && threshold != null && quality < threshold) blockers.push(`below_subscriber_threshold (${quality} < ${threshold})`);

  const conf = bearishConfirmations(input);
  passed.push(...conf.passed);
  blockers.push(...conf.blockers);
  blockers.push(...contractBlockers(input, env));
  blockers.push(...riskBlockers(input));
  blockers.push(...timingBlockers(input, env));

  const actionableReason = passed.length
    ? `Bearish structure confirmed: ${passed.slice(0, 4).join(", ")}.`
    : null;
  const invalidation = input.deliveryInput.entry?.stop != null
    ? `PUT invalidates if premium loses stop ${input.deliveryInput.entry.stop.toFixed(2)} or underlying reclaims bearish structure.`
    : "PUT invalidates if underlying reclaims VWAP/support or quote quality deteriorates.";

  if (blockers.some((b) => b.includes("missing_fresh_bid_ask") || b.includes("crossed_quote") || b.includes("missing_or_non_put_occ"))) {
    return { state: "BEARISH_BLOCK", maySubscriberSend: false, ownerReview: false, reasonCode: "bearish_block", reasons, blockers, passed, actionableReason, invalidation };
  }
  if (blockers.length) {
    return { state: "BEARISH_WATCH", maySubscriberSend: false, ownerReview: bearishOwnerAlertsEnabled(env), reasonCode: blockers[0], reasons, blockers, passed, actionableReason, invalidation };
  }
  if (!bearishSubscriberDeliveryEnabled(env)) {
    return {
      state: "BEARISH_READY",
      maySubscriberSend: false,
      ownerReview: bearishOwnerAlertsEnabled(env),
      reasonCode: "bearish_ready_owner_review_only",
      reasons: ["Qualified bearish setup; subscriber PUT delivery disabled until explicit activation."],
      blockers: ["BEARISH_SUBSCRIBER_DELIVERY_ENABLED!=1"],
      passed,
      actionableReason,
      invalidation,
    };
  }
  return {
    state: "BEARISH_SEND",
    maySubscriberSend: true,
    ownerReview: false,
    reasonCode: "bearish_send_authorized",
    reasons: ["Qualified bearish setup; subscriber PUT delivery explicitly enabled."],
    blockers: [],
    passed,
    actionableReason,
    invalidation,
  };
}

export function formatBearishOwnerReview(input: BearishAuthorityInput, decision: BearishAuthorityDecision): string {
  const c = input.deliveryInput.contract;
  const e = input.deliveryInput.entry;
  const bidAsk = c.bid != null && c.ask != null ? `$${c.bid.toFixed(2)} / $${c.ask.toFixed(2)}` : "missing";
  const freshness = c.quoteAgeMs == null ? "unknown" : `${Math.round(c.quoteAgeMs / 1000)}s`;
  const strike = c.strike != null ? `$${Number(c.strike).toFixed(Number(c.strike) % 1 === 0 ? 0 : 2)}` : "missing";
  const expiration = c.expiration ?? "missing";
  const risk = decision.invalidation ?? (decision.blockers[0] ? `Main blocker: ${decision.blockers[0]}` : "Underlying reclaims bearish structure or quote quality deteriorates.");
  return [
    `BEARISH TRADE CANDIDATE`,
    `${input.symbol} PUT ${c.optionSymbol}`,
    `Strike/expiration: ${strike} exp ${expiration}`,
    `Entry zone: ${c.bid != null && c.ask != null ? `$${c.bid.toFixed(2)}-$${c.ask.toFixed(2)}` : e?.mid != null ? `$${e.mid.toFixed(2)}` : "pending"}`,
    `Trigger: ${decision.actionableReason ?? "bearish setup under review"}`,
    `Stop: ${e?.stop != null ? `$${e.stop.toFixed(2)}` : "missing"} | T1: ${e?.t1 != null ? `$${e.t1.toFixed(2)}` : "missing"} | T2: ${e?.t2 != null ? `$${e.t2.toFixed(2)}` : "missing"}`,
    `Confidence: ${input.quality != null ? input.quality.toFixed(4) : input.strategyScore ?? "n/a"}`,
    `Setup family: ${input.strategy}`,
    `Bid/Ask: ${bidAsk} | Spread: ${c.spreadPct ?? "n/a"}% | Vol: ${c.volume ?? "n/a"} | OI: ${c.openInterest ?? "n/a"} | Delta: ${c.delta ?? "n/a"} | Freshness: ${freshness}`,
    `Why actionable: ${decision.actionableReason ?? (decision.passed.length ? decision.passed.join(", ") : "under review")}`,
    `Main risk: ${risk}`,
    `Passed: ${decision.passed.length ? decision.passed.join(", ") : "none"}`,
    `Remaining blockers: ${decision.blockers.length ? decision.blockers.join("; ") : "none"}`,
    `Subscriber SEND under proposed rules: ${decision.maySubscriberSend ? "YES" : "NO"}`,
    decision.maySubscriberSend
      ? `_Owner notification - subscriber delivery may also proceed after final proof gates._`
      : `_Owner review only - not a delivered subscriber alert._`,
  ].join("\n");
}

export function ensureBearishEscalationTable(db: DbLike): void {
  db.exec?.(`
    CREATE TABLE IF NOT EXISTS options_bearish_escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_alert_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      occ TEXT,
      side TEXT,
      strategy_family TEXT,
      signal_score REAL,
      liquidity_score REAL,
      bid REAL,
      ask REAL,
      mid REAL,
      spread_pct REAL,
      volume REAL,
      open_interest REAL,
      delta REAL,
      alert_time TEXT NOT NULL,
      suppression_reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at_ms INTEGER NOT NULL,
      UNIQUE(legacy_alert_id, occ)
    );
  `);
}

export function recordBearishLegacyEscalationOnDb(db: DbLike, input: BearishLegacyEscalationInput): boolean {
  if (String(input.side ?? "").toLowerCase() !== "put") return false;
  ensureBearishEscalationTable(db);
  const nowMs = input.nowMs ?? Date.now();
  const info: any = db.prepare(
    `INSERT OR IGNORE INTO options_bearish_escalations (
      legacy_alert_id, symbol, occ, side, strategy_family, signal_score, liquidity_score,
      bid, ask, mid, spread_pct, volume, open_interest, delta, alert_time, suppression_reason,
      status, created_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.legacyAlertId,
    input.symbol.toUpperCase(),
    input.occ,
    input.side,
    input.strategyFamily,
    input.signalScore,
    input.liquidityScore,
    input.bid,
    input.ask,
    input.mid,
    input.spreadPct,
    input.volume,
    input.openInterest,
    input.delta,
    input.timestamp,
    input.suppressionReason,
    "PENDING",
    nowMs,
  );
  return Number(info?.changes ?? 0) > 0;
}

export function latestPendingBearishEscalationForSymbol(db: DbLike, symbol: string, nowMs = Date.now(), lookbackMs = 30 * 60_000): any | null {
  try {
    ensureBearishEscalationTable(db);
    return db.prepare(
      `SELECT * FROM options_bearish_escalations
       WHERE symbol=? AND status='PENDING' AND created_at_ms >= ?
       ORDER BY created_at_ms DESC LIMIT 1`,
    ).get?.(symbol.toUpperCase(), nowMs - lookbackMs) ?? null;
  } catch {
    return null;
  }
}

export function markBearishEscalationEvaluated(db: DbLike, id: number, status = "EVALUATED"): void {
  try {
    ensureBearishEscalationTable(db);
    db.prepare("UPDATE options_bearish_escalations SET status=? WHERE id=?").run(status, id);
  } catch { /* isolated */ }
}

export function bearishEscalationTradingDay(input: BearishLegacyEscalationInput): string {
  const ms = Date.parse(input.timestamp);
  return tradingDay(Number.isFinite(ms) ? ms : input.nowMs ?? Date.now());
}

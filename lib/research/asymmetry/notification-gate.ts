/**
 * notification-gate.ts — the decision to SPEAK, kept separate from the decision
 * to CAPTURE. PURE, versioned, deterministic. No AI.
 *
 * Production on 2026-07-31 sent 39 owner-private messages from 62 captures. A
 * ~63% alert-to-capture ratio is not research surfacing, it is noise, and the
 * signal that matters gets lost in it.
 *
 * THE FIX IS NOT TO CAPTURE LESS. Backend capture, forward marks, paper
 * eligibility and Quant must all keep seeing everything — the research value is
 * in the full population. What changes is only how much of it reaches Discord.
 *
 * DEFAULTS BY STATE:
 *   EARLY_ASYMMETRY  — silent always. It is by definition unconfirmed.
 *   CONFIRMING       — silent unless the strength gate passes.
 *   HIGH_ASYMMETRY   — eligible.
 *   TRIGGERED        — eligible.
 *   everything else  — never an opening notification.
 *
 * A MINIMUM PRESENTATION PAYLOAD is also required for the eligible states: a
 * message with no executable quote and no underlying price is not worth
 * interrupting someone for, and sending it teaches them to ignore the channel.
 * Failing that check suppresses the MESSAGE ONLY — the case is still captured,
 * still marked, still paper-eligible, still counted by Quant.
 *
 * Liquidity and premium-chase blockers can never be bypassed here: this gate
 * only ever makes notification STRICTER than the state machine already did.
 */
import type { AsymmetryResearchState } from "./states.ts";

export const NOTIFICATION_GATE_VERSION = "ASYM_NOTIFY_V1" as const;

/** States that may ever produce an opening notification. */
export const NOTIFY_ELIGIBLE_STATES: readonly AsymmetryResearchState[] = Object.freeze([
  "HIGH_ASYMMETRY", "TRIGGERED",
]);
/** Silent unless the strength gate passes. */
export const NOTIFY_GATED_STATES: readonly AsymmetryResearchState[] = Object.freeze(["CONFIRMING"]);

export interface NotificationStrengthConfig {
  /** Spread above this is never worth surfacing, whatever else is true. */
  maxSpreadPct: number;
  /** Premium expansion at or above this means the early entry is gone. */
  maxPremiumChasePct: number;
  minOpenInterest: number;
  minContractVolume: number;
  /** CONFIRMING must be at least this complete to earn a message. */
  maxMissingEvidenceForConfirming: number;
}

export const DEFAULT_NOTIFICATION_STRENGTH: Readonly<NotificationStrengthConfig> = Object.freeze({
  maxSpreadPct: 15,
  maxPremiumChasePct: 20,
  minOpenInterest: 250,
  minContractVolume: 25,
  maxMissingEvidenceForConfirming: 2,
});

export function resolveNotificationStrength(env: NodeJS.ProcessEnv = process.env): NotificationStrengthConfig {
  const n = (raw: string | undefined, d: number, lo: number, hi: number): number => {
    const x = Number(raw);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return {
    maxSpreadPct: n(env.ASYM_NOTIFY_MAX_SPREAD_PCT, DEFAULT_NOTIFICATION_STRENGTH.maxSpreadPct, 1, 100),
    maxPremiumChasePct: n(env.ASYM_NOTIFY_MAX_CHASE_PCT, DEFAULT_NOTIFICATION_STRENGTH.maxPremiumChasePct, 1, 200),
    minOpenInterest: n(env.ASYM_NOTIFY_MIN_OI, DEFAULT_NOTIFICATION_STRENGTH.minOpenInterest, 0, 100_000),
    minContractVolume: n(env.ASYM_NOTIFY_MIN_VOL, DEFAULT_NOTIFICATION_STRENGTH.minContractVolume, 0, 100_000),
    maxMissingEvidenceForConfirming: Math.floor(
      n(env.ASYM_NOTIFY_MAX_MISSING, DEFAULT_NOTIFICATION_STRENGTH.maxMissingEvidenceForConfirming, 0, 20)),
  };
}

/** Everything the gate may look at. Measured values only — nothing inferred. */
export interface NotificationEvidence {
  state: AsymmetryResearchState;
  optionSymbol: string | null;
  bid: number | null;
  ask: number | null;
  quoteAtMs: number | null;
  underlyingPrice: number | null;
  spreadPct: number | null;
  premiumChasePct: number | null;
  openInterest: number | null;
  contractVolume: number | null;
  missingEvidence: string[];
  trigger: string | null;
  invalidation: string | null;
}

export interface NotificationDecision {
  notify: boolean;
  /** Machine-readable suppression reason. Persisted for the ratio report. */
  reason: string;
  version: string;
  /** True when the case is captured and tracked but deliberately silent. */
  silentCapture: boolean;
}

const OCC = /^O:[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Decide whether this state change earns a Discord message.
 *
 * Returning `notify: false` NEVER means "discard" — every caller still
 * persists the transition and keeps the case in the research population. That
 * separation is the whole point of this module.
 */
export function decideNotification(
  e: NotificationEvidence,
  cfg: NotificationStrengthConfig = DEFAULT_NOTIFICATION_STRENGTH,
): NotificationDecision {
  const no = (reason: string): NotificationDecision =>
    ({ notify: false, reason, version: NOTIFICATION_GATE_VERSION, silentCapture: true });

  // 1. State. EARLY is silent by definition; the chased/failed states never open.
  if (e.state === "EARLY_ASYMMETRY") return no("SILENT_EARLY_ASYMMETRY");
  const eligible = NOTIFY_ELIGIBLE_STATES.includes(e.state);
  const gated = NOTIFY_GATED_STATES.includes(e.state);
  if (!eligible && !gated) return no(`STATE_NOT_NOTIFIABLE_${e.state}`);

  // 2. Minimum presentation payload. A message nobody can act on is worse than
  //    silence, because it trains the reader to ignore the channel.
  if (!e.optionSymbol || !OCC.test(e.optionSymbol)) return no("INSUFFICIENT_NOTIFICATION_EVIDENCE_NO_OCC");
  const ask = num(e.ask);
  if (ask == null || ask <= 0) return no("INSUFFICIENT_NOTIFICATION_EVIDENCE_NO_ENTRY_QUOTE");
  if (num(e.quoteAtMs) == null) return no("INSUFFICIENT_NOTIFICATION_EVIDENCE_NO_QUOTE_TIMESTAMP");
  if (num(e.underlyingPrice) == null) return no("INSUFFICIENT_NOTIFICATION_EVIDENCE_NO_UNDERLYING");

  // 3. Hard quality blockers. These can never be bypassed, in any state.
  const spread = num(e.spreadPct);
  if (spread != null && spread > cfg.maxSpreadPct) return no(`UNUSABLE_SPREAD_${spread.toFixed(1)}`);
  const chase = num(e.premiumChasePct);
  if (chase != null && chase >= cfg.maxPremiumChasePct) return no(`PREMIUM_CHASE_${chase.toFixed(1)}`);
  const oi = num(e.openInterest);
  if (oi != null && oi < cfg.minOpenInterest) return no(`WEAK_OPEN_INTEREST_${oi}`);
  const vol = num(e.contractVolume);
  if (vol != null && vol < cfg.minContractVolume) return no(`WEAK_CONTRACT_VOLUME_${vol}`);

  // 4. CONFIRMING must additionally be well described. HIGH_ASYMMETRY and
  //    TRIGGERED already cleared a higher bar in the state machine itself.
  if (gated && e.missingEvidence.length > cfg.maxMissingEvidenceForConfirming) {
    return no(`CONFIRMING_EVIDENCE_INCOMPLETE_${e.missingEvidence.length}`);
  }

  return { notify: true, reason: "NOTIFY", version: NOTIFICATION_GATE_VERSION, silentCapture: false };
}

/** The headline health number: how much of what we capture we actually say. */
export function alertToCaptureRatio(captured: number, notified: number): number | null {
  if (!Number.isFinite(captured) || captured <= 0) return null; // unknown, never 0
  return Math.round((notified / captured) * 1000) / 10;
}

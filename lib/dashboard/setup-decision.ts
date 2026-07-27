/**
 * Single classifier mapping setups into trader-facing decision states.
 * Presentation + UI routing only — does not change Discord delivery gates.
 */
import type { OperatingMode } from "./operating-mode.ts";

export type DecisionState = "TRADE_NOW" | "ALMOST_READY" | "TOMORROW" | "AVOID";

export type DecisionStateLabel = "TRADE NOW" | "ALMOST READY" | "TOMORROW'S WATCHLIST" | "AVOID";

export const DECISION_LABEL: Record<DecisionState, DecisionStateLabel> = {
  TRADE_NOW: "TRADE NOW",
  ALMOST_READY: "ALMOST READY",
  TOMORROW: "TOMORROW'S WATCHLIST",
  AVOID: "AVOID",
};

export interface SetupDecisionInput {
  operatingMode: OperatingMode;
  /** SEND | WATCH | BLOCK | RESEARCH | WAIT from existing mappers */
  systemAction?: string | null;
  entryStatusLabel?: string | null;
  status?: string | null;
  quoteFreshness?: string | null;
  contractReady?: boolean;
  contractThin?: boolean;
  contractUnavailable?: boolean;
  hasFreshBidAsk?: boolean;
  spreadPct?: number | null;
  actionable?: boolean;
  primaryBlockingReason?: string | null;
  researchOnly?: boolean;
  overnightLane?: boolean;
  /** Explicit confirmation still needed (near trigger, wait for pullback, etc.) */
  waitFor?: string | null;
  negativeQuantEvidence?: boolean;
  chasedOrLate?: boolean;
}

export interface SetupDecision {
  state: DecisionState;
  label: DecisionStateLabel;
  /** One clear confirmation needed when ALMOST_READY */
  confirmationNeeded: string | null;
  executable: boolean;
  quoteLabel: "FRESH" | "STALE · PRIOR SESSION" | "UNAVAILABLE";
  verifyContractAfterOpen: boolean;
}

const BLOCKED_STATUSES = new Set([
  "NO_VALID_CONTRACT",
  "DATA_STALE",
  "INVALIDATED",
  "BLOCKED",
]);

const CLOSED_MODES = new Set<OperatingMode>([
  "PREMARKET_RESEARCH",
  "AFTER_HOURS_RESEARCH",
  "OVERNIGHT_RESEARCH",
  "WEEKEND_PLANNING",
]);

/**
 * Classify a setup into exactly one primary decision group.
 */
export function classifySetupDecision(input: SetupDecisionInput): SetupDecision {
  const mode = input.operatingMode;
  const closed = CLOSED_MODES.has(mode) || mode === "MARKET_DATA_UNAVAILABLE" || mode === "SYSTEM_OFFLINE";
  const action = String(input.systemAction ?? "").toUpperCase();
  const status = String(input.status ?? "").toUpperCase();
  const entryLabel = String(input.entryStatusLabel ?? "").toUpperCase();
  const blocked =
    Boolean(input.primaryBlockingReason)
    || BLOCKED_STATUSES.has(status)
    || action === "BLOCK"
    || input.negativeQuantEvidence === true
    || input.chasedOrLate === true
    || (input.spreadPct != null && input.spreadPct > 20);

  if (blocked || input.researchOnly === true && action === "BLOCK") {
    return {
      state: "AVOID",
      label: DECISION_LABEL.AVOID,
      confirmationNeeded: null,
      executable: false,
      quoteLabel: closed ? "STALE · PRIOR SESSION" : input.hasFreshBidAsk ? "FRESH" : "UNAVAILABLE",
      verifyContractAfterOpen: closed,
    };
  }

  // Overnight / closed market: never TRADE NOW.
  if (closed || input.overnightLane) {
    if (action === "BLOCK" || blocked) {
      return {
        state: "AVOID",
        label: DECISION_LABEL.AVOID,
        confirmationNeeded: null,
        executable: false,
        quoteLabel: "STALE · PRIOR SESSION",
        verifyContractAfterOpen: true,
      };
    }
    return {
      state: "TOMORROW",
      label: DECISION_LABEL.TOMORROW,
      confirmationNeeded: null,
      executable: false,
      quoteLabel: "STALE · PRIOR SESSION",
      verifyContractAfterOpen: true,
    };
  }

  // Regular session — TRADE NOW only with fresh executable contract.
  const freshOk =
    input.hasFreshBidAsk === true
    && input.quoteFreshness === "fresh"
    && input.contractReady === true
    && !input.contractUnavailable
    && !input.contractThin
    && (input.spreadPct == null || input.spreadPct <= 12);

  const actionableNow =
    (input.actionable === true || entryLabel.includes("ACTIONABLE") || status === "ACTIONABLE_NOW")
    && (action === "SEND" || action === "WATCH");

  if (freshOk && actionableNow && mode === "REGULAR_SESSION_LIVE") {
    return {
      state: "TRADE_NOW",
      label: DECISION_LABEL.TRADE_NOW,
      confirmationNeeded: null,
      executable: true,
      quoteLabel: "FRESH",
      verifyContractAfterOpen: false,
    };
  }

  // Research-only / put research during RTH → AVOID for primary actionable path
  // (still shown under AVOID, not TOMORROW, during live session).
  if (input.researchOnly || action === "RESEARCH") {
    return {
      state: "AVOID",
      label: DECISION_LABEL.AVOID,
      confirmationNeeded: null,
      executable: false,
      quoteLabel: input.hasFreshBidAsk ? "FRESH" : "UNAVAILABLE",
      verifyContractAfterOpen: false,
    };
  }

  // ALMOST READY — one clear confirmation.
  const confirmation =
    input.waitFor
    || (entryLabel.includes("PULLBACK") ? "Wait for pullback confirmation" : null)
    || (status === "NEAR_TRIGGER" || entryLabel.includes("NEAR") ? "Hold above trigger for confirmation" : null)
    || (input.contractThin ? "Spread must tighten before entry" : null)
    || (!freshOk && actionableNow ? "Fresh executable quote required" : null)
    || (status === "DEVELOPING" ? "Setup still developing" : null)
    || "Needs one more confirmation";

  if (
    action === "WATCH"
    || action === "WAIT"
    || status === "NEAR_TRIGGER"
    || status === "DEVELOPING"
    || entryLabel.includes("WAIT")
    || entryLabel.includes("NEAR")
    || (actionableNow && !freshOk)
  ) {
    return {
      state: "ALMOST_READY",
      label: DECISION_LABEL.ALMOST_READY,
      confirmationNeeded: confirmation,
      executable: false,
      quoteLabel: input.hasFreshBidAsk && input.quoteFreshness === "fresh" ? "FRESH" : "UNAVAILABLE",
      verifyContractAfterOpen: false,
    };
  }

  // No executable contract during RTH without a clear near-trigger → TOMORROW planning.
  if (input.contractUnavailable || !input.hasFreshBidAsk) {
    return {
      state: "TOMORROW",
      label: DECISION_LABEL.TOMORROW,
      confirmationNeeded: null,
      executable: false,
      quoteLabel: "UNAVAILABLE",
      verifyContractAfterOpen: true,
    };
  }

  return {
    state: "ALMOST_READY",
    label: DECISION_LABEL.ALMOST_READY,
    confirmationNeeded: confirmation,
    executable: false,
    quoteLabel: "FRESH",
    verifyContractAfterOpen: false,
  };
}

export function decisionTone(state: DecisionState): "ok" | "warn" | "info" | "bad" | "muted" {
  switch (state) {
    case "TRADE_NOW":
      return "ok";
    case "ALMOST_READY":
      return "warn";
    case "TOMORROW":
      return "info";
    case "AVOID":
      return "bad";
  }
}

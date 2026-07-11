/**
 * paper-explain.ts — deterministic explanation of a paper trade (rebuild).
 *
 * Reuses the completed shared explanation vocabulary (rejectionToPlain from
 * lib/trade-explanation) so contract-rejection wording is not duplicated. PURE:
 * builds only from verified structured fields already recorded on the trade —
 * no generative model, no fabricated metrics. Every field is null when its
 * source is absent.
 */
import { rejectionToPlain, type ActionabilityStatus } from "./trade-explanation.ts";
import type { RevalidationCode } from "./paper-revalidation.ts";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface PaperExplanationInput {
  ticker: string;
  side: "call" | "put" | null;
  status: string;
  orderState: string | null;
  positionState: string | null;
  strategy?: string | null;
  thesis?: string | null;
  selectionScore?: number | null;
  revalidationOk?: boolean | null;
  revalidationReason?: string | null;
  revalidationCode?: RevalidationCode | null;
  drift?: {
    spreadWidened?: boolean;
    spreadPctAtAlert?: number | null;
    spreadPctNow?: number | null;
    midMovePct?: number | null;
    dteChanged?: boolean;
  } | null;
  entryPrice?: number | null;
  entrySlippage?: number | null;
  entryFees?: number | null;
  exitPrice?: number | null;
  exitSlippage?: number | null;
  exitFees?: number | null;
  closeReason?: string | null;
  exitReason?: string | null;
}

export interface PaperExplanation {
  ticker: string;
  side: "call" | "put" | null;
  actionabilityStatus: ActionabilityStatus;
  qualified: string | null;
  revalidated: string | null;
  fillOrReject: string | null;
  exit: string | null;
  costImpact: string | null;
}

function actionabilityFor(input: PaperExplanationInput): ActionabilityStatus {
  if (input.positionState === "OPEN") return "ACTIONABLE";
  if (input.positionState === "CLOSED" || input.positionState === "EXPIRED") return "ACTIONABLE";
  if (input.orderState === "REJECTED" || input.orderState === "CANCELLED") {
    return input.revalidationCode ? "NO_VALID_CONTRACT" : "BLOCKED";
  }
  if (input.positionState === "INVALIDATED") return "INVALIDATED";
  return "WATCH";
}

export function buildPaperExplanation(input: PaperExplanationInput): PaperExplanation {
  const qualified = input.thesis
    ? `Qualified: ${input.thesis}${isNum(input.selectionScore) ? ` (selection score ${Math.round(input.selectionScore)})` : ""}.`
    : null;

  let revalidated: string | null = null;
  if (input.revalidationOk === true) {
    const drift = input.drift;
    const driftBits: string[] = [];
    if (drift?.spreadWidened && isNum(drift.spreadPctAtAlert) && isNum(drift.spreadPctNow)) {
      driftBits.push(`spread ${drift.spreadPctAtAlert.toFixed(1)}%→${drift.spreadPctNow.toFixed(1)}%`);
    }
    if (isNum(drift?.midMovePct)) driftBits.push(`mid moved ${drift!.midMovePct! > 0 ? "+" : ""}${drift!.midMovePct}%`);
    revalidated = `Revalidated the alert-time contract against a fresh chain${driftBits.length ? ` — ${driftBits.join(", ")}` : ""}.`;
  } else if (input.revalidationOk === false) {
    if (input.revalidationCode === "CONTRACT_DISAPPEARED") {
      revalidated = "The alert-time contract was no longer in the chain — entry rejected, no substitution.";
    } else if (input.revalidationCode === "IDENTITY_MISMATCH") {
      revalidated = "The contract's identity changed — entry rejected, no substitution.";
    } else if (input.revalidationCode) {
      revalidated = rejectionToPlain(input.revalidationCode as any, input.side).rejectedBecause;
    } else if (input.revalidationReason) {
      revalidated = input.revalidationReason;
    }
  }

  let fillOrReject: string | null = null;
  if (input.orderState === "FILLED" && isNum(input.entryPrice)) {
    fillOrReject = `Filled at $${input.entryPrice.toFixed(2)} (conservative ask + slippage, never the mid).`;
  } else if (input.orderState === "REJECTED" || input.orderState === "CANCELLED") {
    fillOrReject = input.revalidationReason ?? "Entry did not fill and was not substituted.";
  } else if (input.orderState === "PENDING") {
    fillOrReject = "Entry order active — waiting for a marketable fill within the entry window.";
  }

  let exit: string | null = null;
  const reason = input.closeReason ?? input.exitReason ?? null;
  if ((input.positionState === "CLOSED" || input.positionState === "EXPIRED") && reason) {
    exit = `Exit: ${reason}${isNum(input.exitPrice) ? ` at $${input.exitPrice.toFixed(2)}` : ""}.`;
  }

  const costBits: string[] = [];
  if (isNum(input.entrySlippage) && input.entrySlippage > 0) costBits.push(`entry slippage $${input.entrySlippage.toFixed(2)}/unit`);
  if (isNum(input.entryFees) && input.entryFees > 0) costBits.push(`entry fees $${input.entryFees.toFixed(2)}`);
  if (isNum(input.exitSlippage) && input.exitSlippage > 0) costBits.push(`exit slippage $${input.exitSlippage.toFixed(2)}/unit`);
  if (isNum(input.exitFees) && input.exitFees > 0) costBits.push(`exit fees $${input.exitFees.toFixed(2)}`);
  const costImpact = costBits.length ? `Cost assumptions applied — ${costBits.join(", ")}.` : null;

  return {
    ticker: input.ticker,
    side: input.side,
    actionabilityStatus: actionabilityFor(input),
    qualified,
    revalidated,
    fillOrReject,
    exit,
    costImpact,
  };
}

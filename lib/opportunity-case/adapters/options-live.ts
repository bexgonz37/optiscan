/**
 * Adapter: independent options LIVE path → Opportunity Case.
 */
import type { OptionsEvalResult } from "../../research/options/loop.ts";
import type { FrozenEntry } from "../../research/options/callout.ts";
import type { DeliveryDecision } from "../../research/options/delivery-decision.ts";
import type { OptionsCandidateInput } from "../../research/options/discovery.ts";
import {
  createEmptyCase,
  deterministicOpportunityId,
  type FrozenTradeValues,
  type HardGateResult,
  type OpportunityCase,
  type SelectedContract,
} from "../schema.ts";
import { buildOpportunityIdentity, opportunityFingerprint } from "../identity.ts";
import { buildOpportunityThesisIdentity, opportunityThesisFingerprint } from "../thesis-identity.ts";
import { setupSentence } from "../../research/options/format.ts";

export interface OptionsLiveAdapterInput {
  input: OptionsCandidateInput;
  evalResult: OptionsEvalResult;
  chainLength: number;
  deliveryDecision?: DeliveryDecision | null;
  alertId?: string | null;
  /** When set, bind this audit row to the living opportunity case id. */
  livingOpportunityCaseId?: string | null;
}

export function adaptOptionsLiveToCase(args: OptionsLiveAdapterInput): OpportunityCase {
  const { input, evalResult, chainLength, deliveryDecision, alertId } = args;
  const sel = evalResult.selection.selected;
  const nowMs = input.nowMs;
  const oc = createEmptyCase(input.symbol, nowMs, "options_live");
  const side = evalResult.contract?.side ?? sel?.side ?? "call";
  const identity = evalResult.contract && sel
    ? buildOpportunityIdentity({
      symbol: input.symbol,
      side,
      expiration: evalResult.contract.expiration,
      strike: evalResult.contract.strike,
      strategyKey: sel.key,
      nowMs,
      direction: evalResult.selection.direction,
    })
    : null;
  const fingerprint = identity ? opportunityFingerprint(identity) : null;
  // Prefer the living case id when an active opportunity already owns this fingerprint.
  // Otherwise keep a stable per-fingerprint pending id (no minute bucket) so repeats upsert.
  oc.opportunityId = args.livingOpportunityCaseId
    ?? (fingerprint
      ? deterministicOpportunityId([fingerprint, "pending"])
      : deterministicOpportunityId([
        input.symbol,
        sel?.key ?? "none",
        evalResult.contract?.optionSymbol ?? "none",
        String(Math.floor(nowMs / 60_000)),
      ]));
  oc.opportunityFingerprint = fingerprint;
  oc.thesisFingerprint = identity
    ? opportunityThesisFingerprint(buildOpportunityThesisIdentity({
      symbol: input.symbol,
      side,
      nowMs,
      direction: evalResult.selection.direction,
      sessionDate: identity.sessionDate,
    }))
    : null;
  oc.sessionDate = identity?.sessionDate ?? null;
  oc.marketSession = input.session;
  oc.direction = evalResult.selection.direction === "bearish" ? "bearish" : evalResult.selection.direction === "bullish" ? "bullish" : "neutral";
  oc.setupFamily = sel?.key ?? null;
  if (sel?.key) oc.originalThesis = [setupSentence(sel.key)];
  oc.underlyingQuote = {
    price: input.underlying.price,
    velPct: input.underlying.velPct,
    relVolume: input.underlying.relVolume,
    quoteTimestampMs: nowMs,
    freshnessState: input.underlying.price != null ? "present" : "missing",
  };
  oc.chainMetadata = {
    fetched: chainLength > 0,
    contractCount: chainLength,
    fetchTimestampMs: nowMs,
    freshnessState: chainLength > 0 ? "present" : "missing",
  };

  if (evalResult.contract) {
    oc.selectedContract = {
      optionSymbol: evalResult.contract.optionSymbol,
      side: evalResult.contract.side,
      strike: evalResult.contract.strike,
      expiration: evalResult.contract.expiration,
      dte: evalResult.contract.dte,
      bid: evalResult.contract.bid,
      ask: evalResult.contract.ask,
      spreadPct: evalResult.contract.spreadPct,
      delta: evalResult.contract.delta,
      openInterest: evalResult.contract.openInterest,
      volume: evalResult.contract.volume,
      selectionReason: "nearest_preferred_delta_in_dte_band",
    };
  }

  if (evalResult.callout?.entry) {
    oc.frozenTrade = frozenFromEntry(evalResult.callout.entry, nowMs);
  }

  const gates: HardGateResult[] = [];
  const putDeliveredByAuthority = evalResult.contract?.side === "put"
    && deliveryDecision?.outcome === "DELIVER_TO_DISCORD"
    && deliveryDecision.deliverySent;
  if (sel?.researchOnly || (evalResult.contract?.side === "put" && !putDeliveredByAuthority)) {
    gates.push({
      gateId: "bearish_authority",
      passed: false,
      reasonCode: deliveryDecision?.reason ?? (sel?.researchOnly ? "research_only" : "bearish_authority_required"),
      explanation: "PUT delivery is controlled by the independent bearish authority; adapter rows are audit-only unless delivery proof exists.",
      finalAuthority: false,
    });
  }
  if (evalResult.state === "REJECTED" || evalResult.callout?.state === "REJECTED") {
    gates.push({
      gateId: "callout_gate",
      passed: false,
      reasonCode: "callout_rejected",
      explanation: evalResult.callout?.reason ?? evalResult.selection.reason,
      finalAuthority: true,
    });
    oc.acceptanceDecision = "rejected";
    oc.rejectionReasonCodes.push("callout_rejected");
  } else if (evalResult.state === "READY") {
    oc.acceptanceDecision = "accepted";
  }

  oc.hardGateResults = gates;
  oc.dataLineage = ["polygon_snapshot", "polygon_bars", "polygon_option_chain"];
  oc.configVersions = { optionsCatalog: "1", callout: "1" };

  if (deliveryDecision) {
    oc.rank = deliveryDecision.rank;
    oc.rankExplanation = deliveryDecision.reason;
    if (deliveryDecision.outcome === "DELIVER_TO_DISCORD" && deliveryDecision.deliverySent) {
      oc.deliveryDecision = "delivered";
    } else if (deliveryDecision.outcome === "RESEARCH_ONLY") {
      oc.deliveryDecision = "research_only";
    } else if (deliveryDecision.outcome === "REJECT") {
      oc.deliveryDecision = "rejected";
      oc.rejectionReasonCodes.push(deliveryDecision.reason);
    } else {
      oc.deliveryDecision = "suppressed";
    }
    oc.deliveryReason = deliveryDecision.finalDeliveryReason ?? deliveryDecision.reason;
    oc.discordDeliveryStatus = deliveryDecision.finalDeliveryOutcome;
  } else if (evalResult.state === "READY") {
    oc.deliveryDecision = "pending";
  }

  if (alertId) oc.alertId = alertId;
  oc.updatedAtMs = nowMs;
  return oc;
}

function frozenFromEntry(entry: FrozenEntry, frozenAtMs: number): FrozenTradeValues {
  return {
    entryMid: entry.mid,
    targetT1: entry.t1,
    targetT2: entry.t2,
    stop: entry.stop,
    bid: entry.bid,
    ask: entry.ask,
    spreadPct: entry.spreadPct,
    methodology: entry.methodology,
    frozenAtMs,
    immutable: true,
  };
}

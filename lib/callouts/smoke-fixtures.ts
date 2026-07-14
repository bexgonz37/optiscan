/**
 * callouts/smoke-fixtures.ts — deterministic TEST/DRY-RUN callout fixtures for the
 * Discord smoke test (live runtime wiring). PURE. These are hand-built fixtures —
 * never real signals — so the smoke test exercises the FORMATTING/ROUTING of every
 * callout kind without any provider call, paper trade, fingerprint, outcome, or
 * model-training side effect. Every payload is unmistakably labeled TEST / DRY RUN.
 */
import { buildCallout, type Callout } from "./callout.ts";
import { formatCalloutDiscord, type DiscordCalloutPayload } from "./discord-format.ts";
import { calloutWebhook, type CalloutWebhook } from "./routing.ts";
import type { AgentResult } from "../agents/types.ts";

export const SMOKE_LABEL = "🧪 TEST / DRY RUN — OptiScan formatting check (not a real signal, no trade)";

function sr(over: Partial<AgentResult> = {}): AgentResult {
  return {
    agentId: "call_0DTE", agentVersion: 1, strategy: "zero_dte_momentum", strategyVersion: 1,
    ticker: "TEST", direction: "bullish", horizon: "0DTE", dteRange: [0, 1],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 77,
    verifiedInputs: {}, requiredConditions: ["hold VWAP"], selectorProfile: "zero_dte_momentum",
    selectedContract: { optionSymbol: "O:TEST_C100", strike: 100, expiration: "2026-07-11", dte: 0, side: "call", bid: 1.0, ask: 1.1, mid: 1.05, spreadPct: 4, delta: 0.5, iv: 0.3, volume: 500, openInterest: 1000, breakevenPct: 0.5 },
    passedGates: ["spread"], failedGates: [], evidenceStatus: "NOT_TRACKED",
    statisticsSnapshot: { evidenceStatus: "NOT_TRACKED", evidenceSummary: "", gradedSampleSize: 0 },
    modelStatus: "INACTIVE_NO_TRAINABLE_DATA", probability: null,
    actionability: "ACTIONABLE", researchOnly: false, reasons: ["fixture — formatting check"],
    improvementConditions: [], invalidationConditions: ["loses VWAP"], freshness: { ok: true, reason: null },
    marketContext: null, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: 0,
    ...over,
  } as AgentResult;
}

/** The scenarios the smoke test renders (one per callout kind). */
export function smokeAgentResults(): { name: string; result: AgentResult }[] {
  return [
    { name: "options_actionable", result: sr() },
    {
      name: "put_research",
      result: sr({
        agentId: "put_research_0DTE", direction: "bearish", candidateStatus: "RESEARCH_ONLY",
        actionability: "RESEARCH_ONLY", researchOnly: true,
        selectedContract: { optionSymbol: "O:TEST_P100", strike: 100, expiration: "2026-07-11", dte: 0, side: "put", bid: 1.0, ask: 1.1, mid: 1.05, spreadPct: 4, delta: -0.45, iv: 0.32, volume: 300, openInterest: 800, breakevenPct: 0.6 },
      }),
    },
    { name: "model_inactive", result: sr({ modelStatus: "INACTIVE_NO_TRAINABLE_DATA", probability: null }) },
    { name: "model_experimental", result: sr({ modelStatus: "ACTIVE_EXPERIMENTAL_RESEARCH_ONLY", probability: 0.61 }) },
    { name: "no_valid_contract", result: sr({ candidateStatus: "NO_VALID_CONTRACT", actionability: "WATCH", selectedContract: null, reasons: ["no contract in the tradability window"] }) },
    { name: "stock_momentum", result: sr({ agentId: "stock", horizon: "STOCK", selectedContract: null, reasons: ["fixture — momentum stock formatting"] }) },
  ];
}

export interface SmokeCallout {
  name: string;
  callout: Callout;
  webhook: CalloutWebhook;
  payload: DiscordCalloutPayload;
}

/** Prefix the payload with the TEST/DRY-RUN label so it can never be mistaken for a live signal. */
function labeled(p: DiscordCalloutPayload): DiscordCalloutPayload {
  const content = `${SMOKE_LABEL}\n${p.content}`;
  // Options are a single content line (no embed); stock cards keep their embed.
  return p.embed ? { content, embed: { ...p.embed, title: `[TEST] ${p.embed.title}` } } : { content };
}

/** Build the labeled, routed, formatted smoke callouts (no side effects). */
export function buildSmokeCallouts(): SmokeCallout[] {
  return smokeAgentResults().map(({ name, result }) => {
    const callout = buildCallout(result);
    return { name, callout, webhook: calloutWebhook(callout), payload: labeled(formatCalloutDiscord(callout)) };
  });
}

/**
 * advisory-chat.ts — the advisory chatbot runtime.
 *
 * SAFETY CONTRACT (enforced here, not merely requested in the prompt):
 *  - The execution path imports NOTHING from the scanner, delivery, Discord,
 *    grading, or paper-trade mutation layers. It reads a canonical findings report
 *    and writes only chat rows. There is no code path from an answer to a trade.
 *  - Every answer passes validateAdvisoryAnswer() before it is shown. A failure
 *    returns AI_UNAVAILABLE_MESSAGE; the deterministic report stays visible.
 *  - There is no APPLY mode. BUILD_FIX_PROMPT produces text for a human to copy.
 *  - The model never sees or emits a secret, and never receives write tooling.
 */
import { aiConfig } from "./config.ts";
import { runStructuredAiJob, type ProviderDeps } from "./provider.ts";
import {
  AI_UNAVAILABLE_MESSAGE,
  buildAdvisoryEvidencePacket,
  validateAdvisoryAnswer,
  CHAT_MODES,
  type ChatMode,
  type EvidencePacket,
  type SupplementalEvidence,
} from "./advisory-chat-evidence.ts";
import type { CanonicalFindingsReport } from "./findings-report.ts";

export const ADVISORY_CHAT_PROMPT_VERSION = "advisory-chat-v1";

/** Default screen prompts. Plain questions an owner would actually ask. */
export const SUGGESTED_PROMPTS: Array<{ prompt: string; mode: ChatMode }> = [
  { prompt: "What should I investigate first?", mode: "INVESTIGATE" },
  { prompt: "Why is OptiScan losing money?", mode: "EXPLAIN" },
  { prompt: "Are entries or exits the bigger problem?", mode: "COMPARE" },
  { prompt: "Which trades gave back profits?", mode: "EXPLAIN" },
  { prompt: "Why are there no Watchlist setups?", mode: "EXPLAIN" },
  { prompt: "What is working?", mode: "EXPLAIN" },
  { prompt: "What data is missing?", mode: "EXPLAIN" },
  { prompt: "Are CALLS or PUTS performing better?", mode: "COMPARE" },
  { prompt: "Explain today's report in plain English.", mode: "EXPLAIN" },
  { prompt: "Build a Claude/Codex investigation prompt.", mode: "BUILD_FIX_PROMPT" },
];

/** Jargon the answer must translate rather than assume. */
export const GLOSSARY: Record<string, string> = {
  MFE: "Maximum favourable excursion — the best unrealised gain a trade reached before it closed.",
  MAE: "Maximum adverse excursion — the worst unrealised loss a trade reached before it closed.",
  "capture efficiency": "Capture efficiency measures how much of a trade's best available gain the exit policy actually kept.",
  expectancy: "Expectancy is the average result per trade, combining how often it wins with how much it wins or loses.",
  "profit factor": "Profit factor is total gains divided by total losses; above 1 means gains outweigh losses.",
  "delta band": "Delta band is the range of option price sensitivity used to pick a strike.",
  T1: "T1 is the first profit target for a trade.",
  T2: "T2 is the second, further profit target.",
  "0DTE": "0DTE means an option expiring the same day.",
  VWAP: "VWAP is the volume-weighted average price for the session — a common reference for whether price is strong or weak.",
};

export interface AdvisoryChatAnswer {
  answer: string;
  mode: ChatMode;
  citedEvidenceIds: string[];
  evidence: EvidencePacket["items"];
  reportId: string;
  model: string | null;
  validationStatus: string;
  validationFailures: unknown[];
  fixPrompt: string | null;
  caveats: string[];
  degraded: boolean;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  safety: {
    aiAuthority: "ADVISORY_ONLY";
    productionBehaviorChanged: false;
  };
}

function systemPrompt(packet: EvidencePacket, mode: ChatMode): string {
  const lines = [
    "You are OptiScan's advisory analyst. You explain a deterministic trading-research report to its owner.",
    "",
    "ABSOLUTE RULES:",
    "1. You may ONLY state numbers that appear in the EVIDENCE list below. Never compute, estimate, average, sum, round differently, or infer a number that is not there. If you want to state a figure you cannot find verbatim in EVIDENCE, describe it in words instead.",
    "2. citedEvidenceIds MUST contain the id of every metric whose number you used. An answer stating a number with an empty citedEvidenceIds is discarded.",
    "3. Never combine metrics from different pipelines or different time windows in ONE sentence. Keep each cohort in its own sentence and name the window when you switch.",
    "3b. Do NOT write numbered lists (\"1.\", \"2.\") — use prose or dashes, so list markers are never mistaken for figures.",
    "4. If a metric has no value, say it is unavailable. NEVER write 0 for missing data, and never treat a missing sample as zero.",
    "5. You have ADVISORY authority only. You have not changed, fixed, applied, or deployed anything. Never claim you did.",
    "6. If asked to change production, explain that a human must review and deploy code, and offer an exportable investigation prompt.",
    "7. Separate what you say into: FACT (directly in evidence), INFERENCE (reasoning from evidence), HYPOTHESIS (unproven), RECOMMENDATION (a next step), DATA QUALITY WARNING (evidence is weak or missing).",
    "8. Write plain English for a non-quant reader. If you use a technical term, define it in one short clause.",
    "",
    "MANDATORY CAVEATS — restate any that are relevant, and never contradict them:",
    ...packet.mandatoryCaveats.map((c) => `- ${c}`),
    "",
    `MODE: ${mode}`,
    mode === "EXPLAIN" ? "Explain what the evidence means in plain language."
      : mode === "INVESTIGATE" ? "Rank what to investigate first and say what evidence would resolve each item."
        : mode === "COMPARE" ? "Compare the named things using ONLY metrics from the same pipeline and window. If a valid comparison is impossible, say so."
          : "Produce an investigation prompt a human can paste into Claude or Codex. It must instruct the recipient NOT to apply live changes automatically.",
    "",
    "EVIDENCE (the only permitted source of numbers):",
    ...packet.items.map((i) => {
      const value = i.value == null ? "UNAVAILABLE" : `${i.value}${i.unit ? ` ${i.unit}` : ""}`;
      return `- id=${i.id} | ${i.label} = ${value} | pipeline=${i.pipeline} | lane=${i.lane} | window=${i.timeWindow} | sample=${i.sampleSize ?? "unknown"} | confidence=${i.confidence} | quality=${i.qualityStatus} | source=${i.sourceRef} | meaning=${i.meaning}`;
    }),
    "",
    packet.dataGaps.length ? `KNOWN DATA GAPS: ${packet.dataGaps.join(" | ")}` : "KNOWN DATA GAPS: none recorded",
    "",
    "Respond with the advisory_answer tool only.",
  ];
  return lines.join("\n");
}

const ANSWER_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    answer: { type: "string", description: "Plain-English answer, max ~350 words." },
    citedEvidenceIds: {
      type: "array", items: { type: "string" },
      description: "Evidence ids supporting every number stated in answer.",
    },
    classifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["FACT", "INFERENCE", "HYPOTHESIS", "RECOMMENDATION", "DATA_QUALITY_WARNING"] },
          statement: { type: "string" },
        },
        required: ["kind", "statement"],
      },
    },
    fixPrompt: {
      type: "string",
      description: "Only for BUILD_FIX_PROMPT mode: an export-only investigation prompt. Empty otherwise.",
    },
  },
  required: ["answer", "citedEvidenceIds"],
};

interface RawAnswer {
  answer: string;
  citedEvidenceIds: string[];
  classifications?: Array<{ kind: string; statement: string }>;
  fixPrompt?: string;
}

function validateShape(json: unknown): RawAnswer {
  const o = json as any;
  if (!o || typeof o !== "object") throw new Error("answer is not an object");
  if (typeof o.answer !== "string" || !o.answer.trim()) throw new Error("answer missing");
  const ids = Array.isArray(o.citedEvidenceIds) ? o.citedEvidenceIds.filter((x: unknown) => typeof x === "string") : [];
  return {
    answer: o.answer,
    citedEvidenceIds: ids,
    classifications: Array.isArray(o.classifications) ? o.classifications : [],
    fixPrompt: typeof o.fixPrompt === "string" ? o.fixPrompt : "",
  };
}

/**
 * Deterministic investigation prompt. Generated in code (not by the model) so its
 * safety constraints cannot be softened by generation, and it is EXPORT-ONLY.
 */
export function buildFixPrompt(input: {
  question: string;
  packet: EvidencePacket;
  citedEvidenceIds: string[];
  finding?: string | null;
}): string {
  const cited = input.packet.items.filter((i) => input.citedEvidenceIds.includes(i.id));
  const evidence = (cited.length ? cited : input.packet.items.slice(0, 8)).map((i) => {
    const value = i.value == null ? "UNAVAILABLE" : `${i.value}${i.unit ? ` ${i.unit}` : ""}`;
    return `- ${i.label} = ${value} (id=${i.id}, pipeline=${i.pipeline}, lane=${i.lane}, window=${i.timeWindow}, sample=${i.sampleSize ?? "unknown"}, confidence=${i.confidence}, quality=${i.qualityStatus}, source=${i.sourceRef})`;
  });
  return [
    "# OptiScan investigation request",
    "",
    `## Question\n${input.question}`,
    "",
    `## Finding\n${input.finding?.trim() || "See the evidence below; the finding is what the evidence supports."}`,
    "",
    "## Evidence (canonical, from the deterministic findings report)",
    ...evidence,
    "",
    `## Report\nreportId=${input.packet.reportId} · tradingDay=${input.packet.tradingDay ?? "unknown"} · activePipeline=${input.packet.activeProductionPipeline}`,
    "",
    "## Where to look",
    "- lib/research/options/ — options discovery, delivery, grading, exit research",
    "- lib/research/overnight/next-session-plan.ts — Watchlist evidence gate",
    "- lib/research/watchlist/ — VWAP evidence and market context",
    "- lib/ai/findings-report.ts — canonical metric definitions",
    "- tests/ — add or extend focused tests beside the code you touch",
    "",
    "## Safety constraints (non-negotiable)",
    "- Do NOT change scanner formulas, scoring weights, thresholds, targets, stops, or subscriber strategy rules.",
    "- Do NOT apply live changes automatically. Propose a diff and let a human review and deploy it.",
    "- Do NOT enable real-money or live execution, and do NOT relax any evidence or eligibility gate.",
    "- Do NOT send Discord messages, trigger scans, or modify Railway variables.",
    "- Treat all AI output as advisory; production behaviour changes only through reviewed, deployed code.",
    "",
    "## Required verification",
    "- npm test (full suite must stay green)",
    "- npx tsc --noEmit --incremental false",
    "- npm run build",
    "- Add focused tests proving the specific behaviour you changed.",
    "",
    ...input.packet.mandatoryCaveats.map((c) => `> ${c}`),
  ].join("\n");
}

export interface AdvisoryChatDeps extends ProviderDeps {
  now?: () => number;
}

/**
 * Answer one question. Never throws: a provider, validation, or evidence failure
 * degrades to AI_UNAVAILABLE_MESSAGE so the deterministic report remains usable.
 */
export async function answerAdvisoryChat(input: {
  question: string;
  mode?: ChatMode;
  report: CanonicalFindingsReport;
  supplemental?: SupplementalEvidence;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  deps?: AdvisoryChatDeps;
}): Promise<AdvisoryChatAnswer> {
  const deps = input.deps ?? {};
  const env = deps.env ?? process.env;
  const cfg = aiConfig(env);
  const mode: ChatMode = CHAT_MODES.includes(input.mode as ChatMode) ? (input.mode as ChatMode) : "EXPLAIN";
  const packet = buildAdvisoryEvidencePacket(input.report, input.supplemental);

  const base = {
    mode,
    evidence: packet.items,
    reportId: packet.reportId,
    caveats: packet.mandatoryCaveats,
    safety: { aiAuthority: "ADVISORY_ONLY" as const, productionBehaviorChanged: false as const },
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
  };

  const degraded = (status: string, failures: unknown[] = []): AdvisoryChatAnswer => ({
    ...base,
    answer: AI_UNAVAILABLE_MESSAGE,
    citedEvidenceIds: [],
    model: null,
    validationStatus: status,
    validationFailures: failures,
    // A fix prompt is deterministic, so it is still available when the model is not.
    fixPrompt: mode === "BUILD_FIX_PROMPT"
      ? buildFixPrompt({ question: input.question, packet, citedEvidenceIds: [] })
      : null,
    degraded: true,
  });

  if (!cfg.enabled) return degraded("AI_DISABLED");
  if (packet.items.length === 0) return degraded("NO_EVIDENCE_AVAILABLE");

  const historyText = (input.history ?? []).slice(-6)
    .map((h) => `${h.role === "user" ? "Owner" : "Analyst"}: ${h.content}`).join("\n");

  let result;
  try {
    result = await runStructuredAiJob<RawAnswer>(
      {
        model: cfg.weeklyModel,
        system: systemPrompt(packet, mode),
        user: [
          historyText ? `Earlier in this conversation:\n${historyText}\n` : "",
          `Owner's question: ${input.question}`,
        ].filter(Boolean).join("\n"),
        maxOutputTokens: Math.min(cfg.maxOutputTokensPerJob, 2_000),
        timeoutMs: cfg.jobTimeoutMs,
        maxRetries: Math.min(cfg.maxRetries, 1),
        toolName: "advisory_answer",
        toolInputSchema: ANSWER_TOOL_SCHEMA,
        validatorName: "advisoryChatAnswer",
        promptVersion: ADVISORY_CHAT_PROMPT_VERSION,
      },
      validateShape,
      deps,
    );
  } catch {
    return degraded("PROVIDER_ERROR");
  }

  if (!result.ok || !result.data) {
    return { ...degraded(result.errorCategory === "timeout" ? "AI_TIMEOUT" : "PROVIDER_ERROR") };
  }

  const validation = validateAdvisoryAnswer({
    answer: result.data.answer,
    citedEvidenceIds: result.data.citedEvidenceIds,
    packet,
    supplemental: input.supplemental,
  });

  if (!validation.ok) {
    return {
      ...degraded("REJECTED_VALIDATION", validation.failures),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
    };
  }

  return {
    ...base,
    answer: result.data.answer,
    citedEvidenceIds: result.data.citedEvidenceIds,
    model: cfg.weeklyModel,
    validationStatus: "VALID",
    validationFailures: [],
    fixPrompt: mode === "BUILD_FIX_PROMPT"
      ? buildFixPrompt({
        question: input.question,
        packet,
        citedEvidenceIds: result.data.citedEvidenceIds,
        finding: result.data.answer.split(/(?<=[.!?])\s/)[0] ?? null,
      })
      : null,
    degraded: false,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
  };
}

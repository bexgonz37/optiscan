/**
 * lib/ai/research-analyzer.ts — the AI analysis step for the options Research Queue. Called ONLY by
 * the queue worker (never by the live alert path). Budget-gated through the existing cost gate; every
 * call is recorded in ai_job_runs with estimated cost so the monthly limits stay authoritative.
 * Degrades cleanly: AI disabled → skipped (task stays visible, no fabricated analysis); provider or
 * validation failure → error surfaced for the queue's bounded retry.
 */
import { aiConfig } from "./config.ts";
import { runStructuredAiJob } from "./provider.ts";
import { costGateOnDb, recordAiJobRunOnDb, type DbLike } from "./store.ts";
import { estimateCostUsd } from "./pricing.ts";

export interface ResearchTaskLike { id: number; kind: string; refId: string; payloadJson: string | null; attempts: number }
export interface ResearchAnalysis {
  qualityScore: number;              // 0..10
  strongestFactors: string[];
  biggestRisk: string;
  likelyFailureMode: string;
  earliness: "early" | "during" | "late" | "unknown";
  recommendation: string;            // one evidence-based sentence
}

function validateAnalysis(json: unknown): ResearchAnalysis {
  const o = json as any;
  if (!o || typeof o !== "object") throw new Error("not an object");
  const num = Number(o.qualityScore);
  if (!Number.isFinite(num) || num < 0 || num > 10) throw new Error("qualityScore must be 0..10");
  if (!Array.isArray(o.strongestFactors)) throw new Error("strongestFactors must be an array");
  for (const k of ["biggestRisk", "likelyFailureMode", "recommendation"]) if (typeof o[k] !== "string" || !o[k]) throw new Error(`${k} must be a non-empty string`);
  const earliness = ["early", "during", "late", "unknown"].includes(o.earliness) ? o.earliness : "unknown";
  return { qualityScore: num, strongestFactors: o.strongestFactors.map((x: unknown) => String(x)).slice(0, 5), biggestRisk: o.biggestRisk, likelyFailureMode: o.likelyFailureMode, earliness, recommendation: o.recommendation };
}

const KIND_INSTRUCTIONS: Record<string, string> = {
  delivered_trade_analysis: "This is a CLOSED paper trade that mirrored a delivered subscriber alert. Assess entry quality, exit quality, and what would have improved expectancy.",
  experiment_vs_mirror: "This is a closed RESEARCH experiment compared against the closest delivered mirror trade. Assess whether the experimental variation improved or hurt the outcome, and why.",
  missed_opportunity: "This alert was rejected as TOO_LATE. Assess whether earlier detection was realistically possible and what signal would have caught it sooner.",
  strategy_recommendation: "Synthesize the completed analyses count given into ONE evidence-based recommendation for the strategy catalog. Be conservative; do not overfit.",
  research_experiment: "This is a closed research-only paper trade. Briefly assess the setup and outcome for the learning corpus.",
};

/** Analyze one queued task. Returns {ok} with a validated structured result, {skipped} when AI is off
 *  or the budget is exhausted, or {ok:false,error} for the queue's bounded retry. Never throws. */
export async function analyzeResearchTask(db: DbLike, task: ResearchTaskLike, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; result?: ResearchAnalysis; skipped?: boolean; error?: string }> {
  try {
    const cfg = aiConfig(env);
    if (!cfg.enabled) return { ok: false, skipped: true, error: "ai_disabled" };
    const gate = costGateOnDb(db, cfg);
    if (!gate.allowed) return { ok: false, skipped: true, error: "monthly_hard_limit" };

    const payload = task.payloadJson ? task.payloadJson.slice(0, 6_000) : "{}";
    const call = await runStructuredAiJob<ResearchAnalysis>({
      model: cfg.nightlyModel,                         // lower-cost model — this is bulk research, not narration
      system: "You are a quantitative options-trading research analyst. Respond with STRICT JSON only: {\"qualityScore\":0-10,\"strongestFactors\":[..],\"biggestRisk\":\"..\",\"likelyFailureMode\":\"..\",\"earliness\":\"early|during|late|unknown\",\"recommendation\":\"..\"}. Base every statement only on the data given; never invent prices or outcomes.",
      user: `${KIND_INSTRUCTIONS[task.kind] ?? KIND_INSTRUCTIONS.research_experiment}\n\nDATA:\n${payload}`,
      maxOutputTokens: Math.min(cfg.maxOutputTokensPerJob, 700),
      timeoutMs: cfg.jobTimeoutMs,
      maxRetries: 1,
      validatorName: "research_analysis_v1",
      promptVersion: "rq1",
    }, validateAnalysis, { env });

    const costUsd = estimateCostUsd(cfg.nightlyModel, call.inputTokens, call.outputTokens);
    try {
      recordAiJobRunOnDb(db, {
        jobType: `research_queue:${task.kind}`, model: cfg.nightlyModel,
        status: call.ok ? "OK" : `ERROR_${call.errorCategory.toUpperCase()}`,
        errorCategory: call.ok ? null : call.errorCategory, error: call.ok ? null : call.error,
        inputTokens: call.inputTokens, outputTokens: call.outputTokens, estimatedCostUsd: costUsd,
        latencyMs: call.latencyMs, retryCount: call.retries,
      });
    } catch { /* accounting is best-effort; the queue result stands on its own */ }

    if (!call.ok || !call.data) return { ok: false, error: call.error ?? `ai_${call.errorCategory}` };
    return { ok: true, result: call.data };
  } catch (e: any) { return { ok: false, error: String(e?.message ?? e).slice(0, 200) }; }
}

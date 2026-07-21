/**
 * lib/ai/shadow.ts — AI_SHADOW_ONLY enrichment (advisory, for shadow COMPARISON only). Lives in
 * lib/ai/ (the only place model references are allowed). The model may explain/classify/summarize;
 * it may NOT create/alter alerts, change gates/thresholds/rankings/contracts, override
 * bearish-gate.ts, make puts actionable, invent data, or retrain. Flag: AI_SHADOW_ENABLED (OFF).
 *
 * The output is schema-validated AND deterministically post-validated (anti-hallucination): any
 * ticker/price/earnings-date/contract not present in the input, or an "institutional flow" claim
 * without authoritative provenance, fails validation and is recorded as a hallucination.
 */
import { researchFlags } from "../research/flags.ts";
import { shadowQueue, shadowKey } from "../research/shadow/queue.ts";

export interface AiShadowInput {
  symbol: string;
  underlying: { price: number | null; dollarVolume: number | null };
  triggerFeatures: Record<string, number>;
  earnings: { hoursUntil: number | null; session: string; timingConfirmed: boolean; provenance: string } | null;
  optionsActivity: { direction: string | null; flowClassification: string; volVsBaseline: number | null; hasProvenance: boolean } | null;
  technicalState: Record<string, number> | null;
  marketContext: Record<string, unknown> | null;
  analog: { comparableCount: number; confidence: number; dispersion: number; contradiction: number; abstain: boolean; abstainReason: string | null } | null;
  missing: string[];
  scannerDecision: { actionable: boolean; direction: "bullish" | "bearish" };
  paperHistory: { trades: number; winRate: number | null } | null;
}

export type AiClassification = "CONFIRM" | "CANCEL" | "ABSTAIN";
export interface AiShadowOutput {
  catalystClass: string;
  setupSummary: string;
  evidenceFor: string[];
  evidenceAgainst: string[];
  contradictions: string[];
  riskSummary: string;
  confidenceExplanation: string;
  missingEvidence: string[];
  classification: AiClassification;
}

const CLASSES = new Set<AiClassification>(["CONFIRM", "CANCEL", "ABSTAIN"]);

/** Pure schema validation — a response is trusted ONLY if it has exactly the allowed shape. */
export function validateAiShadowOutput(json: unknown): { ok: boolean; value: AiShadowOutput | null; error: string | null } {
  if (!json || typeof json !== "object") return { ok: false, value: null, error: "not an object" };
  const o = json as any;
  const strFields = ["catalystClass", "setupSummary", "riskSummary", "confidenceExplanation"];
  for (const k of strFields) if (typeof o[k] !== "string") return { ok: false, value: null, error: `missing/invalid ${k}` };
  const arrFields = ["evidenceFor", "evidenceAgainst", "contradictions", "missingEvidence"];
  for (const k of arrFields) if (!Array.isArray(o[k]) || o[k].some((x: unknown) => typeof x !== "string")) return { ok: false, value: null, error: `invalid ${k}` };
  if (!CLASSES.has(o.classification)) return { ok: false, value: null, error: "invalid classification" };
  return { ok: true, value: { catalystClass: o.catalystClass, setupSummary: o.setupSummary, evidenceFor: o.evidenceFor, evidenceAgainst: o.evidenceAgainst, contradictions: o.contradictions, riskSummary: o.riskSummary, confidenceExplanation: o.confidenceExplanation, missingEvidence: o.missingEvidence, classification: o.classification }, error: null };
}

/** Deterministic anti-hallucination guard against the input. Returns violations (empty = clean). */
export function postValidateAiShadowOutput(input: AiShadowInput, out: AiShadowOutput): string[] {
  const v: string[] = [];
  const text = [out.setupSummary, out.catalystClass, out.riskSummary, out.confidenceExplanation, ...out.evidenceFor, ...out.evidenceAgainst, ...out.contradictions].join(" ");
  // any OTHER uppercase ticker-like token that isn't the input symbol is a fabrication risk
  const tickers = (text.match(/\b[A-Z]{2,5}\b/g) ?? []).filter((t) => !["CONFIRM", "CANCEL", "ABSTAIN", "IV", "OI", "DTE", "BMO", "AMC", "AI", "US", "EPS", "PM", "AH"].includes(t));
  for (const t of tickers) if (t !== input.symbol.toUpperCase()) v.push(`references foreign ticker ${t}`);
  // institutional/sweep flow claims require authoritative provenance
  if (/\b(institutional|sweep|smart money|block trade|whale)\b/i.test(text) && !(input.optionsActivity?.hasProvenance && input.optionsActivity.flowClassification !== "unclassified_no_trade_data")) {
    v.push("claims institutional/sweep flow without authoritative provenance");
  }
  // a CONFIRM that contradicts the (research-only) put/bearish safety is not allowed to be trusted
  if (out.classification === "CONFIRM" && input.scannerDecision.direction === "bearish") v.push("CONFIRM on a bearish idea (research-only) — shadow comparison only");
  return v;
}

export interface AiShadowMetrics { submitted: number; processed: number; abstained: number; schemaFailures: number; hallucinations: number; errors: number; timeouts: number; totalTokens: number; totalCostUsd: number }
type G = typeof globalThis & { __optiscanAiShadowMetrics?: AiShadowMetrics };
export function aiShadowMetrics(): AiShadowMetrics { const g = globalThis as G; return (g.__optiscanAiShadowMetrics ??= { submitted: 0, processed: 0, abstained: 0, schemaFailures: 0, hallucinations: 0, errors: 0, timeouts: 0, totalTokens: 0, totalCostUsd: 0 }); }

export interface ModelResult { json: unknown; inputTokens: number; outputTokens: number; costUsd: number }
export interface AiShadowDeps { getDb?: () => any; callModel?: (input: AiShadowInput) => Promise<ModelResult> }

const liveDb = () => require("@/lib/db").getDb(); // eslint-disable-line @typescript-eslint/no-require-imports

/**
 * Fire-and-forget AI shadow enrichment. HARD no-op unless AI_SHADOW_ENABLED=1 AND a model caller is
 * supplied (no accidental spend). Runs on the bounded shadow queue; validates + post-validates;
 * records to ai_shadow with metrics. NEVER affects any actionable decision.
 */
export function enqueueAiShadow(input: AiShadowInput, nowMs: number = Date.now(), deps: AiShadowDeps = {}, env: NodeJS.ProcessEnv = process.env): { enqueued: boolean; reason: string | null } {
  if (!researchFlags(env).aiShadow) return { enqueued: false, reason: "AI_SHADOW_ENABLED!=1" };
  if (!deps.callModel) return { enqueued: false, reason: "no model caller supplied (safe fallback: disabled)" };
  const m = aiShadowMetrics();
  const getDb = deps.getDb ?? liveDb;
  const ok = shadowQueue().submit(shadowKey(input.symbol, "ai", "shadow", nowMs), async () => {
    m.submitted += 1;
    let out: AiShadowOutput | null = null, schemaOk = false, halluc = false, cls = "ABSTAIN", error: string | null = null;
    let inTok = 0, outTok = 0, cost = 0;
    try {
      const res = await deps.callModel!(input);
      inTok = res.inputTokens; outTok = res.outputTokens; cost = res.costUsd; m.totalTokens += inTok + outTok; m.totalCostUsd += cost;
      const val = validateAiShadowOutput(res.json);
      if (!val.ok || !val.value) { m.schemaFailures += 1; error = val.error; }
      else {
        schemaOk = true; out = val.value;
        const violations = postValidateAiShadowOutput(input, out);
        if (violations.length) { halluc = true; m.hallucinations += 1; error = violations.join("; "); cls = "ABSTAIN"; }
        else { cls = out.classification; }
      }
      if (cls === "ABSTAIN") m.abstained += 1;
      m.processed += 1;
    } catch (e: any) { m.errors += 1; error = String(e?.message ?? e).slice(0, 160); }

    const agreeScanner = out ? (cls === "CONFIRM") === input.scannerDecision.actionable : null;
    const agreeAnalog = out && input.analog && !input.analog.abstain ? (cls === "CONFIRM") === (input.analog.confidence >= 0.5) : null;
    try {
      getDb().prepare(
        `INSERT INTO ai_shadow (symbol, tag, classification, catalyst_class, agrees_with_scanner, agrees_with_analog, abstained, schema_ok, hallucination, latency_ms, input_tokens, output_tokens, cost_usd, error, output_json, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(input.symbol.toUpperCase(), "AI_SHADOW_ONLY", cls, out?.catalystClass ?? null, agreeScanner == null ? null : agreeScanner ? 1 : 0, agreeAnalog == null ? null : agreeAnalog ? 1 : 0, cls === "ABSTAIN" ? 1 : 0, schemaOk ? 1 : 0, halluc ? 1 : 0, 0, inTok, outTok, cost, error, out ? JSON.stringify(out) : null, nowMs);
    } catch { /* shadow persist failure is isolated */ }
  });
  return { enqueued: ok, reason: ok ? null : "queue dedup/full" };
}

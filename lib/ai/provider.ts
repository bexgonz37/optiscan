/**
 * ai/provider.ts - the ONE Anthropic provider abstraction for the advisory AI
 * layer. Single-shot, structured-JSON calls only.
 *
 * Guarantees:
 *  - The API key is read ONLY from ANTHROPIC_API_KEY and never logged or returned.
 *  - Every call has a hard timeout and bounded retries.
 *  - JSON is parsed and validated before it is trusted.
 *  - Failures return structured diagnostics and never throw to scanner/runtime code.
 */

import { aiConfig } from "./config.ts";
import { maxJobCostUsd, estimateCostUsd } from "./pricing.ts";
import {
  BUDGET_EXHAUSTED,
  combinedCostGateOnDb,
  type CombinedBudgetGate,
} from "./monthly-budget.ts";
import { recordAiJobRunOnDb, type DbLike as BudgetDbLike } from "./store.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export type AiErrorCategory =
  | "none" | "disabled" | "timeout" | "http" | "network" | "validation" | "parse"
  /** The combined monthly AI budget refused the call. No provider request was made. */
  | "budget_exhausted";

export interface AiCallInput {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
  maxRetries: number;
  /** Optional Anthropic tool schema. When present, the model is forced to emit this tool input. */
  toolName?: string;
  toolInputSchema?: Record<string, unknown>;
  validatorName?: string;
  promptVersion?: string;
  /**
   * Ledger label for this call, e.g. "advisory_chat". Recorded on the BUDGET_EXHAUSTED row
   * and, when `meter` is set, on the spend row. Callers that record their own run row pass
   * the same jobType they use there so one job never appears under two names.
   */
  jobType?: string;
  /**
   * Whether THIS module records the call's cost in `ai_job_runs`.
   *
   * Set it on call sites that do not record their own run row (Ask OptiScan, the social
   * recap rewriter). Leave it off where the caller already writes one — nightly, weekly and
   * the research analyses do, and recording here as well would bill the month twice for a
   * single call, which is a worse defect than the one this closes.
   */
  meter?: boolean;
}

export interface AiParserOutput {
  type: string;
  keys: string[];
  preview: string;
}

export interface AiSchemaViolation {
  stage: string;
  validatorName: string | null;
  failingField: string | null;
  expectedValue: string | null;
  receivedValue: unknown;
  message: string;
  token?: string;
  semanticType?: string;
  context?: string;
  normalizedValue?: unknown;
  closestAllowedEvidence?: unknown[];
  sourceFieldExpected?: string | null;
}

export interface AiProviderDiagnostics {
  httpStatus: number | null;
  responseType: string | null;
  contentTypes: string[];
  markdownFenceStripped: boolean;
  extractedJson: boolean;
  validationErrors: string[];
  validationStage: string | null;
  validatorName: string | null;
  failingField: string | null;
  expectedValue: string | null;
  receivedValue: unknown;
  aiResponseLength: number | null;
  parserOutput: AiParserOutput | null;
  schemaViolations: AiSchemaViolation[];
  retryCount: number;
  providerModel: string | null;
  promptVersion: string | null;
  parseError: string | null;
  stoppedEarly: boolean;
  attempts: number;
  /**
   * Whether the combined monthly budget was actually consulted for this call.
   * "ENFORCED" is the only value production may report; the others say WHY not, so a
   * silently unmetered path shows up in a diagnostic instead of on an invoice.
   */
  budgetState: BudgetEnforcementState;
  /** Combined month-to-date spend the gate saw, when it ran. */
  budgetSpendUsd: number | null;
}

/**
 * ENFORCED             the gate ran against a real ledger
 * NOT_ENFORCED_NO_DB   no database was resolvable (unit-test path; blocked in production)
 * BYPASSED_BY_CALLER   a test injected a null budget check on purpose
 */
export type BudgetEnforcementState = "ENFORCED" | "NOT_ENFORCED_NO_DB" | "BYPASSED_BY_CALLER";

export interface AiCallResult<T = unknown> {
  ok: boolean;
  /** Parsed + validated structured payload (only when ok). */
  data: T | null;
  /** Raw assistant text (for debugging/audit; may be truncated by caller). */
  text: string | null;
  inputTokens: number;
  outputTokens: number;
  retries: number;
  latencyMs: number;
  errorCategory: AiErrorCategory;
  error: string | null;
  diagnostics: AiProviderDiagnostics;
}

export interface ProviderDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /**
   * Database handle for the budget gate and the spend ledger. Omitted in production, where
   * it is resolved lazily from `@/lib/db`; injected by tests that exercise the gate.
   */
  db?: BudgetDbLike;
  /**
   * Test seam. `null` disables enforcement explicitly and is recorded as BYPASSED_BY_CALLER
   * — an opt-out that leaves a trace, rather than one that looks like enforcement.
   */
  budgetGate?: ((reserveUsd: number) => CombinedBudgetGate) | null;
}

function emptyDiagnostics(): AiProviderDiagnostics {
  return {
    httpStatus: null,
    responseType: null,
    contentTypes: [],
    markdownFenceStripped: false,
    extractedJson: false,
    validationErrors: [],
    validationStage: null,
    validatorName: null,
    failingField: null,
    expectedValue: null,
    receivedValue: null,
    aiResponseLength: null,
    parserOutput: null,
    schemaViolations: [],
    retryCount: 0,
    providerModel: null,
    promptVersion: null,
    parseError: null,
    stoppedEarly: false,
    attempts: 0,
    budgetState: "NOT_ENFORCED_NO_DB",
    budgetSpendUsd: null,
  };
}

function safePreview(value: unknown, max = 1200): string {
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
}

function valueAtPath(value: unknown, field: string | null): unknown {
  if (!field) return null;
  if (field === "root") return summarizeReceived(value);
  const parts = field.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: any = value;
  for (const part of parts) {
    if (cur == null) return null;
    cur = cur[part];
  }
  return summarizeReceived(cur);
}

function summarizeReceived(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return { type: "array", length: value.length, preview: safePreview(value, 300) };
  if (typeof value === "object") return { type: "object", keys: Object.keys(value as Record<string, unknown>).slice(0, 20), preview: safePreview(value, 300) };
  if (typeof value === "string") return value.slice(0, 300);
  return value;
}

function parserOutput(json: unknown): AiParserOutput {
  return {
    type: Array.isArray(json) ? "array" : json == null ? "null" : typeof json,
    keys: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json as Record<string, unknown>).slice(0, 30) : [],
    preview: safePreview(json),
  };
}

function validationDetailFromError(err: unknown): any {
  return err && typeof err === "object" ? (err as any).validationDetail : null;
}

function fieldFromValidationMessage(message: string, detail?: any): string | null {
  if (detail?.claim) return "antiFabricationNumbers";
  const proposal = /proposal\[(\d+)\]\.field '([^']+)'/i.exec(message);
  if (proposal) return `proposals[${proposal[1]}].${proposal[2]}`;
  const field = /field '([^']+)'/i.exec(message);
  if (field) return field[1];
  const proposalObject = /proposal\[(\d+)\] must be an object/i.exec(message);
  if (proposalObject) return `proposals[${proposalObject[1]}]`;
  if (/weekly proposals must be an array/i.test(message)) return "root";
  if (/narrative contains a number|unsupported quantitative claim/i.test(message)) return "antiFabricationNumbers";
  return null;
}

function expectedFromValidationMessage(message: string, detail?: any): string | null {
  if (detail?.claim?.semanticType) return `matching deterministic evidence for ${detail.claim.semanticType}`;
  if (/must be a non-empty string/i.test(message)) return "non-empty string";
  if (/must be an array/i.test(message)) return "array";
  if (/must be an object/i.test(message)) return "object";
  if (/weekly proposals must be an array/i.test(message)) return "array or object with proposals array";
  if (/narrative contains a number|unsupported quantitative claim/i.test(message)) return "every quantitative claim must match deterministic evidence of the same semantic type";
  return null;
}

function receivedFromValidationMessage(message: string, json: unknown, field: string | null, detail?: any): unknown {
  if (detail?.claim) return {
    token: detail.claim.token,
    semanticType: detail.claim.semanticType,
    normalizedValue: detail.claim.normalizedValue,
    context: detail.claim.context,
  };
  const fabricated = /number not present in the deterministic summary: ([^ ]+)/i.exec(message);
  if (fabricated) return fabricated[1];
  return valueAtPath(json, field);
}

function validationViolation(input: AiCallInput, json: unknown, message: string, err?: unknown): AiSchemaViolation {
  const detail = validationDetailFromError(err);
  const field = fieldFromValidationMessage(message, detail);
  const stage = detail?.claim || /narrative contains a number|unsupported quantitative claim/i.test(message) ? "anti_fabrication" : "schema";
  const claim = detail?.claim;
  return {
    stage,
    validatorName: input.validatorName ?? null,
    failingField: field,
    expectedValue: expectedFromValidationMessage(message, detail),
    receivedValue: receivedFromValidationMessage(message, json, field, detail),
    message: message.slice(0, 500),
    ...(claim ? {
      token: claim.token,
      semanticType: claim.semanticType,
      context: claim.context,
      normalizedValue: claim.normalizedValue,
      closestAllowedEvidence: claim.closestAllowedEvidence,
      sourceFieldExpected: claim.sourceFieldExpected,
    } : {}),
  };
}

export function extractJsonWithMeta(text: string): { json: unknown; markdownFenceStripped: boolean; extractedJson: boolean } {
  if (!text) throw new Error("empty response");
  let t = String(text).trim();
  let markdownFenceStripped = false;
  let extractedJson = false;

  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) {
    t = fence[1].trim();
    markdownFenceStripped = true;
  }

  if (!(t.startsWith("{") || t.startsWith("["))) {
    const first = t.search(/[[{]/);
    const lastObj = t.lastIndexOf("}");
    const lastArr = t.lastIndexOf("]");
    const last = Math.max(lastObj, lastArr);
    if (first >= 0 && last > first) {
      t = t.slice(first, last + 1);
      extractedJson = true;
    }
  }

  return { json: JSON.parse(t), markdownFenceStripped, extractedJson };
}

/** Strip markdown fences and pull the first JSON object/array out of model text. */
export function extractJson(text: string): unknown {
  return extractJsonWithMeta(text).json;
}

/** Appended to the system prompt on the paid validation retry (attempt > 0). */
const STRUCTURED_RETRY_INSTRUCTION =
  " CRITICAL RETRY: your previous reply contained no usable structured payload."
  + " Respond ONLY with the required structured JSON (call the provided tool when one is defined)."
  + " Do not emit reasoning, prose, markdown, or an empty object."
  + " If the evidence is insufficient, return the minimal valid payload (for example an empty list field) instead of nothing.";

async function callOnce(
  input: AiCallInput,
  apiKey: string,
  fetchImpl: typeof fetch,
  attempt: number,
): Promise<{ text: string; inputTokens: number; outputTokens: number; httpStatus: number; responseType: string; contentTypes: string[] }> {
  const body: any = {
    model: input.model,
    max_tokens: input.maxOutputTokens,
    system: attempt > 0 ? input.system + STRUCTURED_RETRY_INSTRUCTION : input.system,
    messages: [{ role: "user", content: input.user }],
  };
  if (input.toolName && input.toolInputSchema) {
    body.tools = [{
      name: input.toolName,
      description: "Return the required structured JSON payload for OptiScan. If evidence is insufficient, call this tool with an empty list field rather than omitting the call.",
      input_schema: input.toolInputSchema,
    }];
    // Force the structured tool. Do NOT send thinking:{type:"disabled"} — some
    // Anthropic models reject that field with HTTP 400. Forced tool_choice plus
    // the validation retry (structured-output instruction) is the safe path.
    body.tool_choice = { type: "tool", name: input.toolName };
  }
  // On the paid validation retry after a thinking-only / empty miss, give the
  // model a little more room so a prior reasoning burn cannot starve the payload.
  if (attempt > 0) {
    body.max_tokens = Math.min(Math.max(input.maxOutputTokens, 1024) * 2, 16_000);
  }

  let res: Response;
  try {
    res = await fetchImpl(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (err: any) {
    const isAbort = err?.name === "AbortError" || err?.name === "TimeoutError";
    const e = new Error(isAbort ? "request timed out" : `network error: ${err?.message ?? err}`);
    (e as any).category = isAbort ? "timeout" : "network";
    (e as any).httpStatus = null;
    throw e;
  }

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    const e = new Error(`anthropic ${res.status}: ${raw.slice(0, 200)}`);
    (e as any).category = "http";
    (e as any).status = res.status;
    (e as any).httpStatus = res.status;
    throw e;
  }

  let parsed: any;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    const e = new Error("provider returned non-JSON body");
    (e as any).category = "parse";
    (e as any).httpStatus = res.status;
    throw e;
  }

  const blocks = Array.isArray(parsed?.content) ? parsed.content : [];
  const contentTypes = blocks.map((b: any) => String(b?.type ?? "unknown"));
  const tool = blocks.find((b: any) => b?.type === "tool_use" && (!input.toolName || b?.name === input.toolName));
  // Hidden reasoning is NEVER a payload source: only tool_use input and text blocks
  // are extracted. Thinking/redacted_thinking blocks are recorded in contentTypes for
  // diagnostics and otherwise discarded.
  const text = tool
    ? JSON.stringify(tool.input ?? {})
    : blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
  const inputTokens = Number(parsed?.usage?.input_tokens ?? 0) || 0;
  const outputTokens = Number(parsed?.usage?.output_tokens ?? 0) || 0;
  const thinkingOnly = !tool && !text && contentTypes.some((t: string) => t === "thinking" || t === "redacted_thinking");

  return {
    text,
    inputTokens,
    outputTokens,
    httpStatus: res.status,
    responseType: tool ? "tool_use" : text ? "text" : thinkingOnly ? "thinking_only" : "empty",
    contentTypes,
  };
}

function isRetryable(category: AiErrorCategory, status?: number): boolean {
  if (category === "timeout" || category === "network") return true;
  if (category === "http") return status === 429 || (status != null && status >= 500);
  return false;
}

/**
 * Resolve the database for the budget gate. Returns null when there is none — which is the
 * normal unit-test condition and an ABNORMAL production one, handled differently below.
 */
function resolveBudgetDb(deps: ProviderDeps): BudgetDbLike | null {
  if (deps.db) return deps.db;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/db").getDb() as BudgetDbLike;
  } catch {
    return null;
  }
}

/**
 * The pre-flight budget decision for one call.
 *
 * Enforcement lives HERE, at the single provider chokepoint, and not at the call sites.
 * Four call sites checked a budget and three did not, and the three that did not were
 * invisible rather than noisy — an unmetered path does not fail, it just spends. A gate a
 * new call site has to remember to add is a gate that will eventually be missing.
 *
 * In production a missing database is itself a refusal: we cannot read the ledger, so we
 * cannot show we are under the cap, so we do not spend. In a test process (no DB, no
 * NODE_ENV=production) the call proceeds and the diagnostic says enforcement did not run.
 */
function budgetDecision(
  input: AiCallInput,
  deps: ProviderDeps,
  env: NodeJS.ProcessEnv,
): { gate: CombinedBudgetGate | null; state: BudgetEnforcementState; db: BudgetDbLike | null } {
  if (deps.budgetGate === null) return { gate: null, state: "BYPASSED_BY_CALLER", db: null };

  const cfg = aiConfig(env);
  const reserveUsd = maxJobCostUsd(input.model, cfg.maxInputTokensPerJob, input.maxOutputTokens);

  if (typeof deps.budgetGate === "function") {
    return { gate: deps.budgetGate(reserveUsd), state: "ENFORCED", db: deps.db ?? null };
  }

  const db = resolveBudgetDb(deps);
  if (!db) {
    if (String(env.NODE_ENV ?? "") === "production") {
      return {
        gate: {
          allowed: false,
          status: BUDGET_EXHAUSTED,
          reason: "AI budget ledger unavailable in production — spend cannot be proven, so no call is made",
          monthKey: "", spendUsd: 0, reserveUsd, projectedUsd: reserveUsd,
          hardLimitUsd: cfg.monthlyHardLimitUsd, absoluteCapUsd: cfg.monthlyHardCapUsd,
          softLimitUsd: cfg.monthlySoftLimitUsd, atSoftLimit: true, remainingUsd: 0,
          byLedger: {}, spendComplete: false,
        },
        state: "ENFORCED",
        db: null,
      };
    }
    return { gate: null, state: "NOT_ENFORCED_NO_DB", db: null };
  }

  try {
    return { gate: combinedCostGateOnDb(db, cfg, Date.now(), reserveUsd), state: "ENFORCED", db };
  } catch {
    // A gate that throws must not become a gate that is absent.
    return {
      gate: {
        allowed: false, status: BUDGET_EXHAUSTED,
        reason: "AI budget gate faulted — refusing the call rather than spending unmeasured",
        monthKey: "", spendUsd: 0, reserveUsd, projectedUsd: reserveUsd,
        hardLimitUsd: cfg.monthlyHardLimitUsd, absoluteCapUsd: cfg.monthlyHardCapUsd,
        softLimitUsd: cfg.monthlySoftLimitUsd, atSoftLimit: true, remainingUsd: 0,
        byLedger: {}, spendComplete: false,
      },
      state: "ENFORCED",
      db,
    };
  }
}

/** Record a run row without ever letting an audit-write failure break the caller. */
function safeRecord(db: BudgetDbLike | null, row: Parameters<typeof recordAiJobRunOnDb>[1]): void {
  if (!db) return;
  try { recordAiJobRunOnDb(db, row); } catch { /* audit is best-effort; never throws upward */ }
}

/**
 * Run one structured AI job: call -> extract JSON/tool input -> validate. Validation
 * misses get at most one paid retry; transient network/5xx failures honor maxRetries.
 */
export async function runStructuredAiJob<T>(
  input: AiCallInput,
  validate: (json: unknown) => T,
  deps: ProviderDeps = {},
): Promise<AiCallResult<T>> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiKey = String(env.ANTHROPIC_API_KEY ?? "").trim();
  const started = Date.now();
  if (!apiKey) {
    const diagnostics = emptyDiagnostics();
    diagnostics.stoppedEarly = true;
    return {
      ok: false, data: null, text: null, inputTokens: 0, outputTokens: 0,
      retries: 0, latencyMs: 0, errorCategory: "disabled", error: "ANTHROPIC_API_KEY not set", diagnostics,
    };
  }

  // BUDGET PRE-FLIGHT — before the first byte is sent, and before any retry can
  // multiply the spend. A refusal here is not an error condition for the caller: it
  // returns the same shaped result as a disabled key, so every consumer's existing
  // "AI unavailable, show the deterministic answer" branch already handles it.
  const budget = budgetDecision(input, deps, env);
  if (budget.gate && !budget.gate.allowed) {
    const diagnostics = emptyDiagnostics();
    diagnostics.providerModel = input.model;
    diagnostics.promptVersion = input.promptVersion ?? null;
    diagnostics.validatorName = input.validatorName ?? null;
    diagnostics.stoppedEarly = true;
    diagnostics.budgetState = budget.state;
    diagnostics.budgetSpendUsd = budget.gate.spendUsd;
    safeRecord(budget.db, {
      jobType: input.jobType ?? "unattributed_ai_call",
      model: input.model,
      status: BUDGET_EXHAUSTED,
      errorCategory: "budget_exhausted",
      error: budget.gate.reason,
      inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: 0, retryCount: 0,
      diagnostic: {
        monthKey: budget.gate.monthKey,
        spendUsd: budget.gate.spendUsd,
        reserveUsd: budget.gate.reserveUsd,
        hardLimitUsd: budget.gate.hardLimitUsd,
        absoluteCapUsd: budget.gate.absoluteCapUsd,
        byLedger: budget.gate.byLedger,
      },
    });
    return {
      ok: false, data: null, text: null, inputTokens: 0, outputTokens: 0,
      retries: 0, latencyMs: 0, errorCategory: "budget_exhausted",
      error: budget.gate.reason, diagnostics,
    };
  }

  const attempts = Math.max(1, input.maxRetries + 1);
  const validationAttempts = Math.min(attempts, 2);
  const diagnostics = emptyDiagnostics();
  diagnostics.budgetState = budget.state;
  diagnostics.budgetSpendUsd = budget.gate?.spendUsd ?? null;
  diagnostics.validatorName = input.validatorName ?? null;
  diagnostics.providerModel = input.model;
  diagnostics.promptVersion = input.promptVersion ?? null;
  let lastErr: string | null = null;
  let lastCategory: AiErrorCategory = "none";
  let inTok = 0;
  let outTok = 0;
  let lastText: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { text, inputTokens, outputTokens, httpStatus, responseType, contentTypes } = await callOnce(input, apiKey, fetchImpl, attempt);
      diagnostics.attempts = attempt + 1;
      diagnostics.httpStatus = httpStatus;
      diagnostics.responseType = responseType;
      diagnostics.contentTypes = contentTypes;
      inTok += inputTokens;
      outTok += outputTokens;
      lastText = text;
      diagnostics.aiResponseLength = text.length;

      let data: T;
      try {
        if (responseType === "thinking_only") {
          throw new Error("thinking-only response: model returned only reasoning blocks with no tool or text payload");
        }
        const parsed = extractJsonWithMeta(text);
        diagnostics.markdownFenceStripped = diagnostics.markdownFenceStripped || parsed.markdownFenceStripped;
        diagnostics.extractedJson = diagnostics.extractedJson || parsed.extractedJson;
        diagnostics.parserOutput = parserOutput(parsed.json);
        if (parsed.json && typeof parsed.json === "object" && !Array.isArray(parsed.json)
          && Object.keys(parsed.json as object).length === 0) {
          throw new Error("empty tool/input object — retry with proposals array or { proposals: [] }");
        }
        data = validate(parsed.json);
      } catch (verr: any) {
        const message = String(verr?.message ?? verr);
        lastErr = `validation failed: ${message}`;
        lastCategory = "validation";
        diagnostics.validationErrors.push(message.slice(0, 300));
        let parsedJson: unknown = null;
        try { parsedJson = extractJsonWithMeta(text).json; } catch { parsedJson = null; }
        const violation = validationViolation(input, parsedJson, message, verr);
        diagnostics.validationStage = violation.stage;
        diagnostics.failingField = violation.failingField;
        diagnostics.expectedValue = violation.expectedValue;
        diagnostics.receivedValue = violation.receivedValue;
        diagnostics.schemaViolations.push(violation);
        if (attempt + 1 >= validationAttempts) {
          diagnostics.stoppedEarly = attempt + 1 < attempts;
          break;
        }
        continue;
      }

      meterIfRequested(input, budget.db, "SUCCESS", null, inTok, outTok, Date.now() - started, attempt);
      return {
        ok: true, data, text, inputTokens, outputTokens,
        retries: attempt, latencyMs: Date.now() - started, errorCategory: "none", error: null,
        diagnostics: { ...diagnostics, retryCount: attempt },
      };
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
      lastCategory = (err?.category as AiErrorCategory) ?? "network";
      diagnostics.attempts = attempt + 1;
      diagnostics.httpStatus = err?.httpStatus ?? err?.status ?? diagnostics.httpStatus;
      if (lastCategory === "parse") diagnostics.parseError = lastErr;
      if (!isRetryable(lastCategory, err?.status)) {
        diagnostics.stoppedEarly = attempt + 1 < attempts;
        break;
      }
    }
  }

  // A failed call still burned input tokens. Recording only successes is how a month of
  // VALIDATION_FAILED retries becomes invisible spend — 11 of 31 recorded August runs
  // failed validation, and they cost real money.
  meterIfRequested(
    input, budget.db,
    lastCategory === "validation" ? "VALIDATION_FAILED" : lastCategory === "timeout" ? "TIMEOUT" : "ERROR",
    lastErr, inTok, outTok, Date.now() - started, Math.max(0, diagnostics.attempts - 1),
  );
  return {
    ok: false, data: null, text: lastText,
    inputTokens: inTok, outputTokens: outTok,
    retries: Math.max(0, diagnostics.attempts - 1), latencyMs: Date.now() - started,
    errorCategory: lastCategory, error: lastErr,
    diagnostics: { ...diagnostics, retryCount: Math.max(0, diagnostics.attempts - 1) },
  };
}

/**
 * Write the spend row for call sites that do not write their own (`meter: true`).
 * Silently does nothing otherwise, so the callers that already record are not double-billed.
 */
function meterIfRequested(
  input: AiCallInput,
  db: BudgetDbLike | null,
  status: string,
  error: string | null,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  retryCount: number,
): void {
  if (!input.meter || !db) return;
  safeRecord(db, {
    jobType: input.jobType ?? "unattributed_ai_call",
    model: input.model,
    status,
    error,
    inputTokens, outputTokens,
    estimatedCostUsd: estimateCostUsd(input.model, inputTokens, outputTokens),
    latencyMs, retryCount,
  });
}

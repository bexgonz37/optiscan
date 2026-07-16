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

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export type AiErrorCategory = "none" | "disabled" | "timeout" | "http" | "network" | "validation" | "parse";

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
}

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

function fieldFromValidationMessage(message: string): string | null {
  const proposal = /proposal\[(\d+)\]\.field '([^']+)'/i.exec(message);
  if (proposal) return `proposals[${proposal[1]}].${proposal[2]}`;
  const field = /field '([^']+)'/i.exec(message);
  if (field) return field[1];
  const proposalObject = /proposal\[(\d+)\] must be an object/i.exec(message);
  if (proposalObject) return `proposals[${proposalObject[1]}]`;
  if (/weekly proposals must be an array/i.test(message)) return "root";
  if (/narrative contains a number/i.test(message)) return "antiFabricationNumbers";
  return null;
}

function expectedFromValidationMessage(message: string): string | null {
  if (/must be a non-empty string/i.test(message)) return "non-empty string";
  if (/must be an array/i.test(message)) return "array";
  if (/must be an object/i.test(message)) return "object";
  if (/weekly proposals must be an array/i.test(message)) return "array or object with proposals array";
  if (/narrative contains a number/i.test(message)) return "every number must already appear in the deterministic summary";
  return null;
}

function receivedFromValidationMessage(message: string, json: unknown, field: string | null): unknown {
  const fabricated = /number not present in the deterministic summary: ([^ ]+)/i.exec(message);
  if (fabricated) return fabricated[1];
  return valueAtPath(json, field);
}

function validationViolation(input: AiCallInput, json: unknown, message: string): AiSchemaViolation {
  const field = fieldFromValidationMessage(message);
  const stage = /narrative contains a number/i.test(message) ? "anti_fabrication" : "schema";
  return {
    stage,
    validatorName: input.validatorName ?? null,
    failingField: field,
    expectedValue: expectedFromValidationMessage(message),
    receivedValue: receivedFromValidationMessage(message, json, field),
    message: message.slice(0, 500),
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

async function callOnce(
  input: AiCallInput,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ text: string; inputTokens: number; outputTokens: number; httpStatus: number; responseType: string; contentTypes: string[] }> {
  const body: any = {
    model: input.model,
    max_tokens: input.maxOutputTokens,
    system: input.system,
    messages: [{ role: "user", content: input.user }],
  };
  if (input.toolName && input.toolInputSchema) {
    body.tools = [{
      name: input.toolName,
      description: "Return the required structured JSON payload for OptiScan.",
      input_schema: input.toolInputSchema,
    }];
    body.tool_choice = { type: "tool", name: input.toolName };
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
  const text = tool
    ? JSON.stringify(tool.input ?? {})
    : blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
  const inputTokens = Number(parsed?.usage?.input_tokens ?? 0) || 0;
  const outputTokens = Number(parsed?.usage?.output_tokens ?? 0) || 0;

  return {
    text,
    inputTokens,
    outputTokens,
    httpStatus: res.status,
    responseType: tool ? "tool_use" : text ? "text" : "empty",
    contentTypes,
  };
}

function isRetryable(category: AiErrorCategory, status?: number): boolean {
  if (category === "timeout" || category === "network") return true;
  if (category === "http") return status === 429 || (status != null && status >= 500);
  return false;
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

  const attempts = Math.max(1, input.maxRetries + 1);
  const validationAttempts = Math.min(attempts, 2);
  const diagnostics = emptyDiagnostics();
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
      const { text, inputTokens, outputTokens, httpStatus, responseType, contentTypes } = await callOnce(input, apiKey, fetchImpl);
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
        const parsed = extractJsonWithMeta(text);
        diagnostics.markdownFenceStripped = diagnostics.markdownFenceStripped || parsed.markdownFenceStripped;
        diagnostics.extractedJson = diagnostics.extractedJson || parsed.extractedJson;
        diagnostics.parserOutput = parserOutput(parsed.json);
        data = validate(parsed.json);
      } catch (verr: any) {
        const message = String(verr?.message ?? verr);
        lastErr = `validation failed: ${message}`;
        lastCategory = "validation";
        diagnostics.validationErrors.push(message.slice(0, 300));
        let parsedJson: unknown = null;
        try { parsedJson = extractJsonWithMeta(text).json; } catch { parsedJson = null; }
        const violation = validationViolation(input, parsedJson, message);
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

  return {
    ok: false, data: null, text: lastText,
    inputTokens: inTok, outputTokens: outTok,
    retries: Math.max(0, diagnostics.attempts - 1), latencyMs: Date.now() - started,
    errorCategory: lastCategory, error: lastErr,
    diagnostics: { ...diagnostics, retryCount: Math.max(0, diagnostics.attempts - 1) },
  };
}

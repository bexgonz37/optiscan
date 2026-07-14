/**
 * ai/provider.ts — the ONE Anthropic provider abstraction for the advisory AI
 * layer. Single-shot, structured-JSON calls only (no agentic loop, no tools). It
 * is deliberately built on `fetch` (like the existing Discord/provider calls) so
 * the deterministic build stays hermetic and the AI layer adds no runtime that
 * could wedge the scanner.
 *
 * Guarantees:
 *  - The API key is read ONLY from ANTHROPIC_API_KEY and never logged or returned.
 *  - Every call has a hard timeout (AbortSignal.timeout) and BOUNDED retries.
 *  - The response is parsed as strict JSON and validated by the caller's schema
 *    before it is ever trusted; a malformed/blocked/timeout response fails closed.
 *  - It NEVER throws to its caller — a failure returns { ok:false, ... } so an AI
 *    outage can never break scanning, Discord, paper trading, or grading.
 *  - Token usage is returned for cost accounting; the caller records the audit row.
 *
 * The `fetchImpl` dependency is injectable so tests exercise timeout/malformed/
 * retry/validation paths deterministically without a network.
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
}

export interface ProviderDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Strip markdown fences and pull the first JSON object/array out of model text. */
export function extractJson(text: string): unknown {
  if (!text) throw new Error("empty response");
  let t = String(text).trim();
  // Remove ```json ... ``` or ``` ... ``` fences if present.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1].trim();
  // If there is leading/trailing prose, isolate the outermost JSON braces.
  if (!(t.startsWith("{") || t.startsWith("["))) {
    const first = t.search(/[[{]/);
    const lastObj = t.lastIndexOf("}");
    const lastArr = t.lastIndexOf("]");
    const last = Math.max(lastObj, lastArr);
    if (first >= 0 && last > first) t = t.slice(first, last + 1);
  }
  return JSON.parse(t);
}

/** One raw call to the Messages API. Returns text + usage, or throws a tagged error. */
async function callOnce(
  input: AiCallInput,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const body = {
    model: input.model,
    max_tokens: input.maxOutputTokens,
    system: input.system,
    messages: [{ role: "user", content: input.user }],
  };
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
    throw e;
  }
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    const e = new Error(`anthropic ${res.status}: ${raw.slice(0, 200)}`);
    (e as any).category = "http";
    (e as any).status = res.status;
    throw e;
  }
  let parsed: any;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch {
    const e = new Error("provider returned non-JSON body");
    (e as any).category = "parse";
    throw e;
  }
  const text = Array.isArray(parsed?.content)
    ? parsed.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("")
    : "";
  const inputTokens = Number(parsed?.usage?.input_tokens ?? 0) || 0;
  const outputTokens = Number(parsed?.usage?.output_tokens ?? 0) || 0;
  return { text, inputTokens, outputTokens };
}

/** HTTP statuses worth retrying (transient). 4xx (except 429) are permanent. */
function isRetryable(category: AiErrorCategory, status?: number): boolean {
  if (category === "timeout" || category === "network") return true;
  if (category === "http") return status === 429 || (status != null && status >= 500);
  return false;
}

/**
 * Run one structured AI job: call → extract JSON → validate. Retries are BOUNDED
 * (maxRetries) and only for transient errors or a validation miss. Never throws.
 * `validate` returns the typed value or throws (its message becomes the error).
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
    return { ok: false, data: null, text: null, inputTokens: 0, outputTokens: 0, retries: 0, latencyMs: 0, errorCategory: "disabled", error: "ANTHROPIC_API_KEY not set" };
  }

  const attempts = Math.max(1, input.maxRetries + 1);
  let lastErr: string | null = null;
  let lastCategory: AiErrorCategory = "none";
  let inTok = 0, outTok = 0, lastText: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { text, inputTokens, outputTokens } = await callOnce(input, apiKey, fetchImpl);
      inTok = inputTokens; outTok = outputTokens; lastText = text;
      let data: T;
      try {
        data = validate(extractJson(text));
      } catch (verr: any) {
        lastErr = `validation failed: ${verr?.message ?? verr}`;
        lastCategory = "validation";
        continue; // bounded retry — the model may return valid JSON next time
      }
      return {
        ok: true, data, text, inputTokens, outputTokens,
        retries: attempt, latencyMs: Date.now() - started, errorCategory: "none", error: null,
      };
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
      lastCategory = (err?.category as AiErrorCategory) ?? "network";
      if (!isRetryable(lastCategory, err?.status)) break; // permanent — stop early
    }
  }
  return {
    ok: false, data: null, text: lastText,
    inputTokens: inTok, outputTokens: outTok,
    retries: attempts - 1, latencyMs: Date.now() - started,
    errorCategory: lastCategory, error: lastErr,
  };
}

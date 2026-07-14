import test from "node:test";
import assert from "node:assert/strict";
import { runStructuredAiJob, extractJson } from "../lib/ai/provider.ts";

const BASE = { model: "claude-haiku-4-5", system: "s", user: "u", maxOutputTokens: 500, timeoutMs: 5000, maxRetries: 2 };
const KEY_ENV = { ANTHROPIC_API_KEY: "test-key" };

/** Build a fake fetch that returns a canned Anthropic message body. */
function fakeFetch(text, { status = 200, usage = { input_tokens: 100, output_tokens: 40 } } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify({ content: [{ type: "text", text }], usage }),
  });
}

test("extractJson strips code fences and surrounding prose", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":2} thanks'), { a: 2 });
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
});

test("missing API key ⇒ disabled, no call attempted", async () => {
  let called = 0;
  const res = await runStructuredAiJob(BASE, (j) => j, { fetchImpl: async () => { called++; return {}; }, env: {} });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "disabled");
  assert.equal(called, 0, "must not call the network without a key");
});

test("success path validates and returns typed data + token usage", async () => {
  const res = await runStructuredAiJob(BASE, (j) => { if (!j.headline) throw new Error("no headline"); return j; }, {
    fetchImpl: fakeFetch(JSON.stringify({ headline: "ok" })), env: KEY_ENV,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.headline, "ok");
  assert.equal(res.inputTokens, 100);
  assert.equal(res.outputTokens, 40);
  assert.equal(res.retries, 0);
});

test("malformed (non-JSON) response is rejected as a validation miss and retried, then fails closed", async () => {
  let calls = 0;
  const res = await runStructuredAiJob({ ...BASE, maxRetries: 2 }, (j) => j, {
    fetchImpl: async () => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: "text", text: "not json at all" }], usage: {} }) }; },
    env: KEY_ENV,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "validation");
  assert.equal(calls, 3, "1 initial + 2 bounded retries");
});

test("validation failure is bounded by maxRetries", async () => {
  let calls = 0;
  const res = await runStructuredAiJob({ ...BASE, maxRetries: 1 }, () => { throw new Error("always invalid"); }, {
    fetchImpl: async () => { calls++; return fakeFetch(JSON.stringify({ x: 1 }))(); }, env: KEY_ENV,
  });
  assert.equal(res.ok, false);
  assert.equal(calls, 2, "1 initial + 1 retry");
  assert.equal(res.errorCategory, "validation");
});

test("timeout (AbortError) fails closed and is categorized", async () => {
  const res = await runStructuredAiJob({ ...BASE, maxRetries: 0 }, (j) => j, {
    fetchImpl: async () => { const e = new Error("aborted"); e.name = "TimeoutError"; throw e; }, env: KEY_ENV,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "timeout");
});

test("a permanent 4xx (400) is NOT retried; a 500 IS retried", async () => {
  let calls400 = 0;
  await runStructuredAiJob({ ...BASE, maxRetries: 3 }, (j) => j, {
    fetchImpl: async () => { calls400++; return { ok: false, status: 400, text: async () => "bad request" }; }, env: KEY_ENV,
  });
  assert.equal(calls400, 1, "permanent client error stops immediately");

  let calls500 = 0;
  await runStructuredAiJob({ ...BASE, maxRetries: 2 }, (j) => j, {
    fetchImpl: async () => { calls500++; return { ok: false, status: 500, text: async () => "server error" }; }, env: KEY_ENV,
  });
  assert.equal(calls500, 3, "transient server error retries to the bound");
});

test("the provider never throws — a network error returns { ok:false }", async () => {
  const res = await runStructuredAiJob({ ...BASE, maxRetries: 0 }, (j) => j, {
    fetchImpl: async () => { throw new Error("ECONNRESET"); }, env: KEY_ENV,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "network");
  assert.equal(res.data, null);
});

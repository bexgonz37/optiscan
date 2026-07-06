import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("SPEC: every-second scanner loop exists (default 1000ms) and is started at boot", () => {
  const loop = read("lib/scanner-loop.ts");
  assert.ok(loop.includes("SCANNER_LOOP_MS ?? 1000"), "loop default must be 1s");
  assert.ok(loop.includes("export function startScannerLoop"));
  assert.ok(read("instrumentation.ts").includes("startScannerLoop"));
});

test("SPEC: options chains are fetched only for triggered/active tickers, never in the 1s tick body", () => {
  const loop = read("lib/scanner-loop.ts");
  // tick() = everything between 'async function tick' and 'export function startScannerLoop'
  const tickBody = loop.slice(loop.indexOf("async function tick"), loop.indexOf("export function startScannerLoop"));
  assert.ok(!tickBody.includes("fetchOptionChain("), "tick() must not fetch chains directly");
  const triggerBody = loop.slice(loop.indexOf("async function handleTrigger"), loop.indexOf("async function refreshActiveAlerts"));
  assert.ok(triggerBody.includes("fetchOptionChain("), "chains fetch inside handleTrigger only");
  assert.ok(tickBody.includes("shouldTrigger("), "tick must gate via shouldTrigger");
  assert.ok(loop.includes("lastChainFetch"), "per-symbol chain throttle required");
  assert.ok(loop.includes("intervalMs * 2"), "429 backoff required");
});

test("SPEC: catalyst attach is fire-and-forget after insert — never blocks or gates an alert", () => {
  const cap = read("lib/alert-capture.ts");
  assert.ok(cap.includes("attachCatalystLater"), "late attach fn required");
  const beforeInsert = cap.slice(0, cap.indexOf("insertAlert({"));
  assert.ok(!beforeInsert.includes("await fetchNews"), "news must not be awaited before insert");
  assert.ok(cap.includes('catalystSource: "pending"'), "alerts insert with catalyst pending");
});

test("SPEC: scanner is AI-free — no model calls anywhere in lib/", () => {
  for (const f of readdirSync(join(root, "lib"))) {
    const src = read(join("lib", f));
    assert.ok(!/openai|anthropic\.com|claude|gpt-|llm/i.test(src), `AI reference found in lib/${f}`);
  }
});

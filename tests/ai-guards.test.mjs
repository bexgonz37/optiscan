import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("the AI API route is auth-gated on BOTH GET and POST", () => {
  const src = read("app/api/ai/route.ts");
  const gets = src.match(/if \(!checkApiToken\(req\)\) return unauthorized\(\);/g) ?? [];
  assert.ok(gets.length >= 2, "both handlers check the API token");
  assert.ok(/export async function GET/.test(src) && /export async function POST/.test(src));
});

test("no LLM in the hot path: the scanner loop and paper engine never import the AI layer", () => {
  for (const f of ["lib/scanner-loop.ts", "lib/paper-engine.ts", "lib/notifications.ts", "lib/callouts/runtime.ts"]) {
    assert.ok(!/lib\/ai\//.test(read(f)), `${f} must not import lib/ai/* (AI stays out of the hot path)`);
  }
});

test("AI jobs run DETACHED from the scheduler beat (never awaited inline)", () => {
  const src = read("lib/scheduler.ts");
  assert.ok(/function launchAiJobs/.test(src));
  assert.ok(/void \(async \(\) =>/.test(src), "AI job is fired as a detached promise");
  // The launcher is NOT awaited in the beat (so a slow model call can't delay Discord).
  assert.ok(/launchAiJobs\(nowMs\);/.test(src) && !/await launchAiJobs/.test(src));
  // Still lease-protected: the whole beat only runs for the single scheduler lease owner.
  assert.ok(/acquireLease\(/.test(src));
});

test("the provider reads the API key ONLY from env and hardcodes no secret", () => {
  const src = read("lib/ai/provider.ts");
  assert.ok(/env\.ANTHROPIC_API_KEY/.test(src));
  assert.ok(!/sk-ant-/.test(src), "no hardcoded API key");
  assert.ok(/AbortSignal\.timeout/.test(src), "every call has a hard timeout");
});

test("weekly proposals carry the human-approval + no-auto-apply boundary in the prompt", () => {
  const src = read("lib/ai/prompts.ts");
  assert.ok(/PENDING/.test(src));
  assert.ok(/must NOT: apply changes, merge, deploy/.test(src));
  assert.ok(/bearish actionable/.test(src));
});

test("scheduling uses America/New_York and the exchange calendar", () => {
  const src = read("lib/ai/schedule.ts");
  assert.ok(/America\/New_York/.test(src));
  assert.ok(/isMarketHoliday/.test(src), "holidays excluded from nightly runs");
});

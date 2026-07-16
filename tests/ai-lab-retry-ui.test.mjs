import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const src = readFileSync(join(root, "app/ai/page.tsx"), "utf8");

test("AI Lab retry button is visible for VALIDATION_FAILED nightly history rows", () => {
  assert.match(src, /RETRYABLE_NIGHTLY_STATUSES[\s\S]*VALIDATION_FAILED/);
  assert.match(src, /Retry Narrative/);
});

test("AI Lab retry button is visible for ERROR nightly history rows", () => {
  assert.match(src, /RETRYABLE_NIGHTLY_STATUSES[\s\S]*ERROR/);
});

test("AI Lab retry button is visible for SKIPPED nightly history rows", () => {
  assert.match(src, /RETRYABLE_NIGHTLY_STATUSES[\s\S]*SKIPPED/);
});

test("AI Lab retry button is hidden for successful nightly history rows", () => {
  const retryableLine = src.match(/const RETRYABLE_NIGHTLY_STATUSES = new Set\(\[[^\]]+\]\);/)?.[0] ?? "";
  assert.match(src, /const retryable = RETRYABLE_NIGHTLY_STATUSES\.has\(String\(r\.narrativeStatus\)\)/);
  assert.match(src, /if \(!retryable\) return/);
  assert.doesNotMatch(retryableLine, /"OK"/);
});

test("AI Lab retry sends authenticated POST payload with reportId or periodKey fallback", () => {
  assert.match(src, /method: "POST"/);
  assert.match(src, /headers: \{ \.\.\.scanHeaders\(\), "content-type": "application\/json" \}/);
  assert.match(src, /\{ action: "retry_nightly_narrative", reportId: Number\(report\.id\) \}/);
  assert.match(src, /\{ action: "retry_nightly_narrative", periodKey: String\(report\?\.periodKey \?\? ""\) \}/);
});

test("AI Lab retry shows loading state and disables duplicate clicks", () => {
  assert.match(src, /retryingKey/);
  assert.match(src, /setRetryingKey\(key\)/);
  assert.match(src, /disabled=\{Boolean\(retryingKey\)\}/);
  assert.match(src, /Retrying\.\.\./);
});

test("AI Lab retry success refreshes report list", () => {
  assert.match(src, /setRetryMessage\(\{ key, text: "Retry started successfully\.", ok: true \}\)/);
  assert.match(src, /await load\(\)/);
});

test("AI Lab retry failure displays exact error response", () => {
  assert.match(src, /const raw = await res\.text\(\)/);
  assert.match(src, /payload\?\.error \?\? \(raw \|\| `HTTP \$\{res\.status\}`\)/);
  assert.match(src, /setRetryMessage\(\{ key, text: String\(detail\), ok: false \}\)/);
});

test("AI Lab shows structured validation diagnostics under failed nightly report rows", () => {
  assert.match(src, /key: "diagnostic"/);
  assert.match(src, /<ValidationDetails diagnostic=\{r\.diagnostic\} summary="Structured validation diagnostic" \/>/);
});

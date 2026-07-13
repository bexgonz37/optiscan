import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("runtime status reports worker ownership, cycles, learning, model, improvement", () => {
  const src = read("lib/runtime-status.ts");
  for (const field of [
    "scannerLockHolder", "leaseHolder", "loopState", "supervisorTelemetry",
    "calloutStateSummary", "discordDeliverySummary", "learningStatus",
    "modelStatus", "improvementStatus", "nextEligibleLearningMs",
    "moreForValidated", "moreForExperimental",
  ]) {
    assert.ok(src.includes(field), `missing runtime-status field/source: ${field}`);
  }
});

test("runtime status never exposes secrets or webhook URLs", () => {
  const src = read("lib/runtime-status.ts");
  assert.ok(!/DISCORD_WEBHOOK|webhookUrl|process\.env\.[A-Z_]*KEY|apiKey|token/i.test(src), "no secret/webhook exposure");
  // Only aggregate delivery COUNTS are surfaced (by status), never payloads.
  assert.ok(/discordDeliverySummary\(\)/.test(src));
  assert.ok(!/payload_json|response_body/.test(src), "no payloads/response bodies");
});

test("runtime status is read-only (no writes)", () => {
  const src = read("lib/runtime-status.ts");
  assert.ok(!/INSERT |UPDATE |DELETE |createDiscordDelivery|persist/i.test(src), "no writes");
});

test("runtime status route is auth-gated", () => {
  const route = read("app/api/runtime/status/route.ts");
  assert.ok(/checkApiToken\(req\)/.test(route));
  assert.ok(/return unauthorized\(\)/.test(route));
  assert.ok(/buildRuntimeStatus\(\)/.test(route));
});

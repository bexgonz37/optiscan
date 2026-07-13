import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSmokeCallouts, SMOKE_LABEL } from "../lib/callouts/smoke-fixtures.ts";
import { containsBannedLanguage } from "../lib/callouts/callout.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const items = buildSmokeCallouts();
const byName = Object.fromEntries(items.map((i) => [i.name, i]));

test("every smoke payload is unmistakably labeled TEST / DRY RUN", () => {
  assert.ok(items.length >= 6);
  for (const it of items) {
    assert.ok(it.payload.content.includes(SMOKE_LABEL), `${it.name} missing label in content`);
    assert.ok(it.payload.embed.title.startsWith("[TEST]"), `${it.name} missing [TEST] title`);
  }
});

test("options actionable routes to the options channel", () => {
  assert.equal(byName.options_actionable.webhook, "options");
});

test("put research routes to options and is labeled RESEARCH", () => {
  const put = byName.put_research;
  assert.equal(put.webhook, "options");
  assert.match(put.payload.embed.title, /PUT \(research\)/);
  assert.match(JSON.stringify(put.payload), /RESEARCH ONLY/);
});

test("momentum-stock routes to the stocks channel", () => {
  assert.equal(byName.stock_momentum.webhook, "stocks");
});

test("inactive model shows the SETUP SCORE fallback; experimental shows the EXPERIMENTAL label", () => {
  const inactiveModel = byName.model_inactive.payload.embed.fields.find((f) => f.name === "Model");
  assert.match(inactiveModel.value, /SETUP SCORE — NOT A PROBABILITY/);
  const expModel = byName.model_experimental.payload.embed.fields.find((f) => f.name === "Model");
  assert.match(expModel.value, /EXPERIMENTAL — LIMITED DATA — RESEARCH ONLY/);
});

test("no-valid-contract scenario renders without a fabricated contract", () => {
  const nvc = byName.no_valid_contract;
  const contractField = nvc.payload.embed.fields.find((f) => f.name === "Contract");
  assert.ok(contractField, "has a Contract field");
  assert.ok(!/O:TEST_C100/.test(JSON.stringify(nvc.payload)), "no fabricated option symbol");
});

test("no smoke payload contains banned/guarantee language", () => {
  for (const it of items) assert.ok(!containsBannedLanguage(JSON.stringify(it.payload)), `${it.name} banned language`);
});

// ── send-path gating (source-spec) ──────────────────────────────────────────

test("smoke send is disabled by default (requires DISCORD_SMOKE_TEST=1)", () => {
  const src = read("lib/callouts/smoke.ts");
  assert.ok(/DISCORD_SMOKE_TEST === "1"/.test(src));
  assert.ok(/send && !smokeTestEnabled\(\)/.test(src), "refuses to send when not enabled");
  assert.ok(/if \(!send\)/.test(src), "dry-run by default");
});

test("smoke test has NO paper/outcome/fingerprint/model side effects", () => {
  const src = read("lib/callouts/smoke.ts") + read("lib/callouts/smoke-fixtures.ts");
  // No imports/calls into the trading/model/outcome subsystems (prose is fine).
  assert.ok(!/paper-engine|outcome-store|setup-fingerprint|model-registry|freezeFingerprint\(|trainAndEvaluate\(|startPaperEngine\(|syncPaperOutcomes\(/.test(src), "no trading/model side effects");
  // Delivery reuses the tracked ledger with a namespaced idempotency key.
  assert.ok(/idempotencyKey: `smoke:/.test(read("lib/callouts/smoke.ts")));
});

test("smoke endpoint is auth-gated and dry-run by default", () => {
  const route = read("app/api/dev/discord-smoke/route.ts");
  assert.ok(/checkApiToken\(req\)/.test(route));
  assert.ok(/searchParams\.get\("send"\) === "1"/.test(route));
});

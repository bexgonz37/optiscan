/**
 * tests/weekly-wiring-and-lane-separation.test.mjs
 *
 * PHASE 6 — the weekly and nightly research context must actually RECEIVE the
 * repaired owner evidence and the experiment that is currently under test.
 *
 * PHASE 8 — the Discord lanes must be separate CHANNELS, not merely separate names.
 *
 * Both defects have the same shape as everything else caught this month: the missing
 * thing was invisible. A research context with no experiment section reads exactly
 * like a context whose experiment had nothing to report, and a webhook variable that
 * holds a copy of another channel's URL reads exactly like a correctly configured one.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  buildAiResearchContextOnDb,
  NIGHTLY_ANALYSIS_QUESTIONS,
} from "../lib/research/options/ai-research-context.ts";
// Dynamic: lane-separation reaches `lib/notifications.ts`, which statically imports
// through the `@/` alias. ESM links every static import before the alias registration
// above has run, so a static import here fails to resolve in the test harness only.
const { applyProductionSchemaOnDb } = await import("@/lib/db");
const { buildLaneSeparationReport, MUST_BE_SEPARATE } = await import("@/lib/notifications/lane-separation");

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

// ── PHASE 6: the weekly/nightly context ──────────────────────────────────────

test("the research context carries the experiment that is actually collecting evidence", () => {
  const ctx = buildAiResearchContextOnDb(db(), { sessionDate: null });
  const x = ctx.ownerSelectionStrengthExperiment;
  assert.ok(x, "OWNER_SELECTION_STRENGTH_GATE_V1 must be in the payload the weekly reads");
  assert.equal(x.experimentId, "OWNER_SELECTION_STRENGTH_GATE_V1");
  assert.equal(x.mode, "SHADOW_ONLY");
  assert.equal(x.definitionFrozen.frozen, true, x.definitionFrozen.message);
  assert.equal(x.definitionFrozen.expected, "9b4f77b3c6268bf9e94781dc849ad2ef");
  assert.equal(x.frozen.prospectiveStartDate, "2026-08-19");
});

test("the context still carries LHC_SELECT_V1 — the new section replaces nothing", () => {
  const ctx = buildAiResearchContextOnDb(db(), { sessionDate: null });
  assert.equal(ctx.experiment.experimentId, "LHC_SELECT_V1");
  assert.equal(ctx.experiment.frozen, true);
});

test("the context carries the repaired owner validation lane", () => {
  const ctx = buildAiResearchContextOnDb(db(), { sessionDate: null });
  assert.ok(ctx.ownerValidation, "the owner lane must never be absent, only empty");
  assert.match(ctx.ownerValidation.lane, /OWNER_VALIDATION_PAPER/);
  assert.equal(ctx.ownerValidation.scope, "ALL_FORWARD_SESSIONS",
    "one session cannot answer whether the callouts work");
});

test("the context carries PRE_MOVE V2 BESIDE V1, never instead of it", () => {
  const ctx = buildAiResearchContextOnDb(db(), { sessionDate: null });
  assert.ok(ctx.preMove, "V1 must still be present");
  assert.ok(ctx.preMoveV2, "V2 must be present");
  assert.equal(ctx.preMoveV2.discoveryVersion, "PRE_MOVE_DISCOVERY_V2");
  assert.equal(ctx.preMoveV2.definitionFrozen.frozen, true);
  assert.equal(ctx.preMoveV2.verdict, "INSUFFICIENT_EVIDENCE",
    "an empty prospective population is INSUFFICIENT_EVIDENCE, not a gap");
});

test("nothing is null-as-empty-object — an absent section is null and says so", () => {
  const ctx = buildAiResearchContextOnDb(db(), { sessionDate: null });
  for (const [k, v] of Object.entries(ctx)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      assert.notEqual(Object.keys(v).length, 0, `${k} is an empty object, which reads as a measured zero`);
    }
  }
});

test("the analysis questions ask about the experiment that is running", () => {
  const joined = NIGHTLY_ANALYSIS_QUESTIONS.join(" ");
  assert.match(joined, /OWNER_SELECTION_STRENGTH_GATE_V1/,
    "a question set that never names the running experiment cannot produce a finding about it");
  assert.match(joined, /PRE_MOVE_DISCOVERY_V2/);
  assert.match(joined, /PROSPECTIVE/i);
});

test("the authority instructions forbid promoting the running experiment", () => {
  const ctx = buildAiResearchContextOnDb(db(), { sessionDate: null });
  const joined = ctx.instructions.join(" ");
  assert.match(joined, /OWNER_SELECTION_STRENGTH_GATE_V1 is SHADOW ONLY/);
  assert.match(joined, /never propose promoting it/i);
  assert.match(joined, /PROSPECTIVE outcomes only/);
  assert.match(joined, /Never blend a V1 stage with a V2 stage/);
  assert.match(joined, /may not change a live threshold/i);
});

test("the reading rules still forbid rendering a null as zero", () => {
  const ctx = buildAiResearchContextOnDb(db(), { sessionDate: null });
  assert.match(ctx.readingRules.join(" "), /null means NOT MEASURED/i);
});

// ── PHASE 8: the lanes must be separate CHANNELS ─────────────────────────────

test("two lanes pointed at the same URL are reported as a collision", () => {
  const shared = "https://discord.com/api/webhooks/1/shared";
  const r = buildLaneSeparationReport({
    DISCORD_WEBHOOK_CONTENT: shared,
    DISCORD_WEBHOOK_RECAP: shared,
    DISCORD_RECAP_ENABLED: "1",
  });
  assert.equal(r.ok, false);
  assert.ok(r.collisions.some((c) => c.a === "content" && c.b === "recap"),
    "this is the exact condition that put 1209 drafts in the owner's recap channel");
  const check = r.checks.find((c) => c.a === "content" && c.b === "recap");
  assert.equal(check.shareOneChannel, true);
  assert.ok(check.why.length > 30, "a collision must explain why it matters");
});

test("separate URLs report ok", () => {
  const r = buildLaneSeparationReport({
    DISCORD_WEBHOOK_CONTENT: "https://discord.com/api/webhooks/1/content",
    DISCORD_WEBHOOK_RECAP: "https://discord.com/api/webhooks/2/recap",
    DISCORD_WEBHOOK_OPTIONS: "https://discord.com/api/webhooks/3/options",
    DISCORD_RECAP_ENABLED: "1",
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.collisions, []);
});

test("an UNSET webhook reports null, never 'separate'", () => {
  const r = buildLaneSeparationReport({
    DISCORD_WEBHOOK_RECAP: "https://discord.com/api/webhooks/2/recap",
    DISCORD_RECAP_ENABLED: "1",
  });
  const check = r.checks.find((c) => c.a === "content" && c.b === "recap");
  assert.equal(check.bothConfigured, false);
  assert.equal(check.shareOneChannel, null,
    "a missing configuration is not a passing check");
  assert.equal(r.ok, true, "an unset webhook is not a collision either");
});

test("NO webhook value, fragment or hash ever appears in the report", () => {
  const secret = "https://discord.com/api/webhooks/999/SUPER_SECRET_TOKEN_VALUE";
  const r = buildLaneSeparationReport({
    DISCORD_WEBHOOK_CONTENT: secret,
    DISCORD_WEBHOOK_RECAP: secret,
    DISCORD_WEBHOOK_OPTIONS: secret,
    DISCORD_WEBHOOK_WATCHLIST: secret,
    DISCORD_RECAP_ENABLED: "1",
  });
  const serialized = JSON.stringify(r);
  assert.doesNotMatch(serialized, /SUPER_SECRET_TOKEN_VALUE/);
  assert.doesNotMatch(serialized, /discord\.com/);
  assert.doesNotMatch(serialized, /webhooks\/999/);
  // The answer to "are these the same" carries none of the secret. That is the whole
  // reason this check is safe to expose.
  assert.equal(r.ok, false, "it must still have detected the collisions");
  assert.ok(r.collisions.length >= 3);
});

test("content is checked against every channel it must never reach", () => {
  const partners = MUST_BE_SEPARATE.filter((p) => p.a === "content" || p.b === "content")
    .map((p) => (p.a === "content" ? p.b : p.a));
  for (const need of ["recap", "options", "watchlist"]) {
    assert.ok(partners.includes(need), `content must be checked against ${need}`);
  }
});

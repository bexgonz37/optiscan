import test from "node:test";
import assert from "node:assert/strict";
import { buildProposal } from "../lib/improvement/proposal.ts";
import { decideDisposition, automationContextFromEnv, ABSOLUTE_PROHIBITIONS } from "../lib/improvement/policy.ts";

const NOW = Date.parse("2026-07-11T14:30:00Z");
const p = (over) => buildProposal({ category: "documentation", title: "docs", rationale: "explain foo", targetPaths: ["lib/foo.ts"], createdAtMs: NOW, ...over });

const NO_AUTOMATION = { automationAvailable: false, autoMergeEnabled: false };
const AUTOMATION_NO_MERGE = { automationAvailable: true, autoMergeEnabled: false };
const AUTOMATION_MERGE = { automationAvailable: true, autoMergeEnabled: true };

test("forbidden proposal ⇒ BLOCKED under every context", () => {
  const forbidden = p({ category: "live_execution", title: "x", rationale: "y" });
  for (const ctx of [NO_AUTOMATION, AUTOMATION_NO_MERGE, AUTOMATION_MERGE]) {
    assert.equal(decideDisposition(forbidden, ctx).disposition, "BLOCKED");
  }
});

test("high-risk ⇒ HUMAN_REVIEW_REQUIRED even with automation + auto-merge on", () => {
  const high = p({ category: "risk_policy", title: "tune limit", rationale: "adjust", targetPaths: ["lib/z.ts"] });
  assert.equal(decideDisposition(high, AUTOMATION_MERGE).disposition, "HUMAN_REVIEW_REQUIRED");
});

test("no automation ⇒ low-risk work is READY_FOR_CODING_AGENT (never applied)", () => {
  assert.equal(decideDisposition(p(), NO_AUTOMATION).disposition, "READY_FOR_CODING_AGENT");
});

test("automation on but auto-merge off ⇒ HUMAN_REVIEW_REQUIRED", () => {
  assert.equal(decideDisposition(p(), AUTOMATION_NO_MERGE).disposition, "HUMAN_REVIEW_REQUIRED");
});

test("low-risk + eligible category + automation + auto-merge ⇒ AUTO_MERGE_ELIGIBLE", () => {
  assert.equal(decideDisposition(p({ category: "test_coverage", title: "add tests", rationale: "cover foo" }), AUTOMATION_MERGE).disposition, "AUTO_MERGE_ELIGIBLE");
});

test("medium-risk never auto-merges even with everything enabled", () => {
  const med = p({ category: "performance", title: "speed", rationale: "faster", targetPaths: ["lib/q.ts"] });
  assert.equal(decideDisposition(med, AUTOMATION_MERGE).disposition, "HUMAN_REVIEW_REQUIRED");
});

test("env context defaults to fully OFF", () => {
  const ctx = automationContextFromEnv({});
  assert.equal(ctx.automationAvailable, false);
  assert.equal(ctx.autoMergeEnabled, false);
  const on = automationContextFromEnv({ IMPROVEMENT_AUTOMATION: "1", IMPROVEMENT_AUTO_MERGE: "1" });
  assert.equal(on.automationAvailable, true);
  assert.equal(on.autoMergeEnabled, true);
});

test("prohibitions enumerate the non-negotiables", () => {
  const joined = ABSOLUTE_PROHIBITIONS.join(" ").toLowerCase();
  assert.ok(/force-push/.test(joined));
  assert.ok(/self-approve|self approve/.test(joined));
  assert.ok(/bearish/.test(joined));
  assert.ok(/live or real-money|live execution/.test(joined));
});

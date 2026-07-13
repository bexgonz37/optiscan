import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProposal,
  branchNameFor,
  isSafetyProtected,
  containsForbiddenIntent,
  categoryAutoMergeAllowed,
  PROPOSAL_VERSION,
} from "../lib/improvement/proposal.ts";
import { proposalsFromAudit } from "../lib/improvement/audit.ts";

const NOW = Date.parse("2026-07-11T14:30:00Z");

function input(over = {}) {
  return {
    category: "test_coverage",
    title: "Add test coverage for lib/foo.ts",
    rationale: "Module lib/foo.ts has no tests.",
    targetPaths: ["lib/foo.ts"],
    createdAtMs: NOW,
    ...over,
  };
}

test("proposal id is deterministic + versioned, object is frozen (immutable)", () => {
  const a = buildProposal(input());
  const b = buildProposal(input());
  assert.equal(a.id, b.id);
  assert.match(a.id, new RegExp(`^imp${PROPOSAL_VERSION}_[0-9a-f]{16}$`));
  assert.ok(Object.isFrozen(a));
  assert.throws(() => { a.risk = "HIGH"; });
});

test("target paths are normalized, de-duped, and sorted", () => {
  const p = buildProposal(input({ targetPaths: ["lib\\b.ts", "lib/a.ts", "lib/a.ts"] }));
  assert.deepEqual([...p.targetPaths], ["lib/a.ts", "lib/b.ts"]);
});

test("low-risk category is LOW + auto-merge-eligible; not forbidden", () => {
  const p = buildProposal(input({ category: "documentation" }));
  assert.equal(p.risk, "LOW");
  assert.equal(p.forbidden, false);
  assert.equal(categoryAutoMergeAllowed("documentation"), true);
});

test("medium category is MEDIUM and never auto-merge-eligible", () => {
  const p = buildProposal(input({ category: "performance", title: "Speed up scan", rationale: "reduce allocations" }));
  assert.equal(p.risk, "MEDIUM");
  assert.equal(categoryAutoMergeAllowed("performance"), false);
});

test("high-risk categories are HIGH", () => {
  for (const c of ["risk_policy", "strategy_logic", "execution_path"]) {
    const p = buildProposal(input({ category: c, title: "Tune", rationale: "adjust", targetPaths: ["lib/x.ts"] }));
    assert.equal(p.risk, "HIGH", c);
  }
});

test("inherently forbidden categories are forbidden + HIGH", () => {
  for (const c of ["bearish_enablement", "live_execution", "safety_policy"]) {
    const p = buildProposal(input({ category: c, title: "x", rationale: "y", targetPaths: ["lib/x.ts"] }));
    assert.equal(p.forbidden, true, c);
    assert.equal(p.risk, "HIGH", c);
    assert.ok(p.forbiddenReasons.length > 0);
  }
});

test("touching a safety-protected path forces forbidden even for a 'documentation' change", () => {
  for (const path of ["lib/bearish-gate.ts", "lib/paper-risk.ts", "lib/improvement/policy.ts", "lib/improvement-store.ts"]) {
    const p = buildProposal(input({ category: "documentation", targetPaths: [path] }));
    assert.equal(p.forbidden, true, path);
    assert.equal(p.risk, "HIGH", path);
    assert.ok(p.forbiddenReasons.some((r) => /safety-protected/.test(r)));
  }
});

test("a live-execution / brokerage path marker forces forbidden", () => {
  assert.equal(isSafetyProtected("lib/live-execution.ts"), true);
  assert.equal(isSafetyProtected("lib/broker-adapter.ts"), true);
  const p = buildProposal(input({ category: "refactor_readability", targetPaths: ["lib/broker-adapter.ts"] }));
  assert.equal(p.forbidden, true);
});

test("forbidden intent in title/rationale forces forbidden", () => {
  assert.equal(containsForbiddenIntent("bypass risk checks quickly"), true);
  assert.equal(containsForbiddenIntent("enable bearish actionable entries"), true);
  assert.equal(containsForbiddenIntent("add a helpful comment"), false);
  const p = buildProposal(input({ category: "documentation", title: "docs", rationale: "explain how to force push to main" }));
  assert.equal(p.forbidden, true);
});

test("branch name is auto-improve/<category>/<compact-utc>", () => {
  assert.equal(branchNameFor("test_coverage", NOW), "auto-improve/test_coverage/20260711T143000Z");
});

test("proposalsFromAudit builds one LOW proposal per untested module and skips protected paths", () => {
  const ps = proposalsFromAudit({ modulesWithoutTests: ["lib/foo.ts", "lib/bar.ts", "lib/paper-risk.ts"], nowMs: NOW });
  assert.equal(ps.length, 2, "protected path excluded");
  assert.ok(ps.every((p) => p.category === "test_coverage" && p.risk === "LOW" && !p.forbidden));
  assert.deepEqual(ps.map((p) => p.targetPaths[0]).sort(), ["lib/bar.ts", "lib/foo.ts"]);
});

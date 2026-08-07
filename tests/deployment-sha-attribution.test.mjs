/**
 * Deployment SHA attribution.
 *
 * The defect these cover: `railway up` carries no git metadata, so a deploy made that way runs
 * with no commit variable set and every row it writes had `deploymentSha` collapsed into
 * `UNKNOWN_LEGACY_VERSION` — the same value used for rows written in July before attribution
 * existed. A broken deploy and old history became the same string, and the only signal that
 * would have caught the deploy was the one that hid it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deployInfo, deploymentShaAttribution } from "../lib/build-info.ts";
import {
  freezeAttribution, legacyAttribution, isLegacyAttribution, isRuntimeShaUnavailable,
  censusShaAttribution, RUNTIME_SHA_UNAVAILABLE, UNKNOWN_LEGACY_VERSION, POLICY_VERSIONS,
} from "../lib/research/options/policy-attribution.ts";

const GITHUB_ENV = { RAILWAY_GIT_COMMIT_SHA: "62d1c80af371550d310c6c75f6d7b5154e251c7f", RAILWAY_GIT_BRANCH: "main" };

test("a deploy that carries git metadata reports OBSERVED and names its source", () => {
  const a = deploymentShaAttribution(GITHUB_ENV);
  assert.equal(a.state, "OBSERVED");
  assert.equal(a.degraded, false);
  assert.equal(a.sha, GITHUB_ENV.RAILWAY_GIT_COMMIT_SHA);
  assert.equal(a.shaShort, "62d1c80");
  assert.equal(a.source, "RAILWAY_GIT_COMMIT_SHA");
  assert.equal(a.branch, "main");
});

test("a deploy with no git metadata fails VISIBLY and never fabricates a SHA", () => {
  const a = deploymentShaAttribution({});
  assert.equal(a.state, "RUNTIME_SHA_UNAVAILABLE");
  assert.equal(a.degraded, true);
  assert.equal(a.sha, null);
  assert.equal(a.source, null);
  // The message has to name the remedy, not merely the symptom.
  assert.match(a.message, /GitHub\/main/);
  assert.match(a.message, /railway up/);
  assert.match(a.message, /NOT the same as legacy data/);
});

test("an empty or whitespace commit variable is absence, not a SHA", () => {
  assert.equal(deploymentShaAttribution({ RAILWAY_GIT_COMMIT_SHA: "   " }).state, "RUNTIME_SHA_UNAVAILABLE");
  assert.equal(deploymentShaAttribution({ RAILWAY_GIT_COMMIT_SHA: "" }).state, "RUNTIME_SHA_UNAVAILABLE");
});

test("the non-Railway fallbacks are still honoured, in order", () => {
  assert.equal(deploymentShaAttribution({ GIT_COMMIT: "aaa1111" }).source, "GIT_COMMIT");
  assert.equal(deploymentShaAttribution({ SOURCE_COMMIT: "bbb2222" }).source, "SOURCE_COMMIT");
  assert.equal(
    deploymentShaAttribution({ ...GITHUB_ENV, GIT_COMMIT: "aaa1111" }).source,
    "RAILWAY_GIT_COMMIT_SHA",
  );
});

test("deployInfo is unchanged for callers that only want the commit", () => {
  assert.equal(deployInfo(GITHUB_ENV).commit, GITHUB_ENV.RAILWAY_GIT_COMMIT_SHA);
  assert.equal(deployInfo({}).commit, null);
});

// ── the attribution stamped onto a row ──────────────────────────────────────────────────────

const IN = { strategyId: "lower_high_continuation", population: "DELIVERED_ALERT_PAPER" };

test("a live row written by an unidentifiable deploy is RUNTIME_SHA_UNAVAILABLE, not legacy", () => {
  const a = freezeAttribution({ ...IN, deploymentSha: null });
  assert.equal(a.deploymentSha, RUNTIME_SHA_UNAVAILABLE);
  assert.notEqual(a.deploymentSha, UNKNOWN_LEGACY_VERSION);
  // The policy versions are genuinely known — only the commit is not.
  assert.equal(a.strategyVersion, POLICY_VERSIONS.strategyVersion);
  assert.equal(isLegacyAttribution(a), false);
  assert.equal(isRuntimeShaUnavailable(a), true);
});

test("a live row from an identified deploy records the exact commit", () => {
  const a = freezeAttribution({ ...IN, deploymentSha: "62d1c80af371550d310c6c75f6d7b5154e251c7f" });
  assert.equal(a.deploymentSha, "62d1c80af371550d310c6c75f6d7b5154e251c7f");
  assert.equal(isRuntimeShaUnavailable(a), false);
  assert.equal(isLegacyAttribution(a), false);
});

test("a genuinely legacy row stays UNKNOWN_LEGACY_VERSION and is not confused with a bad deploy", () => {
  const a = legacyAttribution("lower_high_continuation", "DELIVERED_ALERT_PAPER");
  assert.equal(a.deploymentSha, UNKNOWN_LEGACY_VERSION);
  assert.equal(isLegacyAttribution(a), true);
  assert.equal(isRuntimeShaUnavailable(a), false);
});

test("the census keeps the three states apart rather than summing them", () => {
  const c = censusShaAttribution([
    { deploymentSha: "62d1c80" },
    { deploymentSha: "62d1c80" },
    { deploymentSha: "2460dc3" },
    { deploymentSha: RUNTIME_SHA_UNAVAILABLE },
    { deploymentSha: UNKNOWN_LEGACY_VERSION },
    { deploymentSha: null },
  ]);
  assert.equal(c.total, 6);
  assert.equal(c.observed, 3);
  assert.equal(c.runtimeUnavailable, 1);
  assert.equal(c.legacy, 2);
  assert.deepEqual(c.distinctShas, ["2460dc3", "62d1c80"]);
  assert.equal(c.hasDegradedRows, true);
});

test("a census of fully attributed rows raises no alarm", () => {
  const c = censusShaAttribution([{ deploymentSha: "62d1c80" }, { deploymentSha: "62d1c80" }]);
  assert.equal(c.hasDegradedRows, false);
  assert.equal(c.runtimeUnavailable, 0);
  assert.equal(c.legacy, 0);
});

test("an empty census reports nothing rather than claiming health", () => {
  const c = censusShaAttribution([]);
  assert.equal(c.total, 0);
  assert.equal(c.observed, 0);
  // No rows means no degraded rows — but also no observed ones, so a caller cannot read this
  // as proof that attribution works.
  assert.equal(c.hasDegradedRows, false);
  assert.deepEqual(c.distinctShas, []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  challengeConfig, deriveChallengeStatus, challengeAcceptsEntries,
  challengeReplay, challengeOutcomeRates, CHALLENGE_PORTFOLIO, PRIMARY_PORTFOLIO,
} from "../lib/paper-challenge.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("independent $10,000 → $100,000 config with a failure floor", () => {
  const cfg = challengeConfig({ PAPER_CHALLENGE_ENABLED: "1" });
  assert.equal(cfg.startingBalanceUsd, 10_000);
  assert.equal(cfg.targetUsd, 100_000);
  assert.equal(cfg.failureFloorUsd, 1_000); // 10% of the stake
  assert.equal(cfg.riskProfile, "aggressive");
  assert.equal(cfg.enabled, true);
});

test("status is deterministic: ACTIVE / TARGET_REACHED / FAILED", () => {
  const cfg = challengeConfig({ PAPER_CHALLENGE_ENABLED: "1" });
  assert.equal(deriveChallengeStatus(10_000, cfg), "ACTIVE");
  assert.equal(deriveChallengeStatus(55_000, cfg), "ACTIVE");
  assert.equal(deriveChallengeStatus(100_000, cfg), "TARGET_REACHED");
  assert.equal(deriveChallengeStatus(120_000, cfg), "TARGET_REACHED");
  assert.equal(deriveChallengeStatus(1_000, cfg), "FAILED");
  assert.equal(deriveChallengeStatus(-500, cfg), "FAILED");
});

test("only ACTIVE accepts entries (never after target or failure)", () => {
  const cfg = challengeConfig({ PAPER_CHALLENGE_ENABLED: "1" });
  assert.equal(challengeAcceptsEntries(50_000, cfg), true);
  assert.equal(challengeAcceptsEntries(100_000, cfg), false);
  assert.equal(challengeAcceptsEntries(500, cfg), false);
  // Disabled → never accepts.
  assert.equal(challengeAcceptsEntries(50_000, challengeConfig({})), false);
});

test("replay reaches the target and LATCHES (no reset / replenishment)", () => {
  const cfg = challengeConfig({ PAPER_CHALLENGE_ENABLED: "1" });
  // Big winners cross $100k, then a loss — status must stay TARGET_REACHED.
  const r = challengeReplay([40_000, 55_000, -30_000], cfg);
  assert.equal(r.status, "TARGET_REACHED");
  assert.equal(r.resolvedAtIndex, 1); // crossed on the 2nd outcome
  assert.equal(r.finalEquity, 105_000); // stops applying deltas after resolution
});

test("replay fails honestly when the account is blown (no reset)", () => {
  const cfg = challengeConfig({ PAPER_CHALLENGE_ENABLED: "1" });
  const r = challengeReplay([-5_000, -4_500, 50_000], cfg); // blows to $500 before the winner
  assert.equal(r.status, "FAILED");
  assert.equal(r.resolvedAtIndex, 1);
  assert.equal(r.finalEquity, 500); // the later winner never applies — account is done
});

test("deterministic target-rate / failure-rate across replays", () => {
  const cfg = challengeConfig({ PAPER_CHALLENGE_ENABLED: "1" });
  const win = challengeReplay([95_000], cfg);
  const bust = challengeReplay([-9_500], cfg);
  const active = challengeReplay([5_000], cfg);
  const rates = challengeOutcomeRates([win, bust, active]);
  assert.equal(rates.runs, 3);
  assert.equal(rates.targetReached, 1);
  assert.equal(rates.failed, 1);
  assert.equal(rates.active, 1);
  assert.equal(rates.targetRatePct, 33.3);
  assert.equal(rates.failureRatePct, 33.3);
});

test("portfolio constants are distinct", () => {
  assert.equal(PRIMARY_PORTFOLIO, "PRIMARY");
  assert.equal(CHALLENGE_PORTFOLIO, "CHALLENGE");
  assert.notEqual(PRIMARY_PORTFOLIO, CHALLENGE_PORTFOLIO);
});

// ── wiring (createPaperTrade needs the DB alias — assert on source) ──
test("Primary options entry mirrors to CHALLENGE with the SAME contract, separate sizing", () => {
  const src = readFileSync(join(root, "lib/paper-engine.ts"), "utf8");
  assert.match(src, /maybeMirrorToChallenge/, "mirror hook present");
  assert.match(src, /optionSymbol: base\.optionSymbol/, "mirror reuses the exact OCC contract");
  assert.match(src, /portfolio: CHALLENGE_PORTFOLIO/, "mirror is tagged CHALLENGE");
  assert.match(src, /PAPER_RISK_PROFILE: challengeConfig\(\)\.riskProfile/, "challenge sizes off its own profile");
  assert.match(src, /riskContext\(portfolio\)/, "risk context scoped per portfolio");
  assert.match(src, /capitalContext\(Date\.now\(\), portfolio\)/, "capital context scoped per portfolio");
});

test("mirror dedups per alert and only opens while ACTIVE", () => {
  const src = readFileSync(join(root, "lib/paper-engine.ts"), "utf8");
  assert.match(src, /WHERE alert_id=\? AND portfolio=\?/, "one challenge position per alert");
  assert.match(src, /challengeAcceptsEntries/, "no entries once target/failure reached");
});

test("API and AI keep Primary and Challenge statistics separate (no contamination)", () => {
  const api = readFileSync(join(root, "app/api/paper/trades/route.ts"), "utf8");
  assert.match(api, /\(t\.portfolio \?\? "PRIMARY"\) === "PRIMARY"/, "primary analytics exclude challenge");
  assert.match(api, /portfolio === "CHALLENGE"/, "challenge analytics are computed separately");
  const q = readFileSync(join(root, "lib/ai/queries.ts"), "utf8");
  assert.match(q, /COALESCE\(p\.portfolio,'PRIMARY'\) = \?/, "AI outcome gathering is portfolio-scoped");
});

test("REGRESSION: challenge has no broker / real-money path (paper only)", () => {
  const chal = readFileSync(join(root, "lib/paper-challenge.ts"), "utf8");
  assert.doesNotMatch(chal, /robinhood|realMoney|placeOrder|liveBroker|executeOrder/i, "no live execution in the challenge");
});

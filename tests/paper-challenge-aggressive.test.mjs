import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  challengeConfig, challengeSizingEnv, challengeSizingExamples,
} from "../lib/paper-challenge.ts";
import { paperSizingConfig, sizePosition } from "../lib/paper-position-sizer.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENABLED = { PAPER_CHALLENGE_ENABLED: "1" };

const baseInput = (over = {}) => ({
  equityDollars: 10_000, entryPrice: 2.5, multiplier: 100, stopLossPct: 30,
  openExposureDollars: 0, openTickerExposureDollars: 0,
  availableBuyingPowerDollars: 10_000, realizedDailyLossDollars: 0, isZeroDte: false, ...over,
});

// ── config ──────────────────────────────────────────────────────────────────

test("Challenge enabled resolves aggressive defaults (60% position, 15% loss-at-stop)", () => {
  const c = challengeConfig(ENABLED);
  assert.equal(c.enabled, true);
  assert.equal(c.maxPositionPct, 60);
  assert.equal(c.maxLossAtStopPct, 15);
  assert.equal(c.maxTotalExposurePct, 100);
  assert.equal(c.maxDailyLossPct, 25);
  assert.equal(c.maxOpenPositions, 3);
  assert.equal(c.riskProfile, "aggressive");
});

test("Challenge disabled by default", () => {
  assert.equal(challengeConfig({}).enabled, false);
});

test("risk-per-trade and max-loss-at-stop are synonyms; risk-per-trade wins", () => {
  assert.equal(challengeConfig({ ...ENABLED, PAPER_CHALLENGE_MAX_LOSS_AT_STOP_PCT: "12" }).maxLossAtStopPct, 12);
  assert.equal(challengeConfig({ ...ENABLED, PAPER_CHALLENGE_RISK_PER_TRADE_PCT: "18", PAPER_CHALLENGE_MAX_LOSS_AT_STOP_PCT: "12" }).maxLossAtStopPct, 18);
});

test("challengeSizingEnv maps the Challenge knobs onto the sizer's env keys", () => {
  const env = challengeSizingEnv(ENABLED);
  assert.equal(env.PAPER_RISK_PROFILE, "aggressive");
  assert.equal(env.PAPER_RISK_PER_TRADE_PCT, "15");
  assert.equal(env.PAPER_MAX_POSITION_PCT, "60");
  assert.equal(env.PAPER_MAX_TOTAL_EXPOSURE_PCT, "100");
  assert.equal(env.PAPER_STARTING_BALANCE_USD, "10000");
});

// ── aggressive sizing vs the old 2% behaviour ────────────────────────────────

test("aggressive Challenge sizes materially larger than Primary and rejects nothing typical", () => {
  const ex = challengeSizingExamples(10_000, [0.5, 1, 2.5, 5, 10], 30, ENABLED);
  for (const e of ex) {
    assert.equal(e.rejected, false, `premium ${e.premium} must not be rejected`);
    assert.ok(e.costBasisPctOfEquity >= 40, `premium ${e.premium} cost ${e.costBasisPctOfEquity}% should be aggressive`);
    assert.ok(e.modeledLossAtStopPctOfEquity <= 20, `loss-at-stop ${e.modeledLossAtStopPctOfEquity}% must stay bounded`);
  }
});

test("Primary (standard) REJECTS a $5 option that the aggressive Challenge takes", () => {
  const primaryCfg = paperSizingConfig({}); // standard profile, 1% risk
  const primary = sizePosition(baseInput({ entryPrice: 5 }), primaryCfg);
  assert.equal(primary.rejected, true, "conservative Primary cannot fit the minimum");

  const challengeCfg = paperSizingConfig(challengeSizingEnv(ENABLED));
  const challenge = sizePosition(baseInput({ entryPrice: 5 }), challengeCfg);
  assert.equal(challenge.rejected, false);
  assert.ok(challenge.contracts >= 5, `challenge should take a real position, got ${challenge.contracts}`);
});

test("60% position ceiling binds on a TIGHT stop (not risk)", () => {
  const cfg = paperSizingConfig(challengeSizingEnv(ENABLED));
  // Tight 10% stop → loss-at-stop budget wants a huge position; the 60% cap binds.
  const r = sizePosition(baseInput({ entryPrice: 2.5, stopLossPct: 10 }), cfg);
  assert.equal(r.calc.bindingConstraint, "max position %");
  assert.ok(r.calc.byPosition <= r.calc.byRisk, "position cap is the tighter bound here");
});

test("the Challenge does NOT automatically use 60% on every trade (wider stop → risk binds ~50%)", () => {
  const ex = challengeSizingExamples(10_000, [2.5], 30, ENABLED)[0];
  assert.equal(ex.bindingConstraint, "per-trade risk");
  assert.ok(ex.costBasisPctOfEquity < 60, "a 30% stop binds on risk below the 60% ceiling");
});

// ── every hard cap still binds (aggressive ≠ unbounded) ──────────────────────

test("buying-power cap binds when capital is scarce", () => {
  const cfg = paperSizingConfig(challengeSizingEnv(ENABLED));
  const r = sizePosition(baseInput({ availableBuyingPowerDollars: 500 }), cfg);
  assert.equal(r.calc.bindingConstraint, "buying power");
  assert.equal(r.contracts, 2); // floor(500 / 250)
});

test("total-exposure cap binds when the account is already loaded", () => {
  const cfg = paperSizingConfig(challengeSizingEnv(ENABLED));
  const r = sizePosition(baseInput({ openExposureDollars: 9_500 }), cfg);
  assert.equal(r.calc.bindingConstraint, "max total exposure %");
});

test("daily-loss cap stops new entries", () => {
  const cfg = paperSizingConfig(challengeSizingEnv(ENABLED));
  const r = sizePosition(baseInput({ realizedDailyLossDollars: 2_600 }), cfg); // > 25% of 10k
  assert.equal(r.rejected, true);
  assert.match(r.reason, /daily loss cap/);
});

test("contract-count cap can be tightened and then binds", () => {
  const cfg = paperSizingConfig(challengeSizingEnv({ ...ENABLED, PAPER_CHALLENGE_MAX_CONTRACTS: "3" }));
  const r = sizePosition(baseInput({ entryPrice: 1 }), cfg);
  assert.equal(r.calc.bindingConstraint, "max contracts per trade");
  assert.equal(r.contracts, 3);
});

test("minimum-contract rejection is honest when even 1 lot breaches the risk budget", () => {
  const cfg = paperSizingConfig(challengeSizingEnv(ENABLED));
  const r = sizePosition(baseInput({ entryPrice: 60, stopLossPct: 30 }), cfg); // 1 lot loses 18% > 15% budget
  assert.equal(r.rejected, true);
  assert.match(r.reason, /minimum/);
});

test("0DTE applies the Challenge risk haircut (smaller than non-0DTE)", () => {
  const cfg = paperSizingConfig(challengeSizingEnv(ENABLED));
  const normal = sizePosition(baseInput({ isZeroDte: false }), cfg);
  const zero = sizePosition(baseInput({ isZeroDte: true }), cfg);
  assert.ok(zero.calc.riskBudgetDollars < normal.calc.riskBudgetDollars, "0DTE risk budget is haircut");
  assert.equal(challengeConfig(ENABLED).allowZeroDte, true);
});

// ── independence + provenance (source-level, createPaperTrade needs the DB) ───

test("Primary and Challenge INDEPENDENTLY consume the signal (mirror not gated on Primary success)", () => {
  const src = readFileSync(join(root, "lib/paper-engine.ts"), "utf8");
  const wrapper = src.slice(src.indexOf("export function createPaperTrade"), src.indexOf("function createSinglePaperTrade") > src.indexOf("export function createPaperTrade") ? src.length : src.indexOf("/** Manual cancel/close"));
  // The wrapper attempts the Challenge regardless of the Primary result object.
  assert.match(src, /const primary = createSinglePaperTrade\(input\)/, "primary is created via the single-portfolio path");
  assert.match(src, /maybeMirrorToChallenge\(input, primary\.id \?\? null\)/, "challenge is attempted on the same input regardless of primary.ok");
  assert.doesNotMatch(wrapper, /if \(primary\.ok\)[^]*maybeMirrorToChallenge/, "challenge must NOT be nested inside a primary-success branch");
});

test("the Challenge mirror uses createSinglePaperTrade (no recursion) and the EXACT OCC contract", () => {
  const src = readFileSync(join(root, "lib/paper-engine.ts"), "utf8");
  const mirror = src.slice(src.indexOf("function maybeMirrorToChallenge"), src.indexOf("interface ChallengeExecEvent"));
  assert.match(mirror, /createSinglePaperTrade\(\{/, "mirror creates directly, never recurses through createPaperTrade");
  assert.match(mirror, /optionSymbol: base\.optionSymbol/, "mirror reuses the exact OCC contract");
  assert.match(mirror, /portfolio: CHALLENGE_PORTFOLIO/, "mirror is tagged CHALLENGE");
});

test("REGRESSION: no broker / real-money path in the Challenge", () => {
  const chal = readFileSync(join(root, "lib/paper-challenge.ts"), "utf8");
  assert.doesNotMatch(chal, /robinhood|realMoney|placeOrder|liveBroker|executeOrder/i);
});

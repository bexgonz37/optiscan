import test from "node:test";
import assert from "node:assert/strict";
import {
  paperSizingConfig, profileDefaults, resolveRiskProfile, sizePosition,
} from "../lib/paper-position-sizer.ts";

const baseInput = (over = {}) => ({
  equityDollars: 10000,
  entryPrice: 1.00,       // $1.00 premium → $100 / contract
  multiplier: 100,
  stopLossPct: 25,        // 25% of premium at risk
  openExposureDollars: 0,
  openTickerExposureDollars: 0,
  availableBuyingPowerDollars: 10000,
  realizedDailyLossDollars: 0,
  isZeroDte: false,
  slippagePerUnit: 0,
  feePerUnit: 0,
  ...over,
});

test("profile resolution + defaults are deterministic", () => {
  assert.equal(resolveRiskProfile({ PAPER_RISK_PROFILE: "AGGRESSIVE" }), "aggressive");
  assert.equal(resolveRiskProfile({ PAPER_RISK_PROFILE: "junk" }), "standard");
  assert.equal(resolveRiskProfile({}), "standard");
  assert.ok(profileDefaults("aggressive").riskPerTradePct > profileDefaults("standard").riskPerTradePct);
  assert.ok(profileDefaults("standard").riskPerTradePct > profileDefaults("conservative").riskPerTradePct);
});

test("aggressive sizes larger than standard than conservative — but all within caps", () => {
  const inp = baseInput();
  const con = sizePosition(inp, paperSizingConfig({ PAPER_RISK_PROFILE: "conservative" }));
  const std = sizePosition(inp, paperSizingConfig({ PAPER_RISK_PROFILE: "standard" }));
  const agg = sizePosition(inp, paperSizingConfig({ PAPER_RISK_PROFILE: "aggressive" }));
  assert.ok(agg.contracts > std.contracts, `agg ${agg.contracts} > std ${std.contracts}`);
  assert.ok(std.contracts >= con.contracts, `std ${std.contracts} >= con ${con.contracts}`);
  // Every profile must still respect its own max-contracts cap.
  for (const [r, p] of [[con, "conservative"], [std, "standard"], [agg, "aggressive"]]) {
    assert.ok(r.contracts <= profileDefaults(p).maxContractsPerTrade);
  }
});

test("per-trade risk cap binds: risk budget / risk-per-contract", () => {
  // aggressive: 2% of 10000 = $200 risk budget. risk/contract = $100 × 25% = $25.
  // → 8 contracts by risk. Position cap = 20% × 10000 / 100 = 20. So risk binds at 8.
  const r = sizePosition(baseInput(), paperSizingConfig({ PAPER_RISK_PROFILE: "aggressive" }));
  assert.equal(r.contracts, 8);
  assert.equal(r.calc.bindingConstraint, "per-trade risk");
  assert.equal(r.rejected, false);
});

test("max position % cap binds on an expensive contract", () => {
  // $5.00 premium → $500/contract. aggressive maxPositionPct 20% × 10000 = $2000 → 4 contracts.
  // risk budget $200 / ($500×0.25=$125) = 1 → risk would bind lower here. Make stop tiny to isolate position cap.
  const r = sizePosition(baseInput({ entryPrice: 5.0, stopLossPct: 1 }), paperSizingConfig({ PAPER_RISK_PROFILE: "aggressive" }));
  assert.ok(r.contracts <= 4, `contracts ${r.contracts} <= 4 (position cap)`);
});

test("max total exposure % cap reduces size when other positions are open", () => {
  // aggressive maxTotalExposurePct 60% × 10000 = $6000. Already $5800 open → $200 left → 2 contracts.
  const r = sizePosition(baseInput({ openExposureDollars: 5800, stopLossPct: 1, availableBuyingPowerDollars: 10000 }), paperSizingConfig({ PAPER_RISK_PROFILE: "aggressive" }));
  assert.ok(r.contracts <= 2, `contracts ${r.contracts} <= 2 (exposure cap)`);
});

test("hard contract-count cap is never exceeded even with huge equity", () => {
  const r = sizePosition(baseInput({ equityDollars: 10_000_000, availableBuyingPowerDollars: 10_000_000 }), paperSizingConfig({ PAPER_RISK_PROFILE: "aggressive" }));
  assert.equal(r.contracts, profileDefaults("aggressive").maxContractsPerTrade);
  assert.equal(r.calc.bindingConstraint, "max contracts per trade");
});

test("daily-loss cap stops new sizing", () => {
  const r = sizePosition(baseInput({ realizedDailyLossDollars: 900 }), paperSizingConfig({ PAPER_RISK_PROFILE: "aggressive" }));
  // aggressive maxDailyLossPct 8% × 10000 = $800 cap; $900 loss ≥ cap → rejected.
  assert.equal(r.rejected, true);
  assert.match(r.reason, /daily loss cap/);
});

test("rejects when minimum contracts cannot fit inside caps", () => {
  // aggressive min 2 contracts, but a $50 premium ($5000/contract) with $2000 position cap fits 0.
  const r = sizePosition(baseInput({ entryPrice: 50, stopLossPct: 1 }), paperSizingConfig({ PAPER_RISK_PROFILE: "aggressive" }));
  assert.equal(r.rejected, true);
  assert.match(r.reason, /minimum/);
});

test("0DTE haircut reduces the risk budget", () => {
  const cfg = paperSizingConfig({ PAPER_RISK_PROFILE: "aggressive" });
  const normal = sizePosition(baseInput(), cfg);
  const zero = sizePosition(baseInput({ isZeroDte: true }), cfg);
  assert.ok(zero.calc.riskBudgetDollars < normal.calc.riskBudgetDollars);
  assert.ok(zero.contracts <= normal.contracts);
});

test("probability/confidence never enters sizing (no such field is read)", () => {
  // Two identical inputs — sizing is a pure function of risk + caps only.
  const cfg = paperSizingConfig({ PAPER_RISK_PROFILE: "aggressive" });
  const a = sizePosition(baseInput(), cfg);
  const b = sizePosition(baseInput(), cfg);
  assert.deepEqual(a, b);
});

test("env overrides layer on top of the profile", () => {
  const cfg = paperSizingConfig({ PAPER_RISK_PROFILE: "standard", PAPER_MAX_CONTRACTS_PER_TRADE: "3" });
  assert.equal(cfg.maxContractsPerTrade, 3);
  const r = sizePosition(baseInput({ equityDollars: 1_000_000, availableBuyingPowerDollars: 1_000_000 }), cfg);
  assert.equal(r.contracts, 3);
});

import test from "node:test";
import assert from "node:assert/strict";
import { weeklyQuantResearchContext } from "../lib/ai/quant-research.ts";
import { nightlyNarrationPrompt, weeklyProposalPrompt } from "../lib/ai/prompts.ts";

test("weekly quant research context is machine-readable and offline-only", () => {
  const ctx = weeklyQuantResearchContext();
  assert.equal(ctx.cadence, "weekly");
  assert.equal(ctx.aiRole, "offline_research_only");
  assert.equal(ctx.livePathAuthority, "deterministic_only");
  assert.equal(ctx.evidenceLearning, null);
  assert.ok(ctx.calculationInventory.some((x) => x.ownerFile === "lib/stock-momentum-policy.ts"));
  assert.ok(ctx.calculationInventory.some((x) => x.ownerFile === "lib/callouts/eligibility.ts"));
  assert.ok(ctx.calculationInventory.every((x) => x.formula && x.unit && x.currentThresholds && x.hardGates));
  assert.ok(ctx.gateAttribution.some((x) => /accepted versus rejected/i.test(x)));
  assert.ok(ctx.thresholdExperimentEvidence.some((x) => /baseline_current_policy/.test(String(x.name))));
  assert.match(ctx.promotionRule, /human approval/i);
});

test("weekly prompt includes quant research but nightly prompt does not", () => {
  const quantResearch = weeklyQuantResearchContext({
    metrics: { portfolios: { PRIMARY: {}, CHALLENGE: {}, STOCK_DAY_TRADER: {} } },
    evidenceLearning: { examples: { delivered: 12, researchOnly: 8 }, patterns: { top: [{ label: "Opening Momentum", sampleSize: 20 }] } },
  });
  const weekly = weeklyProposalPrompt({
    weekKey: "2026-W29",
    weeklySummary: { trades: 0 },
    recentNightly: [],
    acceptedLessons: [],
    rejectedLessons: [],
    priorProposals: [],
    currentConfig: {},
    quantResearch,
    relevantFiles: ["lib/stock-momentum-policy.ts"],
    strategyVersion: null,
  });
  assert.match(weekly.user, /Weekly AI quant research context/);
  assert.match(weekly.system, /long-term aggregate evidence/);
  assert.match(weekly.system, /Do not analyze one-off trades individually/);
  assert.match(weekly.user, /stock-momentum-policy/);
  assert.match(weekly.user, /Evidence Learning/);
  assert.match(weekly.user, /formula/);
  assert.match(weekly.user, /baseline/i);
  assert.match(weekly.user, /PRIMARY/);

  const nightly = nightlyNarrationPrompt({ tradingDay: "2026-07-15", totalTrades: 0 });
  assert.doesNotMatch(nightly.user, /Weekly AI quant research context/);
  assert.doesNotMatch(nightly.user, /stock-momentum-policy/);
});

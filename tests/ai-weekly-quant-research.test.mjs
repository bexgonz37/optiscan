import test from "node:test";
import assert from "node:assert/strict";
import { weeklyQuantResearchContext } from "../lib/ai/quant-research.ts";
import { nightlyNarrationPrompt, weeklyProposalPrompt } from "../lib/ai/prompts.ts";

test("weekly quant research context is machine-readable and offline-only", () => {
  const ctx = weeklyQuantResearchContext();
  assert.equal(ctx.cadence, "weekly");
  assert.equal(ctx.aiRole, "offline_research_only");
  assert.equal(ctx.livePathAuthority, "deterministic_only");
  assert.ok(ctx.calculationInventory.some((x) => x.ownerFile === "lib/stock-momentum-policy.ts"));
  assert.ok(ctx.calculationInventory.some((x) => x.ownerFile === "lib/callouts/eligibility.ts"));
  assert.match(ctx.promotionRule, /human approval/i);
});

test("weekly prompt includes quant research but nightly prompt does not", () => {
  const quantResearch = weeklyQuantResearchContext();
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
  assert.match(weekly.user, /stock-momentum-policy/);

  const nightly = nightlyNarrationPrompt({ tradingDay: "2026-07-15", totalTrades: 0 });
  assert.doesNotMatch(nightly.user, /Weekly AI quant research context/);
  assert.doesNotMatch(nightly.user, /stock-momentum-policy/);
});

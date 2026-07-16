export interface QuantCalculationInventoryItem {
  scanner: "stock" | "options" | "paper";
  name: string;
  unit: string;
  ownerFile: string;
  purpose: string;
}

export interface WeeklyQuantResearchContext {
  cadence: "weekly";
  aiRole: "offline_research_only";
  livePathAuthority: "deterministic_only";
  calculationInventory: QuantCalculationInventoryItem[];
  gateTraceRequired: string[];
  experimentRules: string[];
  promotionRule: string;
}

export function weeklyQuantResearchContext(): WeeklyQuantResearchContext {
  return {
    cadence: "weekly",
    aiRole: "offline_research_only",
    livePathAuthority: "deterministic_only",
    calculationInventory: [
      { scanner: "stock", name: "broadStockEligibility", unit: "dollars, shares, percent", ownerFile: "lib/stock-momentum-policy.ts", purpose: "price band, cumulative day volume, and prior-close gain floor" },
      { scanner: "stock", name: "fastStockMomentumEligibility", unit: "percent returns, percent/min, shares/sec", ownerFile: "lib/stock-momentum-policy.ts", purpose: "current bullish momentum evidence for stock alerts" },
      { scanner: "stock", name: "classifyStockMomentum", unit: "classifier labels", ownerFile: "lib/stock-momentum-classifier.ts", purpose: "suppress slow grinders, late exhaustion, and illiquid spikes" },
      { scanner: "options", name: "contractEntryGate", unit: "spread percent, delta, DTE, premium economics", ownerFile: "lib/zero-dte.ts", purpose: "verified option contract tradability" },
      { scanner: "options", name: "nowOnlyActionable", unit: "gate verdict", ownerFile: "lib/callouts/eligibility.ts", purpose: "private Discord and paper eligibility boundary" },
      { scanner: "paper", name: "sizePosition", unit: "dollars, percent caps, contracts/shares", ownerFile: "lib/paper-position-sizer.ts", purpose: "deterministic paper sizing for portfolio experiments" },
    ],
    gateTraceRequired: [
      "record pass/fail reason for each deterministic setup gate",
      "preserve units for thresholds and observed values",
      "separate stock, primary options, challenge, and stock-day portfolios",
      "never infer missing quotes, fills, greeks, volume, or open interest",
    ],
    experimentRules: [
      "baseline and challenger must run side by side on the same frozen deterministic inputs",
      "challenger proposals must include required tests, shadow or replay plan, rollback plan, and evidence threshold",
      "AI proposals remain pending until human approval promotes a deterministic change",
    ],
    promotionRule: "AI may propose threshold experiments weekly, but only deterministic code/config with tests can be promoted after human approval.",
  };
}

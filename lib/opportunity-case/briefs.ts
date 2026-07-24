/**
 * Deterministic morning brief / EOD review summaries — no invented narratives.
 */
import type { OpportunityCase } from "./schema.ts";

export interface BriefSection {
  title: string;
  items: string[];
}

export interface OperatingBrief {
  schemaVersion: 1;
  kind: "morning" | "live" | "eod";
  generatedAtMs: number;
  sections: BriefSection[];
  disclaimer: string;
}

const DISCLAIMER = "Informational summary of deterministic records only. Not financial advice.";

export function buildMorningBrief(cases: OpportunityCase[], regimeLabel: string | null): OperatingBrief {
  const sections: BriefSection[] = [
    {
      title: "Market regime",
      items: regimeLabel ? [regimeLabel] : ["Regime data unavailable — UNKNOWN"],
    },
    {
      title: "Watchlist setups",
      items: cases.filter((c) => c.acceptanceDecision === "accepted").slice(0, 5).map((c) => `${c.underlyingSymbol} ${c.setupFamily ?? "setup"}`),
    },
    {
      title: "Risks",
      items: cases.flatMap((c) => c.hardGateResults.filter((g) => !g.passed).map((g) => g.explanation)).slice(0, 5),
    },
  ];
  if (sections[1].items.length === 0) sections[1].items.push("No accepted setups in recent window");
  if (sections[2].items.length === 0) sections[2].items.push("No hard-gate failures in recent window");
  return { schemaVersion: 1, kind: "morning", generatedAtMs: Date.now(), sections, disclaimer: DISCLAIMER };
}

export function buildEodReview(cases: OpportunityCase[], delivered: number, rejected: number): OperatingBrief {
  return {
    schemaVersion: 1,
    kind: "eod",
    generatedAtMs: Date.now(),
    sections: [
      { title: "Delivered alerts", items: [`${delivered} delivered in review window`] },
      { title: "Rejected opportunities", items: [`${rejected} rejected`, ...cases.filter((c) => c.deliveryDecision === "rejected").slice(0, 5).map((c) => `${c.underlyingSymbol}: ${c.rejectionReasonCodes.join(", ") || "rejected"}`)] },
      { title: "Monitor tomorrow", items: ["Review pipeline health diagnostics", "Check calibration drift if samples available"] },
    ],
    disclaimer: DISCLAIMER,
  };
}

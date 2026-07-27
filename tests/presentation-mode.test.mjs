import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Desktop Simple/Advanced presentation spec (source-spec — client components).
 * Locks: one global localStorage preference, both modes render the SAME shared
 * TradeExplanation object, and Advanced is purely additive (never a different
 * data source or different trading logic).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("usePresentationMode defaults to simple and persists via dashboard-prefs", () => {
  const src = read("hooks/usePresentationMode.ts");
  assert.ok(/DEFAULT_PRESENTATION_MODE/.test(src), "uses the shared default");
  assert.ok(/saveDashboardPrefs\(\{ presentation: mode \}\)/.test(src), "persists to localStorage prefs");
  assert.ok(/"presentation only"|PRESENTATION ONLY/i.test(src), "documents presentation-only intent");
});

test("dashboard-prefs defines a simple|advanced presentation preference, default simple", () => {
  const prefs = read("lib/dashboard-prefs.ts");
  assert.ok(/PresentationMode = "simple" \| "advanced"/.test(prefs), "typed pref");
  assert.ok(/DEFAULT_PRESENTATION_MODE: PresentationMode = "simple"/.test(prefs), "default simple");
  assert.ok(/presentation\?: PresentationMode/.test(prefs), "stored on DashboardPrefs");
});

test("TradeExplanationCard renders from the object; Advanced is additive only", () => {
  const src = read("components/TradeExplanationCard.tsx");
  // Simple always shows the plain fields.
  for (const field of ["whyNow", "riskSummary", "wouldImproveIf", "invalidatedIf", "evidenceSummary"]) {
    assert.ok(src.includes(field), `Simple view must show ${field}`);
  }
  // Advanced adds the disclosure + selectedBecause, gated on mode === "advanced".
  assert.ok(/const advanced = mode === "advanced"/.test(src), "mode selects detail only");
  assert.ok(/selectedBecause/.test(src) && /Advanced metrics/.test(src), "advanced-only sections");
  // No trading logic / provider calls / scoring here — pure rendering.
  assert.ok(!/selectContract|polyFetch|place_option_order|fetch\(/.test(src), "no logic in the renderer");
});

test("NOW page is the terminal decision screen (presentation toggle lives elsewhere)", () => {
  const now = read("components/NowPage.tsx");
  assert.ok(/\/api\/now/.test(now), "uses canonical snapshot");
  assert.ok(/TRADE_NOW|ALMOST_READY|Open positions/.test(now), "trader panels present");
  assert.ok(!/place_option_order|polyFetch/.test(now), "no trading/provider calls");
});

test("ChartPanel surfaces the same selection explanation object in the reality check", () => {
  const cp = read("components/ChartPanel.tsx");
  assert.ok(/reality\?\.explanation/.test(cp), "reads the selection explanation from the options endpoint");
  assert.ok(/TradeExplanationCard/.test(cp), "renders the shared card");
  assert.ok(/usePresentationMode/.test(cp), "honors the global mode");
});

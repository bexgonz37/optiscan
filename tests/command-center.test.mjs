import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Command Center spec (Phase 6). Source-spec (client component). Locks the
 * required sections, the calm/stable contract, and that it reads persisted
 * opportunities rather than re-ranking a live grid.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("home page renders the Command Center, not the live scanner grid", () => {
  const page = read("app/page.tsx");
  assert.ok(/CommandCenter/.test(page), "home must render CommandCenter");
  assert.ok(!/LivePageTabs/.test(page), "live scanner grid must not be the home page");
});

test("Command Center has all seven required sections", () => {
  const cc = read("components/CommandCenter.tsx");
  for (const section of [
    "Actionable Now",
    "Near Trigger",
    "Developing Setups",
    "Open Paper Trades",
    "Extended or Invalidated",
    "Recent Alerts",
  ]) {
    assert.ok(cc.includes(section), `missing section: ${section}`);
  }
  // status bar with the six required signals
  for (const cell of ["Session", "Provider", "Freshness", "Scanner", "Discord", "Paper"]) {
    assert.ok(cc.includes(cell), `status bar missing: ${cell}`);
  }
});

test("Command Center reads persisted opportunity buckets (stable, not re-ranked live)", () => {
  const cc = read("components/CommandCenter.tsx");
  assert.ok(/\/api\/opportunities/.test(cc), "must read persisted opportunities");
  assert.ok(/ACTIONABLE|NEAR_TRIGGER|DEVELOPING|EXTENDED_OR_INVALID/.test(cc), "must consume lifecycle buckets");
  assert.ok(/cards do not re-rank/i.test(cc), "must document the calm/stable intent");
});

test("Command Center is read-only (no order placement, no provider calls)", () => {
  const cc = read("components/CommandCenter.tsx");
  assert.ok(!/place_equity_order|place_option_order|polyFetch/.test(cc), "must not trade or call providers directly");
});

test("live scanner is preserved at /scanner", () => {
  const scanner = read("app/scanner/page.tsx");
  assert.ok(/LivePageTabs/.test(scanner), "/scanner must render the full live scanner");
  assert.ok(!/redirect\(/.test(scanner), "/scanner is now a real page, not a redirect");
});
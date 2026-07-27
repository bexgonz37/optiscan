import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("home page renders the Command Center, not the live scanner grid", () => {
  const page = read("app/page.tsx");
  assert.ok(/CommandCenter/.test(page), "home must render CommandCenter");
  assert.ok(!/LivePageTabs/.test(page), "live scanner grid must not be the home page");
});

test("Command Center has independent-first sections", () => {
  const cc = read("components/CommandCenter.tsx");
  for (const section of [
    "What is working right now",
    "Independent Options",
    "Paper Trading",
    "Content Engine",
    "Subscriber Readiness",
    "Optional stock scanner",
  ]) {
    assert.ok(cc.includes(section), `missing section: ${section}`);
  }
});

test("Command Center reads authenticated command-center snapshot", () => {
  const cc = read("components/CommandCenter.tsx");
  assert.ok(/\/api\/command-center/.test(cc), "must use canonical command-center API");
  assert.ok(/scanHeaders/.test(cc), "must send scan token");
  assert.ok(/cache:\s*[\"']no-store[\"']/.test(cc), "must disable fetch cache");
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

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("home page renders the NOW page, not the live scanner grid", () => {
  const page = read("app/page.tsx");
  assert.ok(/NowPage/.test(page), "home must render NowPage");
  assert.ok(!/LivePageTabs/.test(page), "live scanner grid must not be the home page");
});

test("NOW page has decision-first sections", () => {
  const now = read("components/NowPage.tsx");
  for (const section of [
    "TRADE_NOW",
    "ALMOST_READY",
    "TOMORROW",
    "AVOID",
    "Open positions",
    "heroTitle",
    "operatingLabel",
  ]) {
    assert.ok(now.includes(section), `missing section: ${section}`);
  }
});

test("NOW page reads authenticated /api/now snapshot", () => {
  const now = read("components/NowPage.tsx");
  assert.ok(/\/api\/now/.test(now), "must use canonical now API");
  assert.ok(/scanHeaders/.test(now), "must send scan token");
  assert.ok(/cache:\s*[\"']no-store[\"']/.test(now), "must disable fetch cache");
});

test("NOW page is read-only (no order placement, no provider calls)", () => {
  const now = read("components/NowPage.tsx");
  assert.ok(!/place_equity_order|place_option_order|polyFetch/.test(now), "must not trade or call providers directly");
});

test("live scanner is preserved at /scanner", () => {
  const scanner = read("app/scanner/page.tsx");
  assert.ok(/LivePageTabs/.test(scanner), "/scanner must render the full live scanner");
  assert.ok(!/redirect\(/.test(scanner), "/scanner is now a real page, not a redirect");
});

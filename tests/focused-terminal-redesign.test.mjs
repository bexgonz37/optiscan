import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("Quant default is decision-oriented and advanced contains raw breakdowns", () => {
  const page = read("app/quant/page.tsx");
  for (const heading of ["Summary", "What is working", "What is failing", "What to test next", "Formula Lab", "Winner discovery", "Data completeness"]) {
    assert.match(page, new RegExp(heading, "i"));
  }
  assert.match(page, /row\.n >= 5/);
  assert.match(page, /SHADOW ONLY/);
  assert.match(page, /Nothing on this page changes production rules automatically/);
  assert.match(page, /advanced \? \(/);
});

test("NOW setup cards use plain contracts and retain raw OCC only in backend data", () => {
  const card = read("components/NowPage.tsx");
  const route = read("app/api/now/route.ts");
  const ranked = read("lib/research/options/ranked-setups.ts");
  assert.match(card, /Contract pending verification/);
  assert.match(card, /Waiting for:/);
  assert.match(card, /Why:/);
  assert.doesNotMatch(card, /cc-term-mono[^]*card\.contract/);
  assert.match(route, /humanContractLabel/);
  assert.match(route, /contract: decision\.executable \? s\.contract : null/);
  assert.match(route, /href: s\.href/);
  assert.match(ranked, /opportunityCaseId/);
});

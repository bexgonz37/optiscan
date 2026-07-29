import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bearishResearchOpeningBalanceUsd,
  deliveredOptionsOpeningBalanceUsd,
  resolveAccountKeyForOptionsPaperKind,
  zeroDteResearchOpeningBalanceUsd,
} from "../lib/broker/accounts.ts";
import { bearishResearchPaperConfig } from "../lib/research/options/bearish-research-paper.ts";
import { zeroDteResearchConfig } from "../lib/research/options/zero-dte-research/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("paper options lanes have explicit account identities and balances", () => {
  assert.equal(zeroDteResearchOpeningBalanceUsd({}), 100_000);
  assert.equal(zeroDteResearchConfig({}).startingBalanceUsd, 100_000);
  assert.equal(deliveredOptionsOpeningBalanceUsd({}), 100_000);
  assert.equal(bearishResearchOpeningBalanceUsd({}), 100_000);
  assert.equal(bearishResearchPaperConfig({}).startingBalanceUsd, 100_000);
  assert.equal(bearishResearchPaperConfig({}).enabled, false);
  assert.equal(resolveAccountKeyForOptionsPaperKind("DELIVERED_ALERT_PAPER"), "subscriber_paper");
  assert.equal(resolveAccountKeyForOptionsPaperKind("ZERO_DTE_RESEARCH_PAPER"), "zero_dte_research");
  assert.equal(resolveAccountKeyForOptionsPaperKind("BEARISH_RESEARCH_PAPER"), "bearish_research");
  assert.equal(resolveAccountKeyForOptionsPaperKind("RESEARCH_ONLY_PAPER"), "research_shadow");
});

test("paper UI and API keep stock, legacy, 0DTE, delivered, and bearish balances separate", () => {
  const route = read("app/api/paper/trades/route.ts");
  const page = read("app/paper/page.tsx");
  assert.match(route, /PAPER_STOCK_DAY_STARTING_BALANCE_USD \?\? 10_000/);
  assert.match(route, /stockLane:/);
  assert.match(route, /legacyLane:/);
  assert.match(page, /Aggressive 0DTE Research/);
  assert.match(page, /zeroDte\.config\?\.startingBalanceUsd/);
  assert.match(page, /Bearish Research Paper/);
  assert.match(page, /Delivered Options Paper/);
  assert.match(page, /Stock Paper/);
  assert.match(page, /Legacy Paper start/);
});

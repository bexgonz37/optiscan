import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loop = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");

test("discovery uses the fresh-acceleration ranking (not raw day-move sort)", () => {
  assert.match(loop, /rankDiscovery\(quotes, s\.discoveryPrev, nowMs\)/, "discovery routes through rankDiscovery");
  assert.match(loop, /promotionSet\(ranked\)/, "promotion set includes immediate promotes");
  assert.match(loop, /discoveryPrev = new Map/, "previous snapshot is tracked for Δmove/min");
  // The old raw-move discovery sort must be gone.
  assert.doesNotMatch(loop, /Math\.min\(move, 6\) \* 8 \+ volume \* 5/, "legacy day-move-only score removed");
});

test("the fresh-mover class gate suppresses slow/late/noisy live stock alerts", () => {
  assert.match(loop, /freshMoverGateAllowed\(stockClass\.classification\)/, "class gate evaluated");
  assert.match(loop, /stockEnabled && stockClassGate\.allowed/, "stock alert only fires when the class is allowed");
  assert.match(loop, /CLASS_SUPPRESSED/, "suppressed alerts are recorded as a visible diagnostic");
});

test("recent trailing returns feed the classifier (slow-grinder / late-top awareness)", () => {
  assert.match(loop, /ret10sPct: ret10s/, "ret10s passed to classifier");
  assert.match(loop, /ret30sPct: ret30s/, "ret30s passed to classifier");
  assert.match(loop, /ret60sPct: ret60s/, "ret60s passed to classifier");
});

test("REGRESSION: no LLM/AI in the live scanner decision path", () => {
  assert.doesNotMatch(loop, /from "@\/lib\/ai\//, "scanner-loop must not import the AI layer");
  assert.doesNotMatch(loop, /anthropic|openai|callModel|generateText/i, "no model calls in the live loop");
});

test("REGRESSION: options 0DTE path is unaffected by the stock class gate", () => {
  // The gate only guards handleStockTrigger; the options trigger fires on `fired` alone.
  assert.match(loop, /if \(fired && session === "regular"\) tasks\.push\(handleTrigger/, "options trigger unchanged");
});

test("alert-earliness is fed into the nightly AI digest (deterministic, post-hoc)", () => {
  const nightly = readFileSync(join(root, "lib/ai/nightly-summary.ts"), "utf8");
  assert.match(nightly, /Alert earliness:/, "earliness surfaced in the nightly patterns");
  const diag = readFileSync(join(root, "lib/momentum-diagnostics.ts"), "utf8");
  assert.match(diag, /summarizeEarliness/, "diagnostics summary computes earliness");
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectMajorMove, MAJOR_MOVE_CORE_MIN_PCT } from "../lib/major-move.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The exact scenario the scanner missed: META grinding a big day on huge
 * dollars with NO 10-second burst. Day-timeframe detection must flag it. */
const META_GRIND = {
  symbol: "META", price: 720, movePct: 3.1, volume: 18_000_000, // ~$13B traded
  relVol: 1.8, aboveVwap: true, core: true,
};

test("META-style large-cap grind IS detected (the miss, fixed)", () => {
  const r = detectMajorMove(META_GRIND);
  assert.equal(r.detected, true);
  assert.equal(r.status, "detected");
  assert.equal(r.direction, "up");
  assert.ok(r.why.some((w) => /day move 3.1%/.test(w)));
  assert.ok(r.why.some((w) => /M traded/.test(w)));
});

test("very extended large-cap move is flagged EXTENDED — do not chase", () => {
  const r = detectMajorMove({ ...META_GRIND, movePct: 5.2 });
  assert.equal(r.status, "extended");
  assert.ok(r.why.some((w) => /do not chase/.test(w)));
});

test("downside grind detects with direction=down", () => {
  const r = detectMajorMove({ ...META_GRIND, movePct: -2.8, aboveVwap: false });
  assert.equal(r.detected, true);
  assert.equal(r.direction, "down");
});

test("market-cap awareness: a 3% move qualifies a core name, not a runner", () => {
  assert.equal(detectMajorMove(META_GRIND).detected, true);
  const runner = { ...META_GRIND, symbol: "XYZ", core: false, price: 8, volume: 5_000_000 };
  assert.equal(detectMajorMove(runner).detected, false, "3% on a runner is noise, needs 5%+");
  assert.equal(detectMajorMove({ ...runner, movePct: 6.5, relVol: 2.5 }).detected, true);
});

test("dollar-volume floor blocks % moves without real money behind them", () => {
  const thin = { ...META_GRIND, volume: 100_000 }; // ~$72M < $150M core floor
  const r = detectMajorMove(thin);
  assert.equal(r.detected, false);
  assert.ok(r.failed.some((f) => /floor/.test(f)));
});

test("VWAP against the move blocks detection (grind unconfirmed)", () => {
  const r = detectMajorMove({ ...META_GRIND, aboveVwap: false });
  assert.equal(r.detected, false);
  assert.ok(r.failed.some((f) => /VWAP against/.test(f)));
});

test("small day moves never trip it — this is not a lowered threshold", () => {
  const r = detectMajorMove({ ...META_GRIND, movePct: 1.2 });
  assert.equal(r.detected, false);
  assert.ok(MAJOR_MOVE_CORE_MIN_PCT >= 2, "core bar must stay meaningful");
});

test("scanner loop wires the detector without touching burst gates (source spec)", () => {
  const src = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");
  assert.ok(src.includes("detectMajorMove"), "loop must run day-timeframe detection");
  assert.ok(src.includes("majorMoves: s.majorMoves.slice(0, 12)"), "loopState must expose majorMoves");
  assert.ok(src.includes("const fired = persistOk && accelOk && tapeMoving && shouldTriggerOk"),
    "burst fire condition must remain unchanged");
  const majorIdx = src.indexOf("detectMajorMove({");
  const region = src.slice(majorIdx, majorIdx + 1200);
  assert.ok(!region.includes("handleTrigger("), "major-move detection must NOT call the BUY trigger path");
});

test("diagnostics endpoint exists, is token-gated, and hides nothing", () => {
  const src = readFileSync(join(root, "app/api/diagnostics/alert-decision/route.ts"), "utf8");
  assert.ok(src.includes("checkApiToken"));
  assert.ok(src.includes("rulesFailed"), "failed rules must be reported, never hidden");
  assert.ok(src.includes("reasonNoAlert"));
  assert.ok(/honesty/i.test(src), "10s-vs-1m reconstruction caveat must be stated");
});


// ── Position callouts (the "META mid-July 650C" bridge) ──
test("position callout: major move wires to the longer-dated callout path (source spec)", () => {
  const pc = readFileSync(join(root, "lib/position-callout.ts"), "utf8");
  assert.ok(pc.includes("pickSwingContract"), "must reuse the PROVEN swing contract gates");
  assert.ok(pc.includes("dteMin: 7, dteMax: 35"), "1-5 week horizon");
  assert.ok(pc.includes('captureAction: "WATCH"'), "position ideas are WATCH tier, never scalp BUYs");
  assert.ok(pc.includes("alreadyCalledToday"), "one callout per symbol per day");
  assert.ok(pc.includes("nearMinuteBudget"), "budget-aware");
  assert.ok(pc.includes("Invalidation"), "explanation must state invalidation");
  assert.ok(pc.includes("do not chase"), "extended moves labeled, not hidden");
  const loop = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");
  assert.ok(loop.includes("maybeEmitPositionCallout"), "loop must emit position callouts on major moves");
});

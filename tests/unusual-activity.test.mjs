import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreUnusual,
  detectUnusualContracts,
  DEFAULT_UNUSUAL_CONFIG,
} from "../lib/unusual-activity.js";

function contract(overrides = {}) {
  return {
    optionSymbol: "O:TST260814C00100000",
    side: "call",
    strike: 100,
    expiration: "2026-08-14",
    dte: 20,
    bid: 1.0,
    ask: 1.1,
    mid: 1.05,
    volume: 2000,
    openInterest: 500,
    iv: 0.6,
    delta: 0.35,
    spreadPct: 9.5,
    underlyingPrice: 99,
    ...overrides,
  };
}

test("scoreUnusual: higher vol/OI ratio scores higher", () => {
  const loud = scoreUnusual(contract({ volume: 4000, openInterest: 500 })); // 8x
  const quiet = scoreUnusual(contract({ volume: 600, openInterest: 500 })); // 1.2x
  assert.ok(loud.score > quiet.score);
  assert.ok(loud.score <= 100 && quiet.score >= 0);
});

test("scoreUnusual: zero OI with volume = new positioning, finite score", () => {
  const s = scoreUnusual(contract({ volume: 1500, openInterest: 0 }));
  assert.equal(s.ratio, Infinity);
  assert.ok(Number.isFinite(s.score));
  assert.ok(s.reasons.some((r) => r.includes("new positioning")));
});

test("scoreUnusual rewards tight spreads", () => {
  const tight = scoreUnusual(contract({ spreadPct: 2 }));
  const wide = scoreUnusual(contract({ spreadPct: 28 }));
  assert.ok(tight.score > wide.score);
});

test("detectUnusualContracts applies floors and ratio gate", () => {
  const chain = [
    contract({ optionSymbol: "HIT", volume: 2000, openInterest: 500 }), // 4x
    contract({ optionSymbol: "THIN", volume: 50 }), // below minVolume
    contract({ optionSymbol: "QUIET", volume: 300, openInterest: 5000 }), // ratio 0.06
    contract({ optionSymbol: "CHEAP", mid: 0.01 }), // below minMid
    contract({ optionSymbol: "WIDE", spreadPct: 55 }), // above maxSpreadPct
  ];
  const hits = detectUnusualContracts(chain, { symbol: "tst" });
  assert.deepEqual(hits.map((h) => h.optionSymbol), ["HIT"]);
  assert.equal(hits[0].symbol, "TST");
  assert.equal(hits[0].volOiRatio, 4);
  assert.equal(hits[0].newPositioning, false);
});

test("detectUnusualContracts caps per-underlying and sorts by score desc", () => {
  const chain = Array.from({ length: 10 }, (_, i) =>
    contract({ optionSymbol: `C${i}`, volume: 1000 + i * 500, openInterest: 400 }),
  );
  const hits = detectUnusualContracts(chain, { symbol: "TST" });
  assert.equal(hits.length, DEFAULT_UNUSUAL_CONFIG.topPerUnderlying);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
});

test("detectUnusualContracts: empty chain -> empty, no throw", () => {
  assert.deepEqual(detectUnusualContracts([], { symbol: "TST" }), []);
  assert.deepEqual(detectUnusualContracts(undefined, { symbol: "TST" }), []);
});

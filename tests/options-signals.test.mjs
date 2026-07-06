import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveDirection,
  selectContract,
  breakeven,
  scoreOptionSignal,
  buildOptionSignal,
} from "../lib/options-signals.js";

function contract(overrides = {}) {
  return {
    optionSymbol: "O:TST260814C00100000",
    side: "call",
    strike: 100,
    expiration: "2026-08-14",
    dte: 20,
    bid: 2.4,
    ask: 2.6,
    mid: 2.5,
    volume: 400,
    openInterest: 800,
    iv: 0.45,
    delta: 0.41,
    spreadPct: 8,
    underlyingPrice: 99,
    ...overrides,
  };
}

test("deriveDirection: bullish / bearish / neutral", () => {
  assert.equal(deriveDirection({ movePct: 2, priceVsVwapPct: 0.5, macd: { bullish: true } }).side, "call");
  assert.equal(deriveDirection({ movePct: -2, priceVsVwapPct: -0.5, macd: { bearish: true } }).side, "put");
  assert.equal(deriveDirection({ movePct: 0 }).side, null);
  // tie broken by move direction
  assert.equal(deriveDirection({ movePct: -1, priceVsVwapPct: 0.5 }).side, "put");
});

test("selectContract filters side, dte, OI, spread", () => {
  const chain = [
    contract(),
    contract({ side: "put", optionSymbol: "P1" }),
    contract({ dte: 60, optionSymbol: "FAR" }),
    contract({ openInterest: 10, optionSymbol: "ILLIQ" }),
    contract({ spreadPct: 40, optionSymbol: "WIDE" }),
    contract({ mid: 0, bid: 0, ask: 0, optionSymbol: "DEAD" }),
  ];
  const pick = selectContract(chain, { side: "call", minOpenInterest: 100, maxSpreadPct: 15, dteMin: 3, dteMax: 45 });
  assert.equal(pick.optionSymbol, "O:TST260814C00100000");
  assert.equal(selectContract(chain, { side: "put", minOpenInterest: 100 }).optionSymbol, "P1");
  assert.equal(selectContract([], { side: "call" }), null);
});

test("selectContract prefers delta closest to target", () => {
  const chain = [
    contract({ delta: 0.9, optionSymbol: "DEEP" }),
    contract({ delta: 0.4, optionSymbol: "TARGET" }),
    contract({ delta: 0.08, optionSymbol: "LOTTO" }),
  ];
  assert.equal(selectContract(chain, { side: "call", targetDelta: 0.4 }).optionSymbol, "TARGET");
});

test("selectContract: missing delta must not beat an on-target real delta", () => {
  const chain = [
    contract({ delta: null, optionSymbol: "NOGREEKS", openInterest: 5000, volume: 5000 }),
    contract({ delta: 0.4, optionSymbol: "REAL" }),
  ];
  const pick = selectContract(chain, { side: "call", targetDelta: 0.4 });
  assert.equal(pick.optionSymbol, "REAL");
});

test("breakeven: strike ± premium", () => {
  assert.equal(breakeven(contract({ side: "call", strike: 100, mid: 2.5 })), 102.5);
  assert.equal(breakeven(contract({ side: "put", strike: 100, mid: 2.5 })), 97.5);
  assert.equal(breakeven(null), null);
});

test("scoreOptionSignal: bounded, warns with no contract, tracks setup strength", () => {
  const none = scoreOptionSignal({ signalScore: 90 }, null, { reasons: [] });
  assert.equal(none.score, 0);
  assert.ok(none.warnings.length > 0);

  const c = { ...contract(), contractScore: 0.8, absDelta: 0.41 };
  const strong = scoreOptionSignal({ signalScore: 90 }, c, { reasons: [] });
  const weak = scoreOptionSignal({ signalScore: 20 }, c, { reasons: [] });
  assert.ok(strong.score > weak.score);
  assert.ok(strong.score <= 100 && weak.score >= 0);
});

test("scoreOptionSignal flags very high IV", () => {
  const c = { ...contract(), contractScore: 0.8, iv: 2.1 }; // 210%
  const { warnings } = scoreOptionSignal({ signalScore: 70 }, c, { reasons: [] });
  assert.ok(warnings.some((w) => w.includes("Very high IV")));
});

test("buildOptionSignal: neutral context skips, bullish context picks a call", () => {
  const skip = buildOptionSignal({ symbol: "TST", movePct: 0 }, [contract()]);
  assert.equal(skip.side, null);
  assert.equal(skip.grade, "SKIP");
  assert.equal(skip.contract, null);

  const sig = buildOptionSignal(
    { symbol: "TST", price: 99, movePct: 2.5, priceVsVwapPct: 0.4, signalScore: 75, macd: { bullish: true } },
    [contract()],
  );
  assert.equal(sig.side, "call");
  assert.equal(sig.contract.optionSymbol, "O:TST260814C00100000");
  assert.equal(sig.contract.entry, 2.5);
  assert.equal(sig.contract.breakeven, 102.5);
  assert.ok(sig.score > 0 && sig.score <= 100);
});

test("buildOptionSignal: direction but no qualifying contract -> score 0 SKIP", () => {
  const sig = buildOptionSignal(
    { symbol: "TST", movePct: 3, signalScore: 80 },
    [contract({ openInterest: 1 })], // fails min OI
  );
  assert.equal(sig.side, "call");
  assert.equal(sig.contract, null);
  assert.equal(sig.score, 0);
  assert.equal(sig.grade, "SKIP");
});

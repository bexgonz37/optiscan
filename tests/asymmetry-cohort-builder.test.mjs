/**
 * Historical winner and control cohorts.
 *
 * The assertions here defend the rules that make the study honest rather than
 * flattering: ask-in/bid-out, fixed entry instants, ungradeable-stays-
 * ungradeable, near-the-money sampling, and no winners reported without
 * controls. Each one, if quietly relaxed, produces better-looking numbers and
 * a worse system.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCohorts, bandFor, compareCohorts, matchControls, median, etMinutes,
  selectNearTheMoney, reviewMissedWinners, missedWinnerSummary,
  OUTCOME_BANDS, WINNER_BANDS, MINIMUM_SUPPORTED_SAMPLE,
  COHORT_BUILDER_VERSION,
} from "../lib/research/asymmetry/historical/cohort-builder.ts";
import { RequestAccountant, DEFAULT_REQUEST_CAPS } from "../lib/research/asymmetry/historical/request-accounting.ts";

// ── banding ────────────────────────────────────────────────────────────────

test("each return maps to exactly one band, strongest first", () => {
  assert.equal(bandFor(600), "GAIN_500");
  assert.equal(bandFor(500), "GAIN_500", "inclusive at the boundary");
  assert.equal(bandFor(499), "GAIN_200");
  assert.equal(bandFor(200), "GAIN_200");
  assert.equal(bandFor(199), "GAIN_100");
  assert.equal(bandFor(100), "GAIN_100");
  assert.equal(bandFor(99), "GAIN_25_99");
  assert.equal(bandFor(25), "GAIN_25_99");
  assert.equal(bandFor(24), "FLAT");
  assert.equal(bandFor(-24), "FLAT");
  assert.equal(bandFor(-25), "LOSS");
  assert.equal(bandFor(-100), "LOSS");
});

test("a null return is UNGRADEABLE, never flat and never a loss", () => {
  assert.equal(bandFor(null), "UNGRADEABLE",
    "counting an unquotable contract as flat would bias every rate toward the middle");
  assert.ok(OUTCOME_BANDS.includes("UNGRADEABLE"));
  assert.equal(WINNER_BANDS.includes("UNGRADEABLE"), false);
  assert.equal(WINNER_BANDS.includes("FLAT"), false);
});

// ── sampling ───────────────────────────────────────────────────────────────

const ref = (strike, side = "call") => ({
  occ: `O:NVDA260731${side === "call" ? "C" : "P"}00${String(strike * 1000).padStart(6, "0")}`,
  underlying: "NVDA", side, strike, expiration: "2026-07-31",
});

test("selection is near the money, not a strike-ascending prefix", () => {
  const universe = [50, 100, 150, 190, 195, 198, 200, 205, 250, 400].map((s) => ref(s));
  const picked = selectNearTheMoney(universe, 198, 0.15, 4).map((c) => c.strike).sort((a, b) => a - b);
  assert.deepEqual(picked, [195, 198, 200, 205],
    "a strike-ascending prefix would have returned 50/100/150/190 — contracts that cannot produce a +100% move");
});

test("with no underlying price it takes the middle of the range, not the start", () => {
  const universe = [10, 20, 30, 40, 50, 60, 70].map((s) => ref(s));
  const picked = selectNearTheMoney(universe, null, 0.15, 3).map((c) => c.strike);
  assert.deepEqual(picked, [30, 40, 50], "still crude, but never the deepest ITM contracts on the board");
});

test("a band too tight to yield a sample falls back to the full pool", () => {
  const universe = [100, 200, 300, 400].map((s) => ref(s));
  const picked = selectNearTheMoney(universe, 250, 0.001, 3);
  assert.equal(picked.length, 3, "an empty band must not silently produce an empty cohort");
});

test("a universe at or under the cap is returned whole", () => {
  const universe = [100, 200].map((s) => ref(s));
  assert.equal(selectNearTheMoney(universe, 150, 0.15, 10).length, 2);
});

// ── comparison and matching ────────────────────────────────────────────────

const row = (over = {}) => ({
  occ: "O:NVDA260731C00197500", underlying: "NVDA", side: "call", strike: 197.5,
  expiration: "2026-07-31", sessionDate: "2026-07-31",
  entryAtMs: 1_785_506_400_000, entryAsk: 1.45, exitBid: 3.45, exitAtMs: 1_785_527_100_000,
  peakAfterEntry: 3.79, peakAtMs: 1_785_520_000_000, troughAfterEntry: 1.1,
  finalReturnPct: 137.93, mfePct: 161.38, maePct: -24.14,
  band: "GAIN_100", ungradeableReason: null,
  dte: 0, moneyness: 0.56, spreadPctAtEntry: 4.85, entryPremium: 1.45,
  timeOfDayMinutesEt: 600, sessionVolume: 304574, ...over,
});

test("winners are never reported without a control cohort", () => {
  assert.equal(compareCohorts([row()], []), null,
    "a list of contracts that went up is not a finding on its own");
});

test("a comparison below the minimum sample says so on every feature", () => {
  const c = compareCohorts([row()], [row({ finalReturnPct: 5, band: "FLAT" })]);
  assert.equal(c.sampleSufficient, false);
  assert.equal(c.minimumSupportedSample, MINIMUM_SUPPORTED_SAMPLE);
  for (const f of c.features) assert.match(f.note, /not evidence/);
});

test("a sufficient sample still claims no significance", () => {
  const winners = Array.from({ length: 25 }, () => row());
  const controls = Array.from({ length: 25 }, () => row({ finalReturnPct: 2, band: "FLAT", entryPremium: 9 }));
  const c = compareCohorts(winners, controls);
  assert.equal(c.sampleSufficient, true);
  for (const f of c.features) {
    assert.equal(/significan/i.test(f.note), true, "the note must address significance");
    assert.match(f.note, /No significance is claimed/);
  }
  assert.equal(c.features.find((f) => f.feature === "entryPremium").difference, 1.45 - 9);
});

test("matching never pairs a call against a put", () => {
  const w = row({ side: "call" });
  const near = row({ side: "put", occ: "O:NVDA260731P00197500", finalReturnPct: 1, band: "FLAT" });
  const far = row({ side: "call", occ: "O:NVDA260731C00190000", entryPremium: 8, dte: 3, finalReturnPct: 1, band: "FLAT" });
  const [pair] = matchControls([w], [near, far]);
  assert.equal(pair.control.side, "call", "side mismatch is penalised so a put is never a call's control");
});

test("each control is consumed at most once", () => {
  const winners = [row(), row({ occ: "O:NVDA260731C00200000" })];
  const controls = [row({ occ: "c1", finalReturnPct: 1, band: "FLAT" })];
  const pairs = matchControls(winners, controls);
  assert.equal(pairs.length, 1, "one control cannot serve two winners");
});

test("matching skips features missing on either side rather than imputing them", () => {
  const w = row({ entryPremium: null, spreadPctAtEntry: null, moneyness: null, timeOfDayMinutesEt: null });
  const c = row({ occ: "c1", entryPremium: null, spreadPctAtEntry: null, moneyness: null, timeOfDayMinutesEt: null, band: "FLAT" });
  const [pair] = matchControls([w], [c]);
  assert.ok(Number.isFinite(pair.distance), "dte alone still supports a distance");
  // With nothing comparable at all, no pair is produced.
  const none = matchControls(
    [row({ entryPremium: null, spreadPctAtEntry: null, moneyness: null, timeOfDayMinutesEt: null, dte: null })],
    [row({ occ: "c2", entryPremium: null, spreadPctAtEntry: null, moneyness: null, timeOfDayMinutesEt: null, dte: null, band: "FLAT" })],
  );
  assert.equal(none.length, 0, "a match on no shared evidence is not a match");
});

test("median ignores non-finite values and handles both parities", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([NaN, 1, 3]), 2);
});

test("etMinutes converts a UTC instant to minutes past ET midnight", () => {
  // 2026-07-31T14:00:00Z is 10:00 ET (EDT, UTC-4) = 600 minutes.
  assert.equal(etMinutes(Date.parse("2026-07-31T14:00:00Z")), 600);
});

// ── the builder, against a stubbed provider ────────────────────────────────

function stubProvider({ quotes = {}, bars = {}, contracts = [], underlyingClose = 198 } = {}) {
  return async (url) => {
    const u = String(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (u.includes("/v3/reference/options/contracts")) {
      return json({ results: contracts.map((c) => ({
        ticker: c.occ, underlying_ticker: c.underlying, contract_type: c.side,
        strike_price: c.strike, expiration_date: c.expiration,
      })) });
    }
    if (u.includes("/v3/quotes/")) {
      const occ = decodeURIComponent(u.split("/v3/quotes/")[1].split("?")[0]);
      const at = Number(new URL(u).searchParams.get("timestamp.lte")) / 1e6;
      const q = quotes[`${occ}@${at}`];
      return json({ results: q ? [{ sip_timestamp: at * 1e6, bid_price: q.bid, ask_price: q.ask, bid_size: 5, ask_size: 5 }] : [] });
    }
    if (u.includes("/v2/aggs/ticker/")) {
      const t = decodeURIComponent(u.split("/v2/aggs/ticker/")[1].split("/range")[0]);
      if (t === "NVDA") return json({ results: [{ t: Date.parse("2026-07-31T13:59:00Z"), o: underlyingClose, h: underlyingClose, l: underlyingClose, c: underlyingClose, v: 1000, vw: underlyingClose, n: 10 }] });
      return json({ results: bars[t] ?? [] });
    }
    return json({ results: [] });
  };
}

const ENTRY = Date.parse("2026-07-31T14:00:00Z");
const EXIT = Date.parse("2026-07-31T19:45:00Z");
const bar = (tISO, o, h, l, c, v) => ({ t: Date.parse(tISO), o, h, l, c, v, vw: c, n: 5 });

test("a winner is graded ask-in, bid-out — never the midpoint", async () => {
  const occ = "O:NVDA260731C00197500";
  const accountant = new RequestAccountant();
  const res = await buildCohorts({
    underlying: "NVDA", sessionDate: "2026-07-31",
    expirationFrom: "2026-07-31", expirationTo: "2026-08-14",
    entryAtMs: ENTRY, exitAtMs: EXIT, maxContracts: 10,
  }, {
    accountant, env: { POLYGON_API_KEY: "k" },
    fetchImpl: stubProvider({
      contracts: [{ occ, underlying: "NVDA", side: "call", strike: 197.5, expiration: "2026-07-31" }],
      bars: { [occ]: [bar("2026-07-31T14:00:00Z", 1.4, 1.5, 1.3, 1.45, 100), bar("2026-07-31T19:00:00Z", 3.0, 3.8, 2.9, 3.5, 900)] },
      quotes: { [`${occ}@${ENTRY}`]: { bid: 1.38, ask: 1.45 }, [`${occ}@${EXIT}`]: { bid: 3.45, ask: 3.60 } },
    }),
  });
  const [w] = res.winners;
  assert.ok(w, "a +137% move must be graded as a winner");
  assert.equal(w.entryAsk, 1.45, "entry is the ASK");
  assert.equal(w.exitBid, 3.45, "exit is the BID");
  // Midpoint entry (1.415) into midpoint exit (3.525) would read +149%. The
  // honest ask-to-bid number is lower, and that is the point.
  assert.equal(w.finalReturnPct, 137.93);
  assert.equal(w.band, "GAIN_100");
  assert.equal(res.version, COHORT_BUILDER_VERSION);
});

test("a contract with no executable exit quote is UNGRADEABLE with a reason", async () => {
  const occ = "O:NVDA260731C00197500";
  const res = await buildCohorts({
    underlying: "NVDA", sessionDate: "2026-07-31",
    expirationFrom: "2026-07-31", expirationTo: "2026-08-14",
    entryAtMs: ENTRY, exitAtMs: EXIT, maxContracts: 10,
  }, {
    accountant: new RequestAccountant(), env: { POLYGON_API_KEY: "k" },
    fetchImpl: stubProvider({
      contracts: [{ occ, underlying: "NVDA", side: "call", strike: 197.5, expiration: "2026-07-31" }],
      bars: { [occ]: [bar("2026-07-31T14:00:00Z", 1.4, 1.5, 1.3, 1.45, 100)] },
      quotes: { [`${occ}@${ENTRY}`]: { bid: 1.38, ask: 1.45 } }, // no exit quote
    }),
  });
  assert.equal(res.winners.length, 0);
  assert.equal(res.controls.length, 0, "it is not a control either");
  assert.equal(res.ungradeable.length, 1);
  assert.equal(res.ungradeable[0].ungradeableReason, "NO_EXECUTABLE_EXIT_QUOTE");
  assert.equal(res.ungradeable[0].finalReturnPct, null, "never a zero");
  assert.equal(res.bandCounts.UNGRADEABLE, 1);
  assert.equal(res.comparison, null, "no controls means no comparison");
});

test("a capped run reports what it managed instead of failing", async () => {
  const occ = "O:NVDA260731C00197500";
  // Budget allows the reference call and the underlying bars, then blocks.
  const accountant = new RequestAccountant({ ...DEFAULT_REQUEST_CAPS, maxHistoricalPerRun: 1 });
  const res = await buildCohorts({
    underlying: "NVDA", sessionDate: "2026-07-31",
    expirationFrom: "2026-07-31", expirationTo: "2026-08-14",
    entryAtMs: ENTRY, exitAtMs: EXIT, maxContracts: 5,
  }, {
    accountant, env: { POLYGON_API_KEY: "k" },
    fetchImpl: stubProvider({
      contracts: [{ occ, underlying: "NVDA", side: "call", strike: 197.5, expiration: "2026-07-31" }],
      bars: { [occ]: [bar("2026-07-31T14:00:00Z", 1.4, 1.5, 1.3, 1.45, 100)] },
      quotes: { [`${occ}@${ENTRY}`]: { bid: 1.38, ask: 1.45 } },
    }),
  });
  assert.equal(res.coverage.budgetBlocked, 1);
  assert.equal(res.ungradeable[0].ungradeableReason, "PROVIDER_BUDGET_BLOCKED");
  assert.ok(res.limitations.length > 0, "a capped run still reports its limitations");
});

test("the builder always states its limitations", async () => {
  const res = await buildCohorts({
    underlying: "NVDA", sessionDate: "2026-07-31",
    expirationFrom: "2026-07-31", expirationTo: "2026-08-14",
    entryAtMs: ENTRY, exitAtMs: EXIT, maxContracts: 1,
  }, { accountant: new RequestAccountant(), env: { POLYGON_API_KEY: "k" }, fetchImpl: stubProvider({}) });
  const text = res.limitations.join(" ");
  assert.match(text, /ASK/, "the ask/bid convention must be stated");
  assert.match(text, /BID/);
  assert.match(text, /UNGRADEABLE/);
  assert.match(text, /NEAR THE MONEY/);
  assert.match(text, /open interest, IV and Greeks are unavailable/);
});

// ── missed-winner review ───────────────────────────────────────────────────

test("a winner the radar never saw is a DETECTION gap", () => {
  const [m] = reviewMissedWinners([row()], [
    { optionSymbol: "O:AAPL260731C00200000", symbol: "AAPL", direction: "CALL" },
  ]);
  assert.equal(m.disposition, "NEVER_CAPTURED");
  assert.match(m.note, /detection gap/i);
});

test("a winner captured but never spoken about is a SUPPRESSION question", () => {
  const [m] = reviewMissedWinners([row()], [
    { optionSymbol: "O:NVDA260731C00197500", symbol: "NVDA", direction: "CALL", notified: false },
  ]);
  assert.equal(m.disposition, "CAPTURED_SILENTLY");
  assert.match(m.note, /notification journal/);
});

test("a winner captured and delivered is neither", () => {
  const [m] = reviewMissedWinners([row()], [
    { optionSymbol: "O:NVDA260731C00197500", symbol: "NVDA", direction: "CALL", notified: true },
  ]);
  assert.equal(m.disposition, "CAPTURED_AND_NOTIFIED");
});

test("right underlying and side but the wrong contract is a SELECTION gap", () => {
  // This is the real 2026-07-31 NVDA result. The radar captured the Aug 7
  // expiry; the 0DTE at the same strike returned +127%. Loosening the
  // notification gates would not have found it, and reading it as a detection
  // failure would argue for exactly that.
  const [m] = reviewMissedWinners(
    [row({ occ: "O:NVDA260731C00200000", strike: 200, finalReturnPct: 127.08 })],
    [{ optionSymbol: "O:NVDA260807C00200000", symbol: "NVDA", direction: "CALL", notified: true, finalReturnPct: 12.31 }],
  );
  assert.equal(m.disposition, "SIBLING_CONTRACT_CAPTURED");
  assert.equal(m.capturedInsteadOcc, "O:NVDA260807C00200000");
  assert.equal(m.returnGapPct, 114.77, "the substitution cost is quantified");
  assert.match(m.note, /CONTRACT SELECTION gap, not a detection gap/);
});

test("a call winner is never explained by a captured put", () => {
  const [m] = reviewMissedWinners([row({ side: "call" })], [
    { optionSymbol: "O:NVDA260731P00197500", symbol: "NVDA", direction: "PUT" },
  ]);
  assert.equal(m.disposition, "NEVER_CAPTURED", "the opposite directional bet is not a sibling");
});

test("the review is ordered by realized move, largest first", () => {
  const reviewed = reviewMissedWinners(
    [row({ occ: "small", finalReturnPct: 105 }), row({ occ: "big", finalReturnPct: 480 })],
    [],
  );
  assert.deepEqual(reviewed.map((r) => r.occ), ["big", "small"]);
});

test("the summary counts every disposition", () => {
  const s = missedWinnerSummary(reviewMissedWinners([row()], []));
  assert.equal(s.NEVER_CAPTURED, 1);
  assert.equal(s.SIBLING_CONTRACT_CAPTURED, 0);
  assert.equal(Object.keys(s).length, 4);
});

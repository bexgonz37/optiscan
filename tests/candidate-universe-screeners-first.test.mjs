/**
 * SCREENERS-FIRST regression coverage (2026-08-18 audit).
 *
 * Two things get called "watchlist" in this system and they must never be confused:
 *
 *   the MARKET CANDIDATE UNIVERSE — what the scanner is allowed to look at. This is
 *   screeners-first: a whole-market snapshot merged with a supplemental curated list.
 *
 *   the MORNING WATCHLIST — an OUTPUT. A ranked list of names worth watching today.
 *   Being on it is not a callout, not an entry, and not a performance event.
 *
 * These tests pin the properties that would be expensive to lose silently: that broad
 * discovery is opt-OUT rather than opt-in, that the curated list can only add names,
 * that a disabled snapshot is reported loudly rather than degrading quietly, and that
 * no per-user saved watchlist exists that could narrow the scan.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildCandidateUniverseReport } from "../lib/research/discovery/candidate-universe-report.ts";
import { DEFAULT_UNIVERSE, getZeroDteDiscoveryUniverse } from "../lib/universe.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const STATS = {
  atMs: 1787000000000,
  curatedCount: 245,
  broadCount: 9812,
  broadPass: 37,
  universeSize: 271,
  promoted: 12,
  source: "broad+curated",
};

test("broad discovery is opt-OUT: unset means the whole market is the primary source", () => {
  const r = buildCandidateUniverseReport({
    env: {}, curatedListSize: 245, discoveryStats: STATS, session: "regular",
  });
  assert.equal(r.broadDiscoveryEnabled, true, "an unset flag must not disable the screener");
  assert.equal(r.verdict, "SCREENERS_FIRST");
  assert.match(r.headline, /whole-market snapshot is the primary/i);
});

test("STOCK_BROAD_DISCOVERY=0 is reported LOUDLY, not degraded quietly", () => {
  const r = buildCandidateUniverseReport({
    env: { STOCK_BROAD_DISCOVERY: "0" }, curatedListSize: 245, discoveryStats: STATS, session: "regular",
  });
  assert.equal(r.broadDiscoveryEnabled, false);
  assert.equal(r.verdict, "CURATED_ONLY_BROAD_DISABLED");
  assert.match(r.headline, /BROAD DISCOVERY IS OFF/);
  assert.match(
    r.headline,
    /cannot be discovered no matter how it moves/,
    "the consequence must be stated, not just the flag value",
  );
  assert.ok(
    r.notes.some((n) => n.includes("OWNER ACTION")),
    "a disabled screener is a configuration problem the owner must be told to fix",
  );
});

test("only an explicit '0' disables it — '1', 'true' and junk all leave it on", () => {
  for (const v of ["1", "true", "", "yes", "0 ", "00"]) {
    const r = buildCandidateUniverseReport({
      env: { STOCK_BROAD_DISCOVERY: v }, curatedListSize: 10, discoveryStats: null, session: "closed",
    });
    assert.equal(r.broadDiscoveryEnabled, true, `value ${JSON.stringify(v)} must not disable broad discovery`);
  }
});

test("an unobserved cycle is NOT reported as broad discovery being off", () => {
  const r = buildCandidateUniverseReport({
    env: {}, curatedListSize: 245, discoveryStats: null, session: "closed",
  });
  assert.equal(r.lastCycle.observed, false);
  assert.equal(r.broadDiscoveryEnabled, true, "configuration still answers the question when the loop cannot");
  assert.equal(r.verdict, "SCREENERS_FIRST");
  assert.match(r.lastCycle.reason, /not evidence that broad discovery is off/i);
});

test("the curated list is SUPPLEMENTAL — the report says it cannot restrict the scan", () => {
  const r = buildCandidateUniverseReport({
    env: {}, curatedListSize: 245, discoveryStats: STATS, session: "regular",
  });
  assert.ok(
    r.notes.some((n) => /can never restrict/i.test(n)),
    "the additive-only property is the whole point and must be stated",
  );
  assert.ok(
    r.notes.some((n) => /no per-user saved watchlist/i.test(n)),
    "there is no saved-list feature, and that must be said rather than assumed",
  );
});

test("universe membership is explicitly NOT a callout", () => {
  const r = buildCandidateUniverseReport({
    env: {}, curatedListSize: 245, discoveryStats: STATS, session: "regular",
  });
  assert.ok(
    r.notes.some((n) => /not a callout/i.test(n) && /gate/i.test(n)),
    "a symbol reaching the universe still has every downstream gate to pass",
  );
});

test("the scanner merges broad + curated and lets broad WIN on collision", () => {
  // Source-level pin. The merge is inside the live discovery cycle, which these tests
  // must not run, so the invariant is asserted against the code that implements it:
  // curated is seeded into the map FIRST and the broad print overwrites it.
  const src = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");
  assert.match(
    src,
    /for \(const q of curated\) if \(q\.symbol\) bySym\.set\(q\.symbol, q\);/,
    "curated names seed the merge map",
  );
  assert.match(
    src,
    /Broad runner wins over a stale curated row/,
    "the broad whole-market print must overwrite the curated row, not the reverse",
  );
  assert.match(
    src,
    /STOCK_BROAD_DISCOVERY !== "0"/,
    "broad discovery must stay opt-out; an opt-in flag would silently shrink the universe",
  );
});

test("the curated discovery list can be extended but is not a per-user watchlist", () => {
  const dflt = getZeroDteDiscoveryUniverse({});
  assert.deepEqual(dflt, DEFAULT_UNIVERSE, "with no override the curated list is the shared default");
  const overridden = getZeroDteDiscoveryUniverse({ SCANNER_DISCOVERY_UNIVERSE: "AAA BBB" });
  assert.deepEqual(overridden, ["AAA", "BBB"], "the override is operator configuration, not user state");

  const r = buildCandidateUniverseReport({
    env: { SCANNER_DISCOVERY_UNIVERSE: "AAA BBB" }, curatedListSize: 2, discoveryStats: STATS, session: "regular",
  });
  assert.equal(r.verdict, "CURATED_LIST_OVERRIDDEN");
  assert.equal(r.broadDiscoveryEnabled, true, "overriding the curated list must NOT disable the screener");
  assert.match(r.headline, /still cannot be narrowed by the list/i);
});

test("no per-user saved-watchlist feature exists that could narrow the scan", () => {
  // If someone ever adds one, this test should fail and force a deliberate decision
  // about whether it is allowed to touch discovery.
  const loop = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");
  assert.ok(
    !/personalWatchlist|userWatchlist|savedWatchlist/i.test(loop),
    "the scanner loop must not read any per-user saved watchlist",
  );
});

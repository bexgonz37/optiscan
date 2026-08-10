/**
 * tests/historical-coverage-diagnostics.test.mjs
 *
 * HIST_COVERAGE_V1 — why an event has no executable entry.
 *
 * The whole value of this module is that it does NOT improve coverage. Every assertion
 * below either checks that a refusal is correctly ATTRIBUTED, or checks that the
 * diagnostic refused to accept something the replay fence would have refused:
 *
 *   · a quote after T (reading forward is the leak the fence exists to stop)
 *   · a stale quote (widening tolerance manufactures a fill rather than finding one)
 *   · a quote with no ask (nobody was offering, so there was nothing to buy)
 *
 * The MINEABLE / NOT_MINEABLE split is the load-bearing distinction. A window nobody
 * fetched is a budget decision we can reverse; a contract the provider never quoted is a
 * fact. Reporting them as one number makes a solvable problem look permanent.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseEntryCoverageOnDb,
  coverageCensusOnDb,
  DEFAULT_STALENESS_MS,
} from "../lib/research/historical/coverage-diagnostics.ts";

const OCC = "O:NVDA260807C00180000";
// 2026-08-03 is a Monday; 14:30 UTC is 10:30 ET, inside the regular session.
const T = Date.parse("2026-08-03T14:30:00Z");

/**
 * An in-memory stand-in for the quote store.
 *
 * `quotes` is a list of {ts, bid, ask}. The fake answers exactly the four statements the
 * module issues, so each diagnosis is driven by data rather than by mocking a verdict.
 */
function fakeDb({ quotes = [], reference = [], tables } = {}) {
  const present = tables ?? [
    "historical_option_quotes",
    "historical_contract_reference",
  ];
  const sorted = [...quotes].sort((a, b) => a.ts - b.ts);
  return {
    prepare(sql) {
      if (sql.includes("sqlite_master")) {
        return { get: (name) => (present.includes(name) ? { 1: 1 } : undefined) };
      }
      if (sql.includes("COUNT(*) AS n") && sql.includes("historical_option_quotes")) {
        return {
          get: (occ) => {
            const rows = sorted.filter((q) => q.occ === occ || q.occ === undefined);
            return rows.length
              ? { n: rows.length, lo: rows[0].ts, hi: rows[rows.length - 1].ts }
              : { n: 0, lo: null, hi: null };
          },
        };
      }
      if (sql.includes("FROM historical_contract_reference")) {
        return { get: (occ) => (reference.includes(occ) ? { 1: 1 } : undefined) };
      }
      if (sql.includes("MAX(ts_ms) AS ts")) {
        return {
          get: (occ, asOf) => {
            const before = sorted.filter((q) => q.ts <= asOf);
            return { ts: before.length ? before[before.length - 1].ts : null };
          },
        };
      }
      // replayQuoteAsOfOnDb: last quote at or before T.
      if (sql.includes("ORDER BY ts_ms DESC LIMIT 1")) {
        return {
          get: (occ, asOf) => {
            const before = sorted.filter((q) => q.ts <= asOf);
            if (!before.length) return undefined;
            const q = before[before.length - 1];
            return { ts_ms: q.ts, bid: q.bid, ask: q.ask };
          },
        };
      }
      return { get: () => undefined, all: () => [] };
    },
  };
}

const candidate = (over = {}) => ({ occ: OCC, symbol: "NVDA", entryAtMs: T, opportunityCaseId: "oc_1", ...over });

// ── identity defects: mining cannot fix these ────────────────────────────────

test("a malformed OCC is an identity defect, not a coverage gap", () => {
  const d = diagnoseEntryCoverageOnDb(fakeDb(), candidate({ occ: "NVDA-CALL-180" }));
  assert.equal(d.cause, "MALFORMED_OCC_IDENTITY");
  assert.equal(d.remedy, "IDENTITY_DEFECT");
  assert.equal(d.executable, false);
  assert.ok(/does not identify a contract/.test(d.note));
});

test("an unusable timestamp is an identity defect", () => {
  const d = diagnoseEntryCoverageOnDb(fakeDb(), candidate({ entryAtMs: NaN }));
  assert.equal(d.cause, "ENTRY_TIMESTAMP_INVALID");
  assert.equal(d.remedy, "IDENTITY_DEFECT");
});

test("an entry on a closed market is not a window to go and mine", () => {
  // 2026-08-08 is a Saturday. No quote can exist, so no budget should be spent looking.
  const d = diagnoseEntryCoverageOnDb(fakeDb(), candidate({ entryAtMs: Date.parse("2026-08-08T14:30:00Z") }));
  assert.equal(d.cause, "ENTRY_NOT_A_TRADING_SESSION");
  assert.equal(d.remedy, "IDENTITY_DEFECT");
  assert.equal(d.sessionDate, "2026-08-08");
});

// ── mineable gaps: reversible with budget ────────────────────────────────────

test("a known contract with no stored NBBO is mineable and says so", () => {
  const d = diagnoseEntryCoverageOnDb(fakeDb({ reference: [OCC] }), candidate());
  assert.equal(d.cause, "NBBO_WINDOW_NEVER_MINED");
  assert.equal(d.remedy, "MINEABLE");
  assert.equal(d.quotesForOcc, 0);
  assert.equal(d.contractReferenceKnown, true);
  assert.ok(d.suggestedWindow.fromMs < T && d.suggestedWindow.toMs > T);
});

test("an unknown contract needs its reference backfilled first", () => {
  const d = diagnoseEntryCoverageOnDb(fakeDb({ reference: [] }), candidate());
  assert.equal(d.cause, "OCC_REFERENCE_ABSENT_AND_UNMINED");
  assert.equal(d.remedy, "MINEABLE");
  assert.equal(d.contractReferenceKnown, false);
  assert.ok(/expired contracts cannot be resolved/i.test(d.note));
});

test("an entry before the mined window is mineable, not evidence of no quote", () => {
  const d = diagnoseEntryCoverageOnDb(
    fakeDb({ reference: [OCC], quotes: [{ ts: T + 3600_000, bid: 2, ask: 2.1 }] }),
    candidate(),
  );
  assert.equal(d.cause, "ENTRY_BEFORE_MINED_WINDOW");
  assert.equal(d.remedy, "MINEABLE");
  assert.equal(d.executable, false);
});

test("a span ending hours before the entry is a fetch we never made", () => {
  const d = diagnoseEntryCoverageOnDb(
    fakeDb({ reference: [OCC], quotes: [{ ts: T - 6 * 3600_000, bid: 2, ask: 2.1 }] }),
    candidate(),
  );
  assert.equal(d.cause, "ENTRY_AFTER_MINED_WINDOW");
  assert.equal(d.remedy, "MINEABLE", "a window we can still fetch");
  assert.ok(d.suggestedWindow.fromMs <= T);
});

test("a span ending just before the entry still yields an executable quote", () => {
  // The bug this guards: comparing the entry against the mined span BEFORE asking whether a
  // quote is in force reported a perfectly fresh quote as "after the mined window", because
  // a span that ENDS at the entry is not a span that misses it.
  const d = diagnoseEntryCoverageOnDb(
    fakeDb({ reference: [OCC], quotes: [{ ts: T - 1000, bid: 2.4, ask: 2.5 }] }),
    candidate(),
  );
  assert.equal(d.cause, "SUPPORTED");
  assert.equal(d.executable, true);
  assert.equal(d.nearestQuoteAgeMs, 1000);
});

test("quotes only after the entry are a mineable gap, never an entry", () => {
  // Reading forward for an entry is exactly the leak the fence exists to refuse.
  const d = diagnoseEntryCoverageOnDb(
    fakeDb({
      reference: [OCC],
      quotes: [{ ts: T + 1000, bid: 2, ask: 2.1 }, { ts: T + 7200_000, bid: 2, ask: 2.2 }],
    }),
    candidate(),
  );
  assert.equal(d.cause, "ENTRY_BEFORE_MINED_WINDOW");
  assert.equal(d.remedy, "MINEABLE");
  assert.equal(d.executable, false);
  assert.ok(/leak the fence/.test(d.note));
});

// ── not mineable: facts about the market, not about us ───────────────────────

test("a stale-only quote is refused and is NOT mineable", () => {
  const d = diagnoseEntryCoverageOnDb(
    fakeDb({
      reference: [OCC],
      quotes: [
        { ts: T - 30 * 60_000, bid: 2, ask: 2.1 },
        { ts: T + 3600_000, bid: 2, ask: 2.3 },
      ],
    }),
    candidate(),
  );
  assert.equal(d.cause, "STALE_QUOTE_ONLY");
  assert.equal(d.remedy, "NOT_MINEABLE");
  assert.equal(d.executable, false);
  assert.equal(d.nearestQuoteAgeMs, 30 * 60_000);
  assert.equal(d.stalenessToleranceMs, DEFAULT_STALENESS_MS);
  assert.ok(/manufacture a fill/.test(d.note), "the refusal names what widening would do");
});

test("a quote in force with no ask means nothing was offered", () => {
  const d = diagnoseEntryCoverageOnDb(
    fakeDb({ reference: [OCC], quotes: [{ ts: T - 1000, bid: 1.9, ask: null }, { ts: T + 60_000, bid: 1.9, ask: 2.0 }] }),
    candidate(),
  );
  assert.equal(d.cause, "PROVIDER_QUOTED_NO_ASK");
  assert.equal(d.remedy, "NOT_MINEABLE");
  assert.ok(/nothing to buy/.test(d.note));
});

// ── the supported case ───────────────────────────────────────────────────────

test("an executable entry is reported with the age of the quote behind it", () => {
  const d = diagnoseEntryCoverageOnDb(
    fakeDb({ reference: [OCC], quotes: [{ ts: T - 2000, bid: 2.4, ask: 2.5 }] }),
    candidate(),
  );
  assert.equal(d.cause, "SUPPORTED");
  assert.equal(d.remedy, "NONE_NEEDED");
  assert.equal(d.executable, true);
  assert.equal(d.nearestQuoteAgeMs, 2000);
  assert.equal(d.suggestedWindow, null, "nothing to mine");
});

test("the diagnostic uses the replay engine's own tolerance, never a looser one", () => {
  // A trailing quote keeps the mined span bracketing the entry, so the only thing under
  // test is the staleness boundary rather than the shape of the span.
  const after = { ts: T + 3600_000, bid: 2.4, ask: 2.6 };

  const justInside = diagnoseEntryCoverageOnDb(
    fakeDb({ reference: [OCC], quotes: [{ ts: T - (DEFAULT_STALENESS_MS - 1000), bid: 2.4, ask: 2.5 }, after] }),
    candidate(),
  );
  assert.equal(justInside.executable, true, "one second inside tolerance is executable");

  const justOutside = diagnoseEntryCoverageOnDb(
    fakeDb({ reference: [OCC], quotes: [{ ts: T - (DEFAULT_STALENESS_MS + 1000), bid: 2.4, ask: 2.5 }, after] }),
    candidate(),
  );
  assert.equal(justOutside.executable, false, "a diagnostic must not report coverage we lack");
  assert.equal(justOutside.cause, "STALE_QUOTE_ONLY");
  assert.equal(justOutside.remedy, "NOT_MINEABLE", "the window was mined; nobody was quoting");
});

// ── census ───────────────────────────────────────────────────────────────────

test("the census splits mineable from not-mineable and never pools causes", () => {
  const db = fakeDb({ reference: [OCC], quotes: [] });
  const { census } = coverageCensusOnDb(db, [
    candidate({ occ: "GARBAGE" }),
    candidate(),
    candidate({ entryAtMs: T + 60_000 }),
  ]);
  assert.equal(census.examined, 3);
  assert.equal(census.executable, 0);
  assert.equal(census.executableRate, 0);
  assert.equal(census.byCause.MALFORMED_OCC_IDENTITY, 1);
  assert.equal(census.byCause.NBBO_WINDOW_NEVER_MINED, 2);
  assert.equal(census.byRemedy.MINEABLE, 2);
  assert.equal(census.byRemedy.IDENTITY_DEFECT, 1);
  assert.equal(census.mineable.length, 2, "the work list holds only what mining can fix");
  assert.ok(/work list, not a relaxation/.test(census.note));
});

test("a fully supported batch reports a rate of 1 and an empty work list", () => {
  const db = fakeDb({ reference: [OCC], quotes: [{ ts: T - 1000, bid: 2.4, ask: 2.5 }] });
  const { census } = coverageCensusOnDb(db, [candidate(), candidate({ opportunityCaseId: "oc_2" })]);
  assert.equal(census.executable, 2);
  assert.equal(census.executableRate, 1);
  assert.equal(census.mineable.length, 0);
});

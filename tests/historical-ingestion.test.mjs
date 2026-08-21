/**
 * tests/historical-ingestion.test.mjs
 *
 * The mining lane is the only part of OptiScan that can issue an unbounded number of
 * provider requests. These tests pin the three fences that stop it, and the one
 * property that stops it re-spending what it already bought:
 *
 *   · it REFUSES during regular trading hours — a refusal, not a throttle
 *   · it stops when the request accountant blocks it
 *   · it stops when its wall clock runs out
 *   · a blocked, timed-out or crashed run RESUMES from its cursor
 *
 * Deps are injected, so nothing here touches the network.
 *
 * Fixture is the SAME migration production runs, not a hand-copy.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  historicalIngestionSessionGate,
  ingestUnderlyingBarsOnDb,
  ingestContractReferenceOnDb,
  ingestOptionQuotesOnDb,
  reopenUndercoveredOptionQuoteJobsOnDb,
} from "../lib/research/historical/ingestion.ts";
import { readIngestProgressOnDb, ingestJobKey, advanceIngestProgressOnDb } from "../lib/research/historical/store.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const DAY = 86_400_000;
// 2026-08-08 is a Saturday: closed, so the gate allows mining.
const WEEKEND = Date.parse("2026-08-08T18:00:00.000Z");
// 2026-08-10 15:00Z = 11:00 ET Monday: regular session.
const RTH = Date.parse("2026-08-10T15:00:00.000Z");

const ON = { HISTORICAL_INGESTION_ENABLED: "1" };

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

/** A fetcher that returns one bar per day and counts how often it was called. */
function barFetcher(spy = { calls: 0 }) {
  return {
    spy,
    fetchBars: async (symbol, fromMs, toMs) => {
      spy.calls += 1;
      const out = [];
      for (let t = fromMs; t < toMs; t += DAY) {
        out.push({
          symbol, timeframe: "1d", tsMs: t,
          open: 100, high: 101, low: 99, close: 100.5, volume: 1000, vwap: 100.2,
        });
      }
      return out;
    },
  };
}

// ── the session gate ─────────────────────────────────────────────────────────

test("mining refuses outright during the regular session", () => {
  const g = historicalIngestionSessionGate(RTH, ON);
  assert.equal(g.allowed, false);
  assert.match(g.reason, /provider priority/);
});

test("mining is allowed when the market is closed", () => {
  const g = historicalIngestionSessionGate(WEEKEND, ON);
  assert.equal(g.allowed, true);
});

test("mining is off unless explicitly enabled", () => {
  const g = historicalIngestionSessionGate(WEEKEND, {});
  assert.equal(g.allowed, false);
  assert.match(g.reason, /HISTORICAL_INGESTION_ENABLED/);
});

test("an RTH run issues no provider request at all", async () => {
  const d = db();
  const f = barFetcher();
  const res = await ingestUnderlyingBarsOnDb(
    d,
    { symbols: ["SPY"], timeframe: "1d", fromMs: WEEKEND - 90 * DAY, toMs: WEEKEND },
    { now: () => RTH, fetchBars: f.fetchBars },
    ON,
  );
  assert.equal(res.ran, false);
  assert.equal(f.spy.calls, 0, "a refusal must not be a slower version of running");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM historical_underlying_bars").get().n, 0);
});

// ── idempotence and resumability ─────────────────────────────────────────────

test("re-running a completed backfill writes nothing and issues no request", async () => {
  const d = db();
  const f = barFetcher();
  const plan = { symbols: ["SPY"], timeframe: "1d", fromMs: WEEKEND - 60 * DAY, toMs: WEEKEND, windowMs: 30 * DAY };

  const first = await ingestUnderlyingBarsOnDb(d, plan, { now: () => WEEKEND, fetchBars: f.fetchBars }, ON);
  assert.ok(first.rowsWritten > 0);
  assert.equal(first.jobsCompleted, 1);
  const callsAfterFirst = f.spy.calls;
  const rowsAfterFirst = d.prepare("SELECT COUNT(*) n FROM historical_underlying_bars").get().n;

  const second = await ingestUnderlyingBarsOnDb(d, plan, { now: () => WEEKEND, fetchBars: f.fetchBars }, ON);
  assert.equal(second.rowsWritten, 0);
  assert.equal(
    f.spy.calls,
    callsAfterFirst,
    "the cursor is already past the end, so no window is fetched again",
  );
  assert.equal(d.prepare("SELECT COUNT(*) n FROM historical_underlying_bars").get().n, rowsAfterFirst);
});

test("a run cut short by its wall clock resumes from the cursor", async () => {
  const d = db();
  const f = barFetcher();
  const plan = { symbols: ["SPY"], timeframe: "1d", fromMs: WEEKEND - 120 * DAY, toMs: WEEKEND, windowMs: 30 * DAY };

  // Time passes only when a window is actually fetched, so the run gets through a
  // couple of windows and then runs out — the realistic shape of a long backfill.
  let t = WEEKEND;
  const first = await ingestUnderlyingBarsOnDb(
    d, { ...plan, maxRunMs: 15 * 60_000 },
    {
      now: () => t,
      fetchBars: async (...args) => { t += 10 * 60_000; return f.fetchBars(...args); },
    },
    ON,
  );
  assert.equal(first.jobsResumable, 1, "the job did not finish");
  const prog = readIngestProgressOnDb(d, ingestJobKey("underlying_bars", "SPY", "1d"));
  assert.ok(prog.cursorMs > plan.fromMs, "the cursor advanced");
  assert.ok(prog.cursorMs < plan.toMs, "but not to the end");
  const partialRows = d.prepare("SELECT COUNT(*) n FROM historical_underlying_bars").get().n;
  assert.ok(partialRows > 0);

  // A second run with a generous clock finishes the job.
  const second = await ingestUnderlyingBarsOnDb(
    d, plan, { now: () => WEEKEND, fetchBars: f.fetchBars }, ON,
  );
  assert.equal(second.jobsCompleted, 1);
  const done = readIngestProgressOnDb(d, ingestJobKey("underlying_bars", "SPY", "1d"));
  assert.equal(done.status, "COMPLETE");
  assert.ok(
    d.prepare("SELECT COUNT(*) n FROM historical_underlying_bars").get().n > partialRows,
    "the resumed run added the windows the first one never reached",
  );
});

test("the completion watermark never walks backwards", async () => {
  const d = db();
  const f = barFetcher();
  const full = { symbols: ["SPY"], timeframe: "1d", fromMs: WEEKEND - 60 * DAY, toMs: WEEKEND, windowMs: 30 * DAY };
  await ingestUnderlyingBarsOnDb(d, full, { now: () => WEEKEND, fetchBars: f.fetchBars }, ON);
  const after = readIngestProgressOnDb(d, ingestJobKey("underlying_bars", "SPY", "1d"));

  // Someone re-runs with an EARLIER end date. The watermark must hold.
  await ingestUnderlyingBarsOnDb(
    d, { ...full, toMs: WEEKEND - 45 * DAY },
    { now: () => WEEKEND, fetchBars: f.fetchBars }, ON,
  );
  const now2 = readIngestProgressOnDb(d, ingestJobKey("underlying_bars", "SPY", "1d"));
  assert.ok(
    now2.completedThroughMs >= after.completedThroughMs,
    "a narrower re-run cannot make the store look less complete than it is",
  );
});

test("a fetch failure is recorded and leaves the job resumable, never complete", async () => {
  const d = db();
  const res = await ingestUnderlyingBarsOnDb(
    d,
    { symbols: ["SPY"], timeframe: "1d", fromMs: WEEKEND - 30 * DAY, toMs: WEEKEND },
    { now: () => WEEKEND, fetchBars: async () => { throw new Error("provider 503"); } },
    ON,
  );
  assert.equal(res.jobsCompleted, 0);
  assert.equal(res.jobsResumable, 1);
  const prog = readIngestProgressOnDb(d, ingestJobKey("underlying_bars", "SPY", "1d"));
  assert.equal(prog.status, "FAILED");
  assert.match(prog.lastNote, /provider 503/);
});

// ── the budget ───────────────────────────────────────────────────────────────

test("the request accountant stops a run and names the cap it hit", async () => {
  const d = db();
  const f = barFetcher();
  const res = await ingestUnderlyingBarsOnDb(
    d,
    { symbols: ["SPY"], timeframe: "1d", fromMs: WEEKEND - 3650 * DAY, toMs: WEEKEND, windowMs: 30 * DAY },
    { now: () => WEEKEND, fetchBars: f.fetchBars },
    // Two historical requests for the whole run.
    { ...ON, ASYM_HIST_MAX_PER_RUN: "2" },
  );
  assert.equal(res.requestsIssued, 2, "counted BEFORE issuing, so the cap is a ceiling not a target");
  assert.ok(res.requestsBlocked >= 1);
  assert.ok(res.blockedReasons.includes("MAX_HISTORICAL_PER_RUN"));
  assert.equal(res.jobsCompleted, 0);

  // ...and the cursor survives so the next run continues rather than restarting.
  const prog = readIngestProgressOnDb(d, ingestJobKey("underlying_bars", "SPY", "1d"));
  assert.equal(prog.status, "BLOCKED");
  assert.ok(prog.cursorMs > WEEKEND - 3650 * DAY);
});

// ── contract reference and quotes ────────────────────────────────────────────

test("expired contract reference is upserted and resolvable", async () => {
  const d = db();
  const res = await ingestContractReferenceOnDb(
    d,
    { underlyings: ["NVDA"], expirationFrom: "2026-07-01", expirationTo: "2026-08-31" },
    {
      now: () => WEEKEND,
      fetchContracts: async (u) => [
        { occ: "O:NVDA260807C00180000", underlying: u, side: "call", strike: 180, expiration: "2026-08-07" },
        { occ: "O:NVDA260807P00170000", underlying: u, side: "put", strike: 170, expiration: "2026-08-07" },
      ],
    },
    ON,
  );
  assert.equal(res.rowsWritten, 2);
  const { resolveContractOnDb } = await import("../lib/research/historical/store.ts");
  const c = resolveContractOnDb(d, "o:nvda260807c00180000");
  assert.equal(c.strike, 180);
  assert.equal(c.side, "call");
  assert.equal(c.expired, true, "an expired contract resolves; that is the whole point");
});

test("an option-quote target already COMPLETE is not fetched again", async () => {
  const d = db();
  const spy = { calls: 0 };
  const plan = {
    targets: [{ occ: "O:NVDA260807C00180000", underlying: "NVDA", fromMs: WEEKEND - DAY, toMs: WEEKEND }],
  };
  const deps = {
    now: () => WEEKEND,
    // Reaches the END of the requested window, which is what earns a COMPLETE. A fake that
    // returned one row near the start would be asserting that a single quote covers a whole
    // day — the bookkeeping error that left 54 of 78 real events without an entry.
    fetchQuotes: async (occ, fromMs, toMs) => {
      spy.calls += 1;
      return [{ occ, tsMs: fromMs + 1000, bid: 2.0, ask: 2.1 }, { occ, tsMs: toMs, bid: 2.0, ask: 2.1 }];
    },
  };
  const first = await ingestOptionQuotesOnDb(d, plan, deps, ON);
  assert.equal(first.rowsWritten, 2);
  assert.equal(spy.calls, 1);

  const second = await ingestOptionQuotesOnDb(d, plan, deps, ON);
  assert.equal(spy.calls, 1, "a COMPLETE window is never re-fetched");
  assert.equal(second.jobsCompleted, 1);
});

// ── truncated windows must stay resumable ────────────────────────────────────
//
// A provider returns a BOUNDED page — on a liquid contract roughly 4,500 NBBO updates,
// which is minutes of a multi-hour window. The runner used to record
// completed_through_ms = toMs after any successful call, so a window that held seven
// minutes of a seven-hour span read COMPLETE, the planner never returned to it, and 54 of
// 78 historical events had no executable entry while every job looked finished.
//
// COMPLETE now means "the stored rows reach the end of this window".

test("a capped page leaves the window resumable, not complete", async () => {
  const d = db();
  const occ = "O:NVDA260807C00180000";
  const fromMs = WEEKEND - DAY;
  const plan = { targets: [{ occ, underlying: "NVDA", fromMs, toMs: WEEKEND }] };
  // 500 rows covering the first ten minutes of a full day, then nothing.
  const deps = {
    now: () => WEEKEND,
    fetchQuotes: async (o, f) =>
      Array.from({ length: 500 }, (_, i) => ({ occ: o, tsMs: f + i * 1200, bid: 2, ask: 2.1 })),
  };
  const r = await ingestOptionQuotesOnDb(d, plan, deps, ON);
  assert.equal(r.rowsWritten, 500);
  assert.equal(r.jobsCompleted, 0, "a tenth of a window is not a completed window");
  assert.equal(r.jobsResumable, 1);

  const p = readIngestProgressOnDb(d, ingestJobKey("option_quotes", occ, `${fromMs}..${WEEKEND}`));
  assert.equal(p.status, "IN_PROGRESS");
  assert.equal(p.cursorMs, fromMs + 499 * 1200, "the cursor is the last instant actually stored");
  assert.notEqual(p.completedThroughMs, WEEKEND, "coverage is never claimed past the data");
  assert.ok(/truncated/.test(p.lastNote));
});

test("a resumed window continues from the last stored instant, not the window start", async () => {
  const d = db();
  const occ = "O:NVDA260807C00180000";
  const fromMs = WEEKEND - DAY;
  const plan = { targets: [{ occ, underlying: "NVDA", fromMs, toMs: WEEKEND }] };
  const asked = [];
  // Each pass returns one hour of quotes from wherever it was asked to start.
  const deps = {
    now: () => WEEKEND,
    fetchQuotes: async (o, f, t) => {
      asked.push(f);
      const end = Math.min(f + 3600_000, t);
      const out = [];
      for (let ts = f + 1000; ts <= end; ts += 60_000) out.push({ occ: o, tsMs: ts, bid: 2, ask: 2.1 });
      return out;
    },
  };

  await ingestOptionQuotesOnDb(d, plan, deps, ON);
  assert.equal(asked[0], fromMs, "the first pass starts at the window start");

  await ingestOptionQuotesOnDb(d, plan, deps, ON);
  assert.ok(asked[1] > fromMs, "the second pass resumes forward");
  assert.ok(asked[1] >= fromMs + 3600_000 - 60_000, "and resumes from where the data ended");

  // Drive it to completion; a day of one-hour pages needs a couple of dozen passes.
  for (let i = 0; i < 40; i++) {
    const r = await ingestOptionQuotesOnDb(d, plan, deps, ON);
    if (r.jobsCompleted === 1 && r.jobs === 0) break;
  }
  const p = readIngestProgressOnDb(d, ingestJobKey("option_quotes", occ, `${fromMs}..${WEEKEND}`));
  assert.equal(p.status, "COMPLETE", "it does finish, by advancing rather than restarting");
  assert.equal(p.completedThroughMs, WEEKEND);
});

test("a window the provider cannot extend is closed rather than retried forever", async () => {
  const d = db();
  const occ = "O:QUIET260807C00180000";
  const fromMs = WEEKEND - DAY;
  const plan = { targets: [{ occ, underlying: "QUIET", fromMs, toMs: WEEKEND }] };
  // A genuinely quiet contract: nothing at all in the span.
  const deps = { now: () => WEEKEND, fetchQuotes: async () => [] };

  const first = await ingestOptionQuotesOnDb(d, plan, deps, ON);
  assert.equal(first.rowsWritten, 0);
  assert.equal(first.jobsCompleted, 1, "an empty span is answered, not left open");

  const p = readIngestProgressOnDb(d, ingestJobKey("option_quotes", occ, `${fromMs}..${WEEKEND}`));
  // EXHAUSTED, not COMPLETE: the span was examined and the provider had nothing. The two
  // are both terminal and only one of them is full coverage, and a reader that cannot tell
  // them apart reopens this window for ever.
  assert.equal(p.status, "EXHAUSTED");
  assert.ok(/no quotes returned/.test(p.lastNote), "and it says the window was empty");

  const second = await ingestOptionQuotesOnDb(d, plan, deps, ON);
  assert.equal(second.jobs, 0, "no infinite retry on a quiet contract");
});

test("a page that does not advance past the cursor closes the window", async () => {
  const d = db();
  const occ = "O:STUCK260807C00180000";
  const fromMs = WEEKEND - DAY;
  const plan = { targets: [{ occ, underlying: "STUCK", fromMs, toMs: WEEKEND }] };
  // The same FIXED row every time, whatever it is asked for — a provider that has nothing
  // beyond this instant. Without the no-advance guard this would re-fetch the identical
  // page forever.
  const deps = {
    now: () => WEEKEND,
    fetchQuotes: async (o) => [{ occ: o, tsMs: fromMs + 500, bid: 2, ask: 2.1 }],
  };
  await ingestOptionQuotesOnDb(d, plan, deps, ON);
  const key = ingestJobKey("option_quotes", occ, `${fromMs}..${WEEKEND}`);
  assert.equal(readIngestProgressOnDb(d, key).status, "IN_PROGRESS", "one row, so it advanced once");

  await ingestOptionQuotesOnDb(d, plan, deps, ON);
  const p = readIngestProgressOnDb(d, key);
  assert.equal(p.status, "EXHAUSTED", "the second pass gained nothing, so the window is closed");
  assert.ok(/exhausted short of its end/.test(p.lastNote), "and it records that it stopped short");
  // EXHAUSTED means the span was EXAMINED and everything available is stored — which is
  // true. The old bug was claiming COMPLETE after a CAPPED page, where more data existed and
  // was never fetched. The guard against hiding a gap lives in the coverage diagnostic,
  // which reads the rows rather than this table.
  assert.equal(p.requestsSpent, 2, "and it stopped after proving there was nothing more");
});

test("a failed fetch never records coverage", async () => {
  const d = db();
  const occ = "O:FAIL260807C00180000";
  const fromMs = WEEKEND - DAY;
  const plan = { targets: [{ occ, underlying: "FAIL", fromMs, toMs: WEEKEND }] };
  const deps = { now: () => WEEKEND, fetchQuotes: async () => { throw new Error("provider 500"); } };
  const r = await ingestOptionQuotesOnDb(d, plan, deps, ON);
  assert.equal(r.jobsResumable, 1);
  const p = readIngestProgressOnDb(d, ingestJobKey("option_quotes", occ, `${fromMs}..${WEEKEND}`));
  assert.equal(p.status, "FAILED");
  assert.equal(p.completedThroughMs, null, "a failure claims nothing");
});

// ── repairing windows that already lied ──────────────────────────────────────
//
// The coverage fix governs what a FUTURE run records. It cannot help the 73 windows already
// written as COMPLETE after a single capped page — and because BOTH the planner and the
// runner skip a COMPLETE job, that damage is self-preserving and the queue reports itself
// exhausted forever. The repair trusts the ROWS over the progress table, because the
// progress table is what was wrong.

test("a COMPLETE window whose rows fall short is reopened at the last stored instant", async () => {
  const d = db();
  const occ = "O:NVDA260807C00180000";
  const fromMs = WEEKEND - DAY;
  const plan = { targets: [{ occ, underlying: "NVDA", fromMs, toMs: WEEKEND }] };

  // Simulate the historical damage exactly: rows covering ten minutes, job marked COMPLETE
  // through the whole day.
  const key = ingestJobKey("option_quotes", occ, `${fromMs}..${WEEKEND}`);
  const ins = d.prepare(
    `INSERT OR REPLACE INTO historical_option_quotes
       (occ, ts_ms, bid, ask, bid_size, ask_size, source, ingest_version, ingested_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 500; i++) ins.run(occ, fromMs + i * 1200, 2, 2.1, 1, 1, "t", "t", 1);
  advanceIngestProgressOnDb(d, {
    jobKey: key, dataset: "option_quotes", subject: occ, timeframe: `${fromMs}..${WEEKEND}`,
    cursorMs: WEEKEND, completedThroughMs: WEEKEND, rowsIngested: 500, requestsSpent: 1,
    status: "COMPLETE", nowMs: 1,
  });
  assert.equal(readIngestProgressOnDb(d, key).status, "COMPLETE");

  const rep = reopenUndercoveredOptionQuoteJobsOnDb(d, { nowMs: WEEKEND });
  assert.equal(rep.examined, 1);
  assert.equal(rep.reopened, 1);
  assert.equal(rep.alreadyCovered, 0);
  assert.equal(rep.reopenedJobs[0].occ, occ);
  assert.equal(rep.reopenedJobs[0].storedThroughMs, fromMs + 499 * 1200);

  const p = readIngestProgressOnDb(d, key);
  assert.equal(p.status, "IN_PROGRESS", "back in front of the planner");
  assert.equal(p.cursorMs, fromMs + 499 * 1200, "resumes from real data, not from the start");
  assert.ok(/capped page/.test(p.lastNote));

  // And the runner now picks it up, resuming rather than re-buying the stored page.
  const asked = [];
  const deps = {
    now: () => WEEKEND,
    fetchQuotes: async (o, f, t) => { asked.push(f); return [{ occ: o, tsMs: t, bid: 2, ask: 2.1 }]; },
  };
  const r = await ingestOptionQuotesOnDb(d, plan, deps, ON);
  assert.equal(r.jobs, 1, "the reopened window is fetched");
  assert.equal(asked[0], fromMs + 499 * 1200, "from the cursor, not from the window start");
  assert.equal(readIngestProgressOnDb(d, key).status, "COMPLETE", "and now genuinely completes");
});

test("a window whose rows really do reach its end is left alone", async () => {
  const d = db();
  const occ = "O:COVERED260807C00180000";
  const fromMs = WEEKEND - DAY;
  const key = ingestJobKey("option_quotes", occ, `${fromMs}..${WEEKEND}`);
  d.prepare(
    `INSERT OR REPLACE INTO historical_option_quotes
       (occ, ts_ms, bid, ask, bid_size, ask_size, source, ingest_version, ingested_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(occ, WEEKEND - 1000, 2, 2.1, 1, 1, "t", "t", 1);
  advanceIngestProgressOnDb(d, {
    jobKey: key, dataset: "option_quotes", subject: occ, timeframe: `${fromMs}..${WEEKEND}`,
    cursorMs: WEEKEND, completedThroughMs: WEEKEND, rowsIngested: 1, requestsSpent: 1,
    status: "COMPLETE", nowMs: 1,
  });

  const rep = reopenUndercoveredOptionQuoteJobsOnDb(d, { nowMs: WEEKEND });
  assert.equal(rep.alreadyCovered, 1);
  assert.equal(rep.reopened, 0);
  assert.equal(readIngestProgressOnDb(d, key).status, "COMPLETE", "no churn on a good window");
});

test("coverage is judged inside the window, not from a later job on the same contract", async () => {
  // A newer window on the same OCC must not certify an older one. Counting all rows for the
  // contract would declare the earlier window covered by data that postdates it entirely.
  const d = db();
  const occ = "O:SHARED260807C00180000";
  const oldFrom = WEEKEND - 3 * DAY;
  const oldTo = WEEKEND - 2 * DAY;
  const key = ingestJobKey("option_quotes", occ, `${oldFrom}..${oldTo}`);
  d.prepare(
    `INSERT OR REPLACE INTO historical_option_quotes
       (occ, ts_ms, bid, ask, bid_size, ask_size, source, ingest_version, ingested_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(occ, WEEKEND - 1000, 2, 2.1, 1, 1, "t", "t", 1);
  advanceIngestProgressOnDb(d, {
    jobKey: key, dataset: "option_quotes", subject: occ, timeframe: `${oldFrom}..${oldTo}`,
    cursorMs: oldTo, completedThroughMs: oldTo, rowsIngested: 1, requestsSpent: 1,
    status: "COMPLETE", nowMs: 1,
  });

  const rep = reopenUndercoveredOptionQuoteJobsOnDb(d, { nowMs: WEEKEND });
  assert.equal(rep.reopened, 1, "the old window holds nothing of its own and is reopened");
  assert.equal(rep.reopenedJobs[0].storedThroughMs, null, "no rows inside its own bounds");
});

test("repairing twice does not churn a window a second time", async () => {
  const d = db();
  const occ = "O:NVDA260807C00180000";
  const fromMs = WEEKEND - DAY;
  const key = ingestJobKey("option_quotes", occ, `${fromMs}..${WEEKEND}`);
  advanceIngestProgressOnDb(d, {
    jobKey: key, dataset: "option_quotes", subject: occ, timeframe: `${fromMs}..${WEEKEND}`,
    cursorMs: WEEKEND, completedThroughMs: WEEKEND, rowsIngested: 0, requestsSpent: 1,
    status: "COMPLETE", nowMs: 1,
  });
  assert.equal(reopenUndercoveredOptionQuoteJobsOnDb(d, { nowMs: WEEKEND }).reopened, 1);
  // Now IN_PROGRESS, so it is no longer a COMPLETE window claiming coverage it lacks.
  const second = reopenUndercoveredOptionQuoteJobsOnDb(d, { nowMs: WEEKEND });
  assert.equal(second.examined, 0, "only COMPLETE windows are candidates for repair");
  assert.equal(second.reopened, 0);
});

test("a job whose window bounds cannot be parsed is reported, not silently skipped", async () => {
  const d = db();
  advanceIngestProgressOnDb(d, {
    jobKey: "option_quotes|O:WEIRD260807C00180000|not-a-range",
    dataset: "option_quotes", subject: "O:WEIRD260807C00180000", timeframe: "not-a-range",
    cursorMs: null, completedThroughMs: null, rowsIngested: 0, requestsSpent: 1,
    status: "COMPLETE", nowMs: 1,
  });
  const rep = reopenUndercoveredOptionQuoteJobsOnDb(d, { nowMs: WEEKEND });
  assert.equal(rep.unparseable, 1);
  assert.equal(rep.reopened, 0);
});

// ── the spend loops these fences were missing ────────────────────────────────
//
// Found on 2026-08-21 by auditing what the historical lane had actually SPENT, not what it
// had stored: 78 option-quote windows holding 2.24M rows carried 14,239 runs and 7,363
// provider requests, and 54 contract-reference jobs carried 6,944 runs and 6,944 requests
// upserting 6,013,016 rows over 27,000 distinct contracts. Both lanes were re-buying data
// they already had, off-peak, for ever. Every test below fails against that code.

test("an exhausted quote window survives the coverage repair instead of looping", async () => {
  const d = db();
  const occ = "O:LOOP260807C00180000";
  const fromMs = WEEKEND - DAY;
  const key = ingestJobKey("option_quotes", occ, `${fromMs}..${WEEKEND}`);
  // A window running past the last quote the provider will ever have: the runner stores
  // what exists, examines the rest and finds nothing. Its ROWS stop short of the window end
  // and always will — which is exactly what the repair used to read as a truncated download.
  const plan = { targets: [{ occ, underlying: "LOOP", fromMs, toMs: WEEKEND }] };
  const deps = {
    now: () => WEEKEND,
    fetchQuotes: async (o, f) => (f === fromMs ? [{ occ: o, tsMs: fromMs + 500, bid: 2, ask: 2.1 }] : []),
  };
  await ingestOptionQuotesOnDb(d, plan, deps, ON);
  await ingestOptionQuotesOnDb(d, plan, deps, ON);
  const settled = readIngestProgressOnDb(d, key);
  assert.equal(settled.status, "EXHAUSTED");
  const spentWhenSettled = settled.requestsSpent;

  // The repair no longer sees it at all, because it only ever examines COMPLETE.
  const rep = reopenUndercoveredOptionQuoteJobsOnDb(d, { nowMs: WEEKEND });
  assert.equal(rep.examined, 0, "an exhausted window is not a repair candidate");
  assert.equal(rep.reopened, 0);
  assert.equal(readIngestProgressOnDb(d, key).status, "EXHAUSTED", "and it is not reopened");

  // Ten more full cycles of repair-then-run spend nothing. This is the property that was
  // missing: the loop is convergent, not merely slow.
  for (let i = 0; i < 10; i++) {
    reopenUndercoveredOptionQuoteJobsOnDb(d, { nowMs: WEEKEND });
    const r = await ingestOptionQuotesOnDb(d, plan, deps, ON);
    assert.equal(r.jobs, 0, `pass ${i}: nothing left to buy`);
  }
  assert.equal(readIngestProgressOnDb(d, key).requestsSpent, spentWhenSettled, "zero further provider spend");
});

test("a legacy window that really was capped is still repaired, exactly once", async () => {
  // The repair's original purpose must survive: rows written before the coverage fix say
  // COMPLETE after a single capped page, and there IS more to fetch. It gets reopened,
  // fetched to its end, and then never churns again.
  const d = db();
  const occ = "O:LEGACY260807C00180000";
  const fromMs = WEEKEND - DAY;
  const key = ingestJobKey("option_quotes", occ, `${fromMs}..${WEEKEND}`);
  const ins = d.prepare(
    `INSERT OR REPLACE INTO historical_option_quotes
       (occ, ts_ms, bid, ask, bid_size, ask_size, source, ingest_version, ingested_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 100; i++) ins.run(occ, fromMs + i * 1000, 2, 2.1, 1, 1, "t", "t", 1);
  advanceIngestProgressOnDb(d, {
    jobKey: key, dataset: "option_quotes", subject: occ, timeframe: `${fromMs}..${WEEKEND}`,
    cursorMs: WEEKEND, completedThroughMs: WEEKEND, rowsIngested: 100, requestsSpent: 1,
    status: "COMPLETE", nowMs: 1,
  });

  assert.equal(reopenUndercoveredOptionQuoteJobsOnDb(d, { nowMs: WEEKEND }).reopened, 1);
  const plan = { targets: [{ occ, underlying: "LEGACY", fromMs, toMs: WEEKEND }] };
  // More data really did exist, so the refetch reaches the window end.
  const deps = { now: () => WEEKEND, fetchQuotes: async (o) => [{ occ: o, tsMs: WEEKEND, bid: 2, ask: 2.1 }] };
  await ingestOptionQuotesOnDb(d, plan, deps, ON);
  assert.equal(readIngestProgressOnDb(d, key).status, "COMPLETE", "genuinely covered now");

  const again = reopenUndercoveredOptionQuoteJobsOnDb(d, { nowMs: WEEKEND });
  assert.equal(again.alreadyCovered, 1);
  assert.equal(again.reopened, 0, "repaired once, never again");
});

test("the planner does not re-plan an exhausted window", async () => {
  const { buildBackfillPlan } = await import("../lib/research/historical/planner.ts");
  const d = db();
  const occ = "O:PLAN260807C00180000";
  const fromMs = WEEKEND - DAY;
  advanceIngestProgressOnDb(d, {
    jobKey: ingestJobKey("option_quotes", occ, `${fromMs}..${WEEKEND}`),
    dataset: "option_quotes", subject: occ, timeframe: `${fromMs}..${WEEKEND}`,
    cursorMs: WEEKEND, completedThroughMs: WEEKEND, rowsIngested: 5, requestsSpent: 1,
    status: "EXHAUSTED", nowMs: 1,
  });
  const plan = buildBackfillPlan(d, { nowMs: WEEKEND });
  assert.equal(
    plan.optionWindows.filter((w) => w.occ.toUpperCase() === occ).length, 0,
    "excluding it from the repair but not from the plan would move the loop, not end it",
  );
});

test("contract reference is not re-fetched for a range already ingested", async () => {
  const d = db();
  const spy = { calls: 0 };
  const plan = { underlyings: ["NVDA", "AAPL"], expirationFrom: "2026-07-01", expirationTo: "2026-08-31" };
  const deps = {
    now: () => WEEKEND,
    fetchContracts: async (u) => {
      spy.calls += 1;
      return [{ occ: `O:${u}260807C00180000`, underlying: u, side: "call", strike: 180, expiration: "2026-08-07" }];
    },
  };
  const first = await ingestContractReferenceOnDb(d, plan, deps, ON);
  assert.equal(first.requestsIssued, 2);
  assert.equal(spy.calls, 2);

  // The planner re-derives the same targets on every pass; the runner is what must not
  // re-buy them. Five more passes, zero more requests.
  for (let i = 0; i < 5; i++) {
    const again = await ingestContractReferenceOnDb(d, plan, deps, ON);
    assert.equal(again.requestsIssued, 0, `pass ${i}: settled expirations are not re-asked`);
    assert.equal(again.jobsCompleted, 2);
  }
  assert.equal(spy.calls, 2, "no provider call after the first pass");
});

test("a different expiration range is still a different job", async () => {
  const d = db();
  const spy = { calls: 0 };
  const deps = {
    now: () => WEEKEND,
    fetchContracts: async (u) => { spy.calls += 1; return [{ occ: `O:${u}260807C00180000`, underlying: u, side: "call", strike: 180, expiration: "2026-08-07" }]; },
  };
  await ingestContractReferenceOnDb(d, { underlyings: ["NVDA"], expirationFrom: "2026-07-01", expirationTo: "2026-08-31" }, deps, ON);
  await ingestContractReferenceOnDb(d, { underlyings: ["NVDA"], expirationFrom: "2026-09-01", expirationTo: "2026-10-31" }, deps, ON);
  assert.equal(spy.calls, 2, "the skip is keyed on the window, not on the symbol");
});

test("a failed contract-reference job is retried, unlike a finished one", async () => {
  const d = db();
  let fail = true;
  const plan = { underlyings: ["NVDA"], expirationFrom: "2026-07-01", expirationTo: "2026-08-31" };
  const deps = {
    now: () => WEEKEND,
    fetchContracts: async (u) => {
      if (fail) throw new Error("provider 503");
      return [{ occ: `O:${u}260807C00180000`, underlying: u, side: "call", strike: 180, expiration: "2026-08-07" }];
    },
  };
  await ingestContractReferenceOnDb(d, plan, deps, ON);
  const key = ingestJobKey("contract_reference", "NVDA", "2026-07-01..2026-08-31");
  assert.equal(readIngestProgressOnDb(d, key).status, "FAILED");

  fail = false;
  const retry = await ingestContractReferenceOnDb(d, plan, deps, ON);
  assert.equal(retry.requestsIssued, 1, "a failure is not a terminal state");
  assert.equal(readIngestProgressOnDb(d, key).status, "COMPLETE");
});

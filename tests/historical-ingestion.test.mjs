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
} from "../lib/research/historical/ingestion.ts";
import { readIngestProgressOnDb, ingestJobKey } from "../lib/research/historical/store.ts";

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
  assert.equal(p.status, "COMPLETE");
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
  assert.equal(p.status, "COMPLETE", "the second pass gained nothing, so the window is closed");
  assert.ok(/exhausted short of its end/.test(p.lastNote), "and it records that it stopped short");
  // COMPLETE here means the span was EXAMINED and everything available is stored — which is
  // true. The old bug was claiming that after a CAPPED page, where more data existed and was
  // never fetched. The guard against hiding a gap lives in the coverage diagnostic, which
  // reads the rows rather than this table.
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

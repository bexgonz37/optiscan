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
    fetchQuotes: async (occ, fromMs) => {
      spy.calls += 1;
      return [{ occ, tsMs: fromMs + 1000, bid: 2.0, ask: 2.1 }];
    },
  };
  const first = await ingestOptionQuotesOnDb(d, plan, deps, ON);
  assert.equal(first.rowsWritten, 1);
  assert.equal(spy.calls, 1);

  const second = await ingestOptionQuotesOnDb(d, plan, deps, ON);
  assert.equal(spy.calls, 1, "a COMPLETE window is never re-fetched");
  assert.equal(second.jobsCompleted, 1);
});

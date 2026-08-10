/**
 * tests/historical-miner.test.mjs
 *
 * The planner and the orchestrator. Two properties matter here and neither is about
 * arithmetic:
 *
 *   · the plan is EVIDENCE-CENTRED — windows exist because a real case happened there,
 *     not because a symbol exists
 *   · the orchestrator inherits the refusal — scheduling is not authorization, and a
 *     second caller must hit the same gate
 *
 * Fixture is the SAME migration production runs, not a hand-copy.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildBackfillPlan } from "../lib/research/historical/planner.ts";
import { runHistoricalMinerOnDb } from "../lib/research/historical/miner.ts";
import { advanceIngestProgressOnDb, ingestJobKey } from "../lib/research/historical/store.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const DAY = 86_400_000;
const WEEKEND = Date.parse("2026-08-08T18:00:00.000Z");   // Saturday: closed
const RTH = Date.parse("2026-08-10T15:00:00.000Z");        // Monday 11:00 ET
const ON = { HISTORICAL_INGESTION_ENABLED: "1" };

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

let seq = 0;
function seedCase(d, { symbol = "NVDA", occ = null, atMs = WEEKEND - 2 * DAY, delivered = true } = {}) {
  seq += 1;
  const id = `oc_plan_${seq}`;
  d.prepare(
    `INSERT INTO opportunity_cases
       (opportunity_id, underlying_symbol, detected_at_ms, source_path, acceptance_decision,
        delivery_decision, case_json, created_at_ms, updated_at_ms)
     VALUES (?,?,?,'scanner','accepted',?,?,?,?)`,
  ).run(
    id, symbol, atMs, delivered ? "delivered" : "rejected",
    JSON.stringify(occ ? { selectedContract: { optionSymbol: occ } } : {}),
    atMs, atMs,
  );
  return id;
}

test("the plan is anchored on real cases, not on a symbol list", () => {
  const d = db();
  seedCase(d, { symbol: "NVDA", occ: "O:NVDA260814C00180000" });
  seedCase(d, { symbol: "AMD", occ: "O:AMD260814C00170000" });
  const plan = buildBackfillPlan(d, { nowMs: WEEKEND });

  assert.equal(plan.optionWindows.length, 2);
  for (const w of plan.optionWindows) {
    assert.match(w.reason, /opportunity case oc_plan_/, "every window names the evidence that justifies it");
    assert.ok(w.fromMs < w.anchorMs && w.toMs > w.anchorMs, "the window straddles the event");
    assert.equal(w.priority, 1);
  }
  // Index symbols are always planned for regime reconstruction, at lower priority.
  const idx = plan.underlyingWindows.filter((w) => w.priority === 3).map((w) => w.symbol);
  assert.ok(idx.includes("SPY") && idx.includes("QQQ"));
});

test("an empty case history plans no option windows but still plans regime context", () => {
  const d = db();
  const plan = buildBackfillPlan(d, { nowMs: WEEKEND });
  assert.equal(plan.optionWindows.length, 0, "nothing happened, so nothing is worth buying");
  assert.equal(plan.contractReferenceTargets.length, 0);
  assert.ok(plan.underlyingWindows.length >= 3, "index context is cheap and always useful");
});

test("a case with no frozen contract plans no option window", () => {
  const d = db();
  seedCase(d, { symbol: "TSLA", occ: null });
  const plan = buildBackfillPlan(d, { nowMs: WEEKEND });
  assert.equal(
    plan.optionWindows.length, 0,
    "there is no contract to fetch quotes for; inventing one is exactly the wrong move",
  );
  assert.ok(plan.underlyingWindows.some((w) => w.symbol === "TSLA"), "the underlying is still worth context");
});

test("one contract alerted twice is planned once", () => {
  const d = db();
  const occ = "O:NVDA260814C00180000";
  seedCase(d, { occ, atMs: WEEKEND - 2 * DAY });
  seedCase(d, { occ, atMs: WEEKEND - 1 * DAY });
  const plan = buildBackfillPlan(d, { nowMs: WEEKEND });
  assert.equal(plan.optionWindows.length, 1, "a contract's quotes do not need buying twice");
});

test("a window already COMPLETE is excluded from the plan", () => {
  const d = db();
  const occ = "O:NVDA260814C00180000";
  const atMs = WEEKEND - 2 * DAY;
  seedCase(d, { occ, atMs });
  const first = buildBackfillPlan(d, { nowMs: WEEKEND });
  const w = first.optionWindows[0];

  advanceIngestProgressOnDb(d, {
    jobKey: ingestJobKey("option_quotes", occ, `${w.fromMs}..${w.toMs}`),
    dataset: "option_quotes", subject: occ, timeframe: `${w.fromMs}..${w.toMs}`,
    status: "COMPLETE", nowMs: WEEKEND,
  });

  const second = buildBackfillPlan(d, { nowMs: WEEKEND });
  assert.equal(second.optionWindows.length, 0, "the plan does not re-buy what is already stored");
});

test("delivered scope is the default and excludes undelivered candidates", () => {
  const d = db();
  seedCase(d, { symbol: "NVDA", occ: "O:NVDA260814C00180000", delivered: true });
  seedCase(d, { symbol: "AMD", occ: "O:AMD260814C00170000", delivered: false });
  assert.equal(buildBackfillPlan(d, { nowMs: WEEKEND }).optionWindows.length, 1);
  assert.equal(buildBackfillPlan(d, { nowMs: WEEKEND, scope: "all" }).optionWindows.length, 2);
});

test("the reference window brackets the anchor rather than spanning all time", () => {
  const d = db();
  seedCase(d, { occ: "O:NVDA260814C00180000", atMs: WEEKEND - 2 * DAY });
  const [t] = buildBackfillPlan(d, { nowMs: WEEKEND }).contractReferenceTargets;
  assert.equal(t.underlying, "NVDA");
  assert.ok(t.expirationFrom < t.expirationTo);
  // A contract alerted on day D expires within weeks, not years.
  const spanDays = (Date.parse(t.expirationTo) - Date.parse(t.expirationFrom)) / DAY;
  assert.ok(spanDays > 30 && spanDays < 200, `expiration span should be bounded, got ${spanDays} days`);
});

// ── the orchestrator ─────────────────────────────────────────────────────────

test("the miner refuses during RTH and issues nothing", async () => {
  const d = db();
  seedCase(d, { occ: "O:NVDA260814C00180000" });
  const spy = { bars: 0, contracts: 0, quotes: 0 };
  const res = await runHistoricalMinerOnDb(
    d, { nowMs: RTH },
    {
      now: () => RTH,
      fetchBars: async () => { spy.bars += 1; return []; },
      fetchContracts: async () => { spy.contracts += 1; return []; },
      fetchQuotes: async () => { spy.quotes += 1; return []; },
    },
    ON,
  );
  assert.equal(res.ran, false);
  assert.match(res.skippedReason, /provider priority/);
  assert.deepEqual(spy, { bars: 0, contracts: 0, quotes: 0 }, "scheduling is not authorization");
});

test("off-peak the miner runs its phases in dependency order", async () => {
  const d = db();
  seedCase(d, { symbol: "NVDA", occ: "O:NVDA260814C00180000" });
  const order = [];
  const res = await runHistoricalMinerOnDb(
    d, { nowMs: WEEKEND, maxRunMs: 60_000 },
    {
      now: () => WEEKEND,
      fetchContracts: async (u) => {
        order.push("reference");
        return [{ occ: "O:NVDA260814C00180000", underlying: u, side: "call", strike: 180, expiration: "2026-08-14" }];
      },
      fetchBars: async (symbol, fromMs) => {
        order.push("bars");
        return [{ symbol, timeframe: "1m", tsMs: fromMs, open: 1, high: 1, low: 1, close: 1, volume: 1, vwap: 1 }];
      },
      fetchQuotes: async (occ, fromMs) => {
        order.push("quotes");
        return [{ occ, tsMs: fromMs + 1000, bid: 2.0, ask: 2.1 }];
      },
    },
    ON,
  );
  assert.equal(res.ran, true);
  // Reference before bars before quotes: quotes are useless for a contract we cannot
  // describe or place in a market context.
  assert.equal(order[0], "reference");
  assert.ok(order.indexOf("bars") < order.indexOf("quotes"));
  assert.ok(res.totals.rowsWritten > 0);
  assert.ok(res.coverageAfter.contractReference.rows >= 1);
  assert.ok(res.coverageAfter.optionQuotes.rows >= 1);
});

test("a second identical pass writes no new rows", async () => {
  const d = db();
  seedCase(d, { symbol: "NVDA", occ: "O:NVDA260814C00180000" });
  const deps = {
    now: () => WEEKEND,
    fetchContracts: async (u) => [
      { occ: "O:NVDA260814C00180000", underlying: u, side: "call", strike: 180, expiration: "2026-08-14" },
    ],
    fetchBars: async (symbol, fromMs) => [
      { symbol, timeframe: "1m", tsMs: fromMs, open: 1, high: 1, low: 1, close: 1, volume: 1, vwap: 1 },
    ],
    fetchQuotes: async (occ, fromMs) => [{ occ, tsMs: fromMs + 1000, bid: 2.0, ask: 2.1 }],
  };
  const first = await runHistoricalMinerOnDb(d, { nowMs: WEEKEND, maxRunMs: 60_000 }, deps, ON);
  assert.ok(first.totals.rowsWritten > 0);

  const second = await runHistoricalMinerOnDb(d, { nowMs: WEEKEND, maxRunMs: 60_000 }, deps, ON);
  assert.equal(
    second.totals.rowsWritten, 0,
    "idempotence: the same bounded pass must not add a single row the second time",
  );
});

test("phases can be run one at a time to exercise them in isolation", async () => {
  const d = db();
  seedCase(d, { symbol: "NVDA", occ: "O:NVDA260814C00180000" });
  const spy = { bars: 0, quotes: 0 };
  const res = await runHistoricalMinerOnDb(
    d, { nowMs: WEEKEND, phases: ["reference"] },
    {
      now: () => WEEKEND,
      fetchContracts: async (u) => [
        { occ: "O:NVDA260814C00180000", underlying: u, side: "call", strike: 180, expiration: "2026-08-14" },
      ],
      fetchBars: async () => { spy.bars += 1; return []; },
      fetchQuotes: async () => { spy.quotes += 1; return []; },
    },
    ON,
  );
  assert.equal(res.ran, true);
  assert.deepEqual(spy, { bars: 0, quotes: 0 });
  assert.equal(res.coverageAfter.contractReference.rows, 1);
});

test("no provider key means the miner refuses per dataset rather than throwing", async () => {
  const d = db();
  seedCase(d, { symbol: "NVDA", occ: "O:NVDA260814C00180000" });
  // No injected fetchers, no POLYGON_API_KEY: liveIngestDeps returns {}.
  const res = await runHistoricalMinerOnDb(d, { nowMs: WEEKEND }, { now: () => WEEKEND }, ON);
  assert.equal(res.ran, true, "the gate allowed it");
  assert.equal(res.totals.rowsWritten, 0);
  assert.ok(
    res.phases.every((p) => p.ran === false),
    "each dataset reports 'no fetcher supplied' — a crash would look identical to a bug",
  );
});

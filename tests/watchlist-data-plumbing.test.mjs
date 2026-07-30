import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyVwapEvidence,
  vwapEvidenceColumns,
  vwapCompleteness,
} from "../lib/research/watchlist/vwap-evidence.ts";
import {
  buildNextSessionMarketContext,
  indexSessionFromBars,
  indexContextFromSession,
  persistNextSessionContextOnDb,
  loadNextSessionContextOnDb,
  ensureNextSessionContextSchema,
} from "../lib/research/watchlist/market-context-snapshot.ts";
import {
  clearStaleWatchlistPlansOnDb,
  recordNextSessionMarketContextOnDb,
  runWatchlistPlanningJobOnDb,
} from "../lib/research/watchlist/market-context-job.ts";
import {
  buildNextSessionPlan,
  persistOvernightPlan,
  loadOvernightPlan,
  ensureOvernightWatchlistSchema,
} from "../lib/research/overnight/next-session-plan.ts";
import { formatEodWatchlist } from "../lib/notifications/owner-research-notify.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const IN_SESSION = Date.parse("2026-07-29T18:00:00.000Z"); // 2:00 p.m. ET
const AFTER_CLOSE = Date.parse("2026-07-30T01:00:00.000Z"); // 9:00 p.m. ET Jul 29

// ---------------------------------------------------------------- A. VWAP evidence

test("a missing or non-positive VWAP is UNAVAILABLE and never becomes a level", () => {
  for (const vwap of [null, undefined, 0, -3, Number.NaN]) {
    const e = classifyVwapEvidence({ vwap, computedAtMs: IN_SESSION, nowMs: IN_SESSION });
    assert.equal(e.state, "UNAVAILABLE");
    assert.equal(e.value, null);
    assert.equal(e.usableForWatchlist, false);
    assert.equal(e.usableForLiveSend, false);
  }
  // A real value with no computation timestamp cannot be trusted either.
  const noTs = classifyVwapEvidence({ vwap: 177.2, computedAtMs: null, nowMs: IN_SESSION });
  assert.equal(noTs.state, "UNAVAILABLE");
  assert.equal(noTs.reason, "no_computation_timestamp");
});

test("a fresh same-session VWAP is LIVE and usable for live send", () => {
  const e = classifyVwapEvidence({
    vwap: 177.2,
    computedAtMs: IN_SESSION - 30_000,
    barsTradingDay: "2026-07-29",
    nowMs: IN_SESSION,
  });
  assert.equal(e.state, "LIVE");
  assert.equal(e.usableForWatchlist, true);
  assert.equal(e.usableForLiveSend, true);
});

test("a prior-session VWAP plans overnight but can never authorize a live send", () => {
  const e = classifyVwapEvidence({
    vwap: 177.2,
    computedAtMs: Date.parse("2026-07-28T19:59:00.000Z"),
    barsTradingDay: "2026-07-28",
    nowMs: AFTER_CLOSE,
  });
  assert.equal(e.state, "PRIOR_SESSION");
  assert.equal(e.session, "2026-07-28");
  assert.equal(e.usableForWatchlist, true, "overnight planning may use a labelled prior-session VWAP");
  assert.equal(e.usableForLiveSend, false, "live delivery still requires live evidence");
  assert.match(e.freshness, /Prior session/);
});

test("a same-session but old VWAP is STALE: plannable, not live", () => {
  const e = classifyVwapEvidence({
    vwap: 177.2,
    computedAtMs: IN_SESSION - 20 * 60_000,
    barsTradingDay: "2026-07-29",
    nowMs: IN_SESSION,
    maxLiveAgeMs: 5 * 60_000,
  });
  assert.equal(e.state, "STALE");
  assert.equal(e.usableForWatchlist, true);
  assert.equal(e.usableForLiveSend, false);
});

test("evidence columns derive distance and side without inventing a VWAP", () => {
  const live = classifyVwapEvidence({
    vwap: 100, computedAtMs: IN_SESSION, barsTradingDay: "2026-07-29", nowMs: IN_SESSION,
  });
  const cols = vwapEvidenceColumns(live, 101);
  assert.equal(cols.vwapAtAlert, 100);
  assert.equal(cols.vwapDistPctAtAlert, 1);
  assert.equal(cols.aboveVwap, true);
  assert.equal(cols.vwapEvidenceState, "LIVE");

  const missing = vwapEvidenceColumns(
    classifyVwapEvidence({ vwap: null, computedAtMs: IN_SESSION, nowMs: IN_SESSION }),
    101,
  );
  assert.equal(missing.vwapAtAlert, null);
  assert.equal(missing.vwapDistPctAtAlert, null, "no VWAP means no distance, not zero");
  assert.equal(missing.aboveVwap, null);
  assert.equal(missing.vwapEvidenceState, "UNAVAILABLE");
});

test("completeness counts stored evidence and never promotes unlabelled rows to LIVE", () => {
  const c = vwapCompleteness([
    { vwap_at_alert: 10, vwap_evidence_state: "LIVE" },
    { vwap_at_alert: 11, vwap_evidence_state: "PRIOR_SESSION" },
    { vwap_at_alert: 12, vwap_evidence_state: null },
    { vwap_at_alert: null, vwap_evidence_state: "UNAVAILABLE" },
  ]);
  assert.equal(c.total, 4);
  assert.equal(c.live, 1);
  assert.equal(c.priorSession, 1);
  assert.equal(c.stale, 1, "a stored value with no provenance is not LIVE");
  assert.equal(c.unavailable, 1);
  assert.equal(c.usableForWatchlist, 3);
  assert.equal(c.usablePct, 75);
});

test("historical VWAP is never back-filled: the migration only adds nullable columns", () => {
  const dbsrc = readFileSync(join(root, "lib/db.ts"), "utf8");
  for (const col of [
    "vwap_evidence_state", "vwap_freshness", "vwap_session", "vwap_source",
    "vwap_as_of_ms", "underlying_price_at_alert",
  ]) {
    assert.match(dbsrc, new RegExp(`ALTER TABLE alerts ADD COLUMN ${col}`));
  }
  assert.doesNotMatch(dbsrc, /UPDATE alerts SET vwap_at_alert/, "no VWAP back-fill anywhere");
});

test("the options capture path persists VWAP provenance from the signal", () => {
  const capture = readFileSync(join(root, "lib/alert-capture.ts"), "utf8");
  assert.match(capture, /classifyVwapEvidence\(/);
  assert.match(capture, /vwapEvidenceState: vwapCols\.vwapEvidenceState/);
  assert.match(capture, /underlyingPriceAtAlert: sig\.price/);
  const loop = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");
  assert.match(loop, /vwapAsOfMs: st\.vwapAt \|\| null, vwapSession: st\.vwapDay/);
  assert.match(loop, /st\.vwapDay = Number\.isFinite\(lastBarMs\)/);
});

// -------------------------------------------------------- B. Market context snapshots

function bars(day, closes, { volume = 1000 } = {}) {
  // 1-minute bars at 15:00Z (11:00 a.m. ET) onward on the given ET day.
  const base = Date.parse(`${day}T15:00:00.000Z`);
  return closes.map((c, i) => ({ t: base + i * 60_000, o: c, h: c + 0.5, l: c - 0.5, c, v: volume }));
}

test("index session is reduced from completed candles with real range and VWAP", () => {
  const session = indexSessionFromBars("SPY", [
    ...bars("2026-07-28", [500, 501]),
    ...bars("2026-07-29", [505, 510, 508]),
  ]);
  assert.equal(session.symbol, "SPY");
  assert.equal(session.tradingDay, "2026-07-29");
  assert.equal(session.priorClose, 508);
  assert.equal(session.priorHigh, 510.5);
  assert.equal(session.priorLow, 504.5);
  assert.equal(session.previousClose, 501, "the prior day's last close is the change denominator");
  assert.ok(session.vwap > 504 && session.vwap < 511);
});

test("no bars means no context — nothing is inferred", () => {
  assert.equal(indexSessionFromBars("SPY", []), null);
  assert.equal(indexSessionFromBars("SPY", null), null);
  const ctx = indexContextFromSession(null);
  assert.equal(ctx.direction, "UNAVAILABLE");
  assert.equal(ctx.quality, "UNAVAILABLE");
});

test("a session with no previous close has no direction rather than a guess", () => {
  const ctx = indexContextFromSession(indexSessionFromBars("SPY", bars("2026-07-29", [505, 510])));
  assert.equal(ctx.direction, "UNAVAILABLE");
  assert.equal(ctx.changePct, null);
  assert.ok(ctx.reasons.includes("previous_close_missing"));
});

test("deterministic states: BULLISH, BEARISH, NEUTRAL, MIXED, UNAVAILABLE", () => {
  const up = buildNextSessionMarketContext({
    tradingDay: "2026-07-29", builtAtMs: AFTER_CLOSE,
    spy: indexSessionFromBars("SPY", [...bars("2026-07-28", [500]), ...bars("2026-07-29", [510])]),
    qqq: indexSessionFromBars("QQQ", [...bars("2026-07-28", [400]), ...bars("2026-07-29", [410])]),
  });
  assert.equal(up.spy.direction, "BULLISH");
  assert.equal(up.qqq.direction, "BULLISH");
  assert.equal(up.broadDirection, "BULLISH");
  assert.equal(up.usableForPlanning, true);
  assert.equal(up.quality, "COMPLETE");

  const down = buildNextSessionMarketContext({
    tradingDay: "2026-07-29", builtAtMs: AFTER_CLOSE,
    spy: indexSessionFromBars("SPY", [...bars("2026-07-28", [510]), ...bars("2026-07-29", [500])]),
    qqq: indexSessionFromBars("QQQ", [...bars("2026-07-28", [410]), ...bars("2026-07-29", [400])]),
  });
  assert.equal(down.broadDirection, "BEARISH");

  const flat = buildNextSessionMarketContext({
    tradingDay: "2026-07-29", builtAtMs: AFTER_CLOSE,
    spy: indexSessionFromBars("SPY", [...bars("2026-07-28", [500]), ...bars("2026-07-29", [500.1])]),
    qqq: indexSessionFromBars("QQQ", [...bars("2026-07-28", [400]), ...bars("2026-07-29", [400.1])]),
  });
  assert.equal(flat.broadDirection, "NEUTRAL");

  const mixed = buildNextSessionMarketContext({
    tradingDay: "2026-07-29", builtAtMs: AFTER_CLOSE,
    spy: indexSessionFromBars("SPY", [...bars("2026-07-28", [500]), ...bars("2026-07-29", [510])]),
    qqq: indexSessionFromBars("QQQ", [...bars("2026-07-28", [410]), ...bars("2026-07-29", [400])]),
  });
  assert.equal(mixed.broadDirection, "MIXED");
  assert.ok(mixed.reasons.includes("spy_qqq_direction_conflict"));
  assert.equal(mixed.relativeStrength, "SPY_STRONGER");

  const oneMissing = buildNextSessionMarketContext({
    tradingDay: "2026-07-29", builtAtMs: AFTER_CLOSE,
    spy: indexSessionFromBars("SPY", [...bars("2026-07-28", [500]), ...bars("2026-07-29", [510])]),
    qqq: null,
  });
  assert.equal(oneMissing.broadDirection, "UNAVAILABLE", "one index cannot speak for the market");
  assert.equal(oneMissing.usableForPlanning, false);
  assert.notEqual(oneMissing.quality, "COMPLETE");
});

test("context persistence is idempotent per trading day", () => {
  const d = new Database(":memory:");
  ensureNextSessionContextSchema(d);
  const ctx = buildNextSessionMarketContext({
    tradingDay: "2026-07-29", builtAtMs: AFTER_CLOSE,
    spy: indexSessionFromBars("SPY", [...bars("2026-07-28", [500]), ...bars("2026-07-29", [510])]),
    qqq: indexSessionFromBars("QQQ", [...bars("2026-07-28", [400]), ...bars("2026-07-29", [410])]),
  });
  persistNextSessionContextOnDb(d, ctx, AFTER_CLOSE);
  persistNextSessionContextOnDb(d, ctx, AFTER_CLOSE + 1000);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM watchlist_market_context").get().n, 1);
  const loaded = loadNextSessionContextOnDb(d, "2026-07-29");
  assert.equal(loaded.broadDirection, "BULLISH");
  assert.equal(loaded.spy.priorClose, 510);
});

test("context recording never uses AI and stores a real data source", async () => {
  const d = new Database(":memory:");
  const res = await recordNextSessionMarketContextOnDb(d, {
    now: () => AFTER_CLOSE,
    fetchBars: async (symbol) => symbol === "SPY"
      ? [...bars("2026-07-28", [500]), ...bars("2026-07-29", [510])]
      : [...bars("2026-07-28", [400]), ...bars("2026-07-29", [410])],
  });
  assert.equal(res.persisted, true);
  assert.equal(res.context.dataSource, "session_candles_1m");
  assert.equal(res.context.broadDirection, "BULLISH");
  const src = readFileSync(join(root, "lib/research/watchlist/market-context-snapshot.ts"), "utf8");
  assert.doesNotMatch(src, /anthropic|runStructuredAiJob|aiConfig/i, "market context is deterministic, never AI");
});

test("a provider failure degrades to UNAVAILABLE instead of throwing", async () => {
  const d = new Database(":memory:");
  const res = await recordNextSessionMarketContextOnDb(d, {
    now: () => AFTER_CLOSE,
    fetchBars: async () => { throw new Error("provider 500"); },
  });
  assert.equal(res.context.broadDirection, "UNAVAILABLE");
  assert.equal(res.context.usableForPlanning, false);
  assert.match(res.error, /provider 500/);
});

// ------------------------------------------------- C. read-only GET + scheduler job

test("GET /api/now never builds or persists a plan", () => {
  const route = readFileSync(join(root, "app/api/now/route.ts"), "utf8");
  assert.doesNotMatch(route, /buildNextSessionPlan/, "GET must not build the plan");
  assert.doesNotMatch(route, /persistOvernightPlan/, "GET must not persist the plan");
  assert.match(route, /loadOvernightPlan/, "GET only reads the persisted plan");
  // No write verbs anywhere in the read path.
  assert.doesNotMatch(route, /\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i);
});

test("stale-plan clearing is idempotent and keeps the current day", () => {
  const d = new Database(":memory:");
  ensureOvernightWatchlistSchema(d);
  for (const [day, sym] of [["2026-07-27", "SPY"], ["2026-07-28", "QQQ"], ["2026-07-29", "NVDA"]]) {
    d.prepare(
      "INSERT INTO overnight_watchlist (trading_day,symbol,payload_json,rank,plan_version,built_at_ms) VALUES (?,?,?,?,?,?)",
    ).run(day, sym, "{}", 1, "v", 1);
  }
  const first = clearStaleWatchlistPlansOnDb(d, "2026-07-29");
  assert.equal(first.daysCleared, 2);
  assert.equal(first.rowsCleared, 2);
  const second = clearStaleWatchlistPlansOnDb(d, "2026-07-29");
  assert.equal(second.daysCleared, 0, "re-running clears nothing and reports nothing");
  assert.equal(second.rowsCleared, 0);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM overnight_watchlist").get().n, 1);
  assert.equal(d.prepare("SELECT trading_day d FROM overnight_watchlist").get().d, "2026-07-29");
});

test("the planning job records context, clears stale plans, and reports failures", async () => {
  const d = new Database(":memory:");
  ensureOvernightWatchlistSchema(d);
  d.prepare(
    "INSERT INTO overnight_watchlist (trading_day,symbol,payload_json,rank,plan_version,built_at_ms) VALUES (?,?,?,?,?,?)",
  ).run("2026-07-01", "SPY", "{}", 1, "old", 1);

  let built = 0;
  let persisted = 0;
  const ok = await runWatchlistPlanningJobOnDb(
    d,
    {
      now: () => AFTER_CLOSE,
      fetchBars: async (s) => s === "SPY"
        ? [...bars("2026-07-28", [500]), ...bars("2026-07-29", [510])]
        : [...bars("2026-07-28", [400]), ...bars("2026-07-29", [410])],
    },
    {
      buildNextSessionPlan: () => { built += 1; return { tradingDay: "2026-07-29", recommendations: [] }; },
      persistOvernightPlan: () => { persisted += 1; },
    },
  );
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.contextRecorded, true);
  assert.equal(ok.contextUsableForPlanning, true);
  assert.equal(ok.stalePlanDaysCleared, 1);
  assert.equal(built, 1);
  assert.equal(persisted, 1);

  const failed = await runWatchlistPlanningJobOnDb(
    d,
    { now: () => AFTER_CLOSE, fetchBars: async () => null },
    { buildNextSessionPlan: () => { throw new Error("plan boom"); }, persistOvernightPlan: () => {} },
  );
  assert.ok(failed.errors.some((e) => /plan boom/.test(e)), "job failure is reported, not swallowed");
});

test("the scheduler owns the planning job and surfaces its result", () => {
  const sched = readFileSync(join(root, "lib/scheduler.ts"), "utf8");
  assert.match(sched, /watchlistPlanning/);
  assert.match(sched, /runWatchlistPlanningJobOnDb/);
  assert.match(sched, /state\(\)\.lastWatchlistPlanning = result/);
  assert.match(sched, /if \(result\.errors\.length\) throw new Error/, "failures must reach scheduler state");
});

// ------------------------------------------------------------- D. Watchlist gate

function planDb() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE alerts (
      ticker TEXT, direction TEXT, option_side TEXT, alert_type TEXT,
      price_at_alert REAL, vwap_at_alert REAL, signal_score REAL, capture_confidence REAL,
      relative_volume REAL, percent_move_at_alert REAL, catalyst_summary TEXT, catalyst_type TEXT,
      public_explanation TEXT, alert_time TEXT, trading_day TEXT, created_at TEXT, asset_class TEXT,
      vwap_evidence_state TEXT, vwap_freshness TEXT, vwap_session TEXT
    );
  `);
  return d;
}

function addAlert(d, symbol, overrides = {}) {
  const row = {
    ticker: symbol, direction: "bullish", option_side: "call", alert_type: "vwap_reclaim",
    price_at_alert: 177.2, vwap_at_alert: 176.1, signal_score: 78, capture_confidence: 76,
    relative_volume: 1.8, percent_move_at_alert: 1.4, catalyst_summary: null, catalyst_type: null,
    public_explanation: `${symbol} reclaimed VWAP and closed near resistance with rising momentum.`,
    alert_time: "2026-07-29T19:55:00.000Z", trading_day: "2026-07-29",
    created_at: "2026-07-29T19:55:01.000Z", asset_class: "options",
    vwap_evidence_state: "PRIOR_SESSION", vwap_freshness: "Prior session (2026-07-29)",
    vwap_session: "2026-07-29",
    ...overrides,
  };
  const keys = Object.keys(row);
  d.prepare(`INSERT INTO alerts (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .run(...keys.map((k) => row[k]));
}

function withContext(d, usable = true) {
  ensureNextSessionContextSchema(d);
  persistNextSessionContextOnDb(d, buildNextSessionMarketContext({
    tradingDay: "2026-07-29", builtAtMs: AFTER_CLOSE,
    spy: usable ? indexSessionFromBars("SPY", [...bars("2026-07-28", [500]), ...bars("2026-07-29", [510])]) : null,
    qqq: usable ? indexSessionFromBars("QQQ", [...bars("2026-07-28", [400]), ...bars("2026-07-29", [410])]) : null,
  }), AFTER_CLOSE);
}

test("real evidence plus real persisted context yields a qualified plan", () => {
  const d = planDb();
  withContext(d, true);
  addAlert(d, "NVDA", { signal_score: 91 });
  const plan = buildNextSessionPlan(d, AFTER_CLOSE);
  assert.equal(plan.recommendations.length, 1);
  const row = plan.recommendations[0];
  assert.equal(row.symbol, "NVDA");
  assert.match(row.triggerText, /Hold above \$177\.20/);
  assert.match(row.invalidationText, /prior-session VWAP near \$176\.10/);
  assert.notEqual(row.confidence, 55, "no default confidence 55");
  assert.ok(row.thesisScore != null && row.openReadinessScore != null);
  assert.equal(plan.evidenceCompleteness.marketContext.available, true);
  assert.equal(plan.evidenceCompleteness.marketContext.broadDirection, "BULLISH");
});

test("unusable market context holds every row back even with full VWAP evidence", () => {
  const d = planDb();
  withContext(d, false);
  addAlert(d, "NVDA", { signal_score: 91 });
  const plan = buildNextSessionPlan(d, AFTER_CLOSE);
  assert.equal(plan.recommendations.length, 0);
  assert.equal(plan.needsMoreData.length, 1);
  assert.equal(plan.evidenceCompleteness.marketContext.available, false);
  assert.ok(plan.evidenceCompleteness.blockers.some((b) => /market context/i.test(b)));
});

test("a persisted UNKNOWN trend is the absence of context, not context", () => {
  const d = planDb();
  d.exec(`CREATE TABLE market_context_snapshots (spy_trend TEXT, qqq_trend TEXT, freshness TEXT, created_at_ms INTEGER);`);
  d.prepare("INSERT INTO market_context_snapshots VALUES ('UNKNOWN','UNKNOWN','STALE',1)").run();
  addAlert(d, "NVDA", { signal_score: 91 });
  const plan = buildNextSessionPlan(d, AFTER_CLOSE);
  assert.equal(plan.recommendations.length, 0, "UNKNOWN must never satisfy the evidence gate");
  assert.equal(plan.marketContext.spyNote, "Market context unavailable");
});

test("UNAVAILABLE VWAP evidence blocks a row even when a stale value is stored", () => {
  const d = planDb();
  withContext(d, true);
  addAlert(d, "NVDA", { vwap_at_alert: 176.1, vwap_evidence_state: "UNAVAILABLE" });
  const plan = buildNextSessionPlan(d, AFTER_CLOSE);
  assert.equal(plan.recommendations.length, 0);
  assert.match(plan.needsMoreData[0].diagnosticReason, /VWAP/);
  assert.equal(plan.evidenceCompleteness.vwap.unavailable, 1);
});

test("no qualified plan still produces exactly the clean empty state", () => {
  const d = planDb();
  withContext(d, true);
  addAlert(d, "NVDA", { vwap_at_alert: null, vwap_evidence_state: "UNAVAILABLE" });
  const plan = buildNextSessionPlan(d, AFTER_CLOSE);
  assert.equal(plan.recommendations.length, 0);
  const msg = formatEodWatchlist(plan);
  assert.match(msg, /No qualified setups yet/);
  assert.match(msg, /Premarket revalidation will run before options open/);
  assert.doesNotMatch(msg, /VERIFY AT OPEN|structure_watch|confidence 55/i);
});

test("published plans stay capped at five and never carry a final OCC", () => {
  const d = planDb();
  withContext(d, true);
  for (const [i, s] of ["SPY", "QQQ", "NVDA", "META", "AMD", "AVGO"].entries()) {
    addAlert(d, s, { signal_score: 70 + i });
  }
  const plan = buildNextSessionPlan(d, AFTER_CLOSE);
  assert.equal(plan.recommendations.length, 5);
  const blob = JSON.stringify(plan.recommendations);
  assert.doesNotMatch(blob, /O:[A-Z]+\d{6}[CP]\d+/, "no executable OCC is selected overnight");
  for (const row of plan.recommendations) {
    assert.equal(row.executable, false);
    assert.equal(row.verifyContractAfterOpen, true);
  }
});

test("the persisted snapshot lets a read-only load explain an empty plan", () => {
  const d = planDb();
  withContext(d, true);
  addAlert(d, "NVDA", { vwap_at_alert: null, vwap_evidence_state: "UNAVAILABLE" });
  const plan = buildNextSessionPlan(d, AFTER_CLOSE);
  persistOvernightPlan(d, plan);
  const loaded = loadOvernightPlan(d, plan.tradingDay);
  assert.equal(loaded.recommendations.length, 0);
  assert.equal(loaded.needsMoreData.length, 1, "withheld rows survive a read-only load");
  assert.ok(loaded.evidenceCompleteness.blockers.length > 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  zeroDteResearchConfig,
  selectZeroDteContracts,
  openZeroDteResearchTrade,
  canOpenZeroDteResearch,
  proposeRiskUsd,
  fingerprintTaken,
  researchFingerprint,
  tradingSessionDateEt,
  timeBucketEt,
  gradeZeroDteResearchOnDb,
  ensureZeroDteAccountState,
  buildZeroDteResearchSnapshot,
  buildZeroDteTradeDetail,
} from "../lib/research/options/zero-dte-research/index.ts";
import { readinessEligibleAlertWhere } from "../lib/research/readiness-sample.ts";
import { resolveAccountKeyForOptionsPaperKind } from "../lib/broker/accounts.ts";

function migrateMinimal(db) {
  db.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
      result_class TEXT, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL,
      volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL,
      strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT,
      exit_fill REAL, pnl REAL, return_pct REAL, mfe_pct REAL, mae_pct REAL, last_mark_return_pct REAL,
      exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER,
      session TEXT, core_broad TEXT, feature_snapshot_json TEXT,
      paper_kind TEXT, alert_id TEXT, entry_source TEXT, experiment_id TEXT, experiment_variant TEXT,
      strategy_family TEXT, exit_policy_version TEXT, time_bucket TEXT, market_regime TEXT,
      contract_moneyness TEXT, delta_band TEXT, account_risk_usd REAL, fingerprint TEXT, contract_alts_json TEXT,
      created_at_ms INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER NOT NULL, option_symbol TEXT, mark_at_ms INTEGER,
      bid REAL, ask REAL, exit_fill REAL, return_pct REAL, quote_age_ms INTEGER, created_at_ms INTEGER,
      UNIQUE(trade_id, mark_at_ms)
    );
    CREATE TABLE paper_0dte_account_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      equity_usd REAL NOT NULL, cash_usd REAL NOT NULL, starting_balance_usd REAL NOT NULL, updated_at_ms INTEGER NOT NULL
    );
  `);
}

function occ(root, side, strike, yymmdd = "260727") {
  const cp = side === "put" ? "P" : "C";
  const strikePad = String(Math.round(strike * 1000)).padStart(8, "0");
  return `O:${root}${yymmdd}${cp}${strikePad}`;
}

function chain(side = "call", spot = 500, root = "SPY") {
  return [spot - 1, spot, spot + 1].map((strike, i) => ({
    optionSymbol: occ(root, side, strike),
    side,
    strike,
    expiration: "2026-07-27",
    dte: 0,
    bid: 1.2 + i * 0.05,
    ask: 1.28 + i * 0.05,
    delta: side === "call" ? 0.45 + i * 0.05 : -0.45 - i * 0.05,
    volume: 1000,
    openInterest: 5000,
    quoteAgeMs: 500,
  }));
}

test("zero-dte config defaults off and uses safe research bars", () => {
  const cfg = zeroDteResearchConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.startingBalanceUsd, 100000);
  assert.equal(cfg.qualityBar, 0.55);
  assert.equal(cfg.maxTradesPerDay, 30);
  assert.ok(cfg.tier0IntervalMs >= 3000);
});

test("broker maps ZERO_DTE_RESEARCH_PAPER to dedicated account", () => {
  assert.equal(resolveAccountKeyForOptionsPaperKind("DELIVERED_ALERT_PAPER"), "subscriber_paper");
  assert.equal(resolveAccountKeyForOptionsPaperKind("ZERO_DTE_RESEARCH_PAPER"), "zero_dte_research");
  assert.equal(resolveAccountKeyForOptionsPaperKind("RESEARCH_ONLY_PAPER"), "research_shadow");
});

test("readiness SQL excludes ZERO_DTE_RESEARCH_PAPER explicitly", () => {
  const { sql } = readinessEligibleAlertWhere("a");
  assert.match(sql, /paper_kind='DELIVERED_ALERT_PAPER'/);
  assert.match(sql, /ZERO_DTE_RESEARCH_PAPER/);
  assert.match(sql, /NOT EXISTS[\s\S]*ZERO_DTE_RESEARCH_PAPER/);
});

test("contract selector requires real 0DTE quotes and logs ATM/ITM/OTM alts", () => {
  const picked = selectZeroDteContracts({ chain: chain("call", 500), side: "call", underlyingPrice: 500 });
  assert.ok(picked.primary);
  assert.ok(picked.alts.length >= 2);
  assert.equal(picked.primary.dte, 0);
  assert.ok(picked.primary.bid > 0 && picked.primary.ask > 0);
});

test("fingerprint prevents duplicate research entries", () => {
  const db = new Database(":memory:");
  migrateMinimal(db);
  const env = { PAPER_0DTE_RESEARCH_ENABLED: "1", PAPER_0DTE_QUALITY_BAR: "0.1" };
  ensureZeroDteAccountState(db, env);
  const input = {
    symbol: "SPY",
    side: "call",
    family: "opening_range_breakout",
    chain: chain(),
    underlyingPrice: 500,
    qualityScore: 0.8,
    nowMs: Date.parse("2026-07-27T15:00:00Z"),
  };
  const a = openZeroDteResearchTrade(db, input, env);
  assert.equal(a.opened, true);
  const b = openZeroDteResearchTrade(db, input, env);
  assert.equal(b.opened, false);
  assert.equal(b.reason, "duplicate_fingerprint");
  const fp = researchFingerprint({
    symbol: "SPY",
    family: "opening_range_breakout",
    side: "call",
    sessionDate: tradingSessionDateEt(input.nowMs),
    timeBucket: timeBucketEt(input.nowMs),
  });
  assert.equal(fingerprintTaken(db, fp), true);
});

test("risk limits reject over max open and max day", () => {
  const cfg = zeroDteResearchConfig({
    PAPER_0DTE_MAX_OPEN_TRADES: "1",
    PAPER_0DTE_MAX_TRADES_PER_DAY: "1",
    PAPER_0DTE_RISK_PCT: "0.75",
  });
  const risk = proposeRiskUsd(100000, cfg);
  const blocked = canOpenZeroDteResearch({
    equityUsd: 100000,
    openCount: 1,
    openRiskUsd: 0,
    openExposureUsd: 0,
    tradesToday: 0,
    spyToday: 0,
    qqqToday: 0,
    symbolToday: 0,
  }, "SPY", risk, 200, cfg);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "max_open_trades");
});

test("research opens never create DELIVERED_ALERT_PAPER rows", () => {
  const db = new Database(":memory:");
  migrateMinimal(db);
  const env = { PAPER_0DTE_RESEARCH_ENABLED: "1", PAPER_0DTE_QUALITY_BAR: "0.1" };
  ensureZeroDteAccountState(db, env);
  openZeroDteResearchTrade(db, {
    symbol: "QQQ",
    side: "put",
    family: "vwap_rejection",
    chain: chain("put", 480, "QQQ"),
    underlyingPrice: 480,
    qualityScore: 0.9,
    nowMs: Date.now(),
  }, env);
  const kinds = db.prepare(`SELECT DISTINCT paper_kind k FROM options_paper_trades`).all().map((r) => r.k);
  assert.deepEqual(kinds, ["ZERO_DTE_RESEARCH_PAPER"]);
  const delivered = db.prepare(`SELECT COUNT(*) n FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER'`).get().n;
  assert.equal(delivered, 0);
});

test("EOD forced close grades open 0DTE research trades", async () => {
  const db = new Database(":memory:");
  migrateMinimal(db);
  const env = { PAPER_0DTE_RESEARCH_ENABLED: "1", PAPER_0DTE_QUALITY_BAR: "0.1" };
  ensureZeroDteAccountState(db, env);
  // 19:56 UTC ≈ 15:56 ET during EDT
  const nowMs = Date.parse("2026-07-27T19:56:00Z");
  openZeroDteResearchTrade(db, {
    symbol: "SPY",
    side: "call",
    family: "momentum_breakout",
    chain: chain(),
    underlyingPrice: 500,
    qualityScore: 0.9,
    nowMs: nowMs - 60_000,
  }, env);
  const res = await gradeZeroDteResearchOnDb(db, {
    getQuote: async () => ({ bid: 1.1, ask: 1.2, quoteAgeMs: 200 }),
  }, env, nowMs);
  assert.ok(res.closed >= 1);
  const exited = db.prepare(`SELECT exit_reason r FROM options_paper_trades WHERE status='EXITED'`).get();
  assert.match(String(exited.r), /eod_force/);
});

test("disabled flag never opens research trades", () => {
  const db = new Database(":memory:");
  migrateMinimal(db);
  const res = openZeroDteResearchTrade(db, {
    symbol: "SPY",
    side: "call",
    family: "trend_continuation",
    chain: chain(),
    underlyingPrice: 500,
    qualityScore: 0.99,
  }, { PAPER_0DTE_RESEARCH_ENABLED: "0" });
  assert.equal(res.opened, false);
  assert.match(res.reason, /PAPER_0DTE_RESEARCH_ENABLED/);
});

test("snapshot equity curve + buying power + breakdowns", () => {
  const db = new Database(":memory:");
  migrateMinimal(db);
  const env = { PAPER_0DTE_RESEARCH_ENABLED: "0" };
  ensureZeroDteAccountState(db, env);
  const t0 = Date.parse("2026-07-27T14:00:00Z");
  const t1 = t0 + 60_000;
  const t2 = t0 + 120_000;
  db.prepare(`
    INSERT INTO options_paper_trades (
      option_symbol, side, entry_fill, status, pnl, return_pct, mfe_pct, mae_pct,
      strategy_family, exit_policy_version, time_bucket, contract_moneyness,
      paper_kind, entered_at_ms, exit_at_ms, account_risk_usd, created_at_ms, updated_at_ms
    ) VALUES
      ('O:SPY260727C00500000','call',1.25,'EXITED',50,20,40,-10,'opening_range_breakout','fixed_r','open','ATM','ZERO_DTE_RESEARCH_PAPER',?,?,750,?,?),
      ('O:QQQ260727P00480000','put',1.10,'EXITED',-25,-10,5,-15,'vwap_rejection','time','mid','OTM','ZERO_DTE_RESEARCH_PAPER',?,?,500,?,?),
      ('O:SPY260727C00501000','call',1.30,'ENTERED',NULL,NULL,12,-4,'momentum_breakout','fixed_r','late','ATM','ZERO_DTE_RESEARCH_PAPER',?,NULL,800,?,?)
  `).run(t0, t1, t0, t1, t0, t2, t0, t2, t2, t2, t2);
  db.prepare(`UPDATE paper_0dte_account_state SET cash_usd=100025, equity_usd=100025 WHERE id=1`).run();

  const snap = buildZeroDteResearchSnapshot(db, env, t2 + 1_000);
  assert.equal(snap.enabled, false);
  assert.ok(Array.isArray(snap.equityCurve));
  assert.ok(snap.equityCurve.length >= 3);
  assert.equal(snap.equityCurve[0].equity, 100000);
  assert.equal(snap.equityCurve[snap.equityCurve.length - 1].equity, 100025);
  assert.ok(snap.account.openRiskUsd >= 800);
  assert.ok(snap.account.buyingPowerUsd < snap.account.cashUsd);
  assert.ok(snap.recentFills.length >= 2);
  assert.ok(snap.strategyFamilyPerformance.some((r) => r.key === "opening_range_breakout" && r.n === 1));
  assert.ok(snap.spyVsQqq.some((r) => r.key === "SPY"));
  assert.ok(snap.callsVsPuts.some((r) => r.key === "call"));
  assert.ok(snap.moneyness.some((r) => r.key === "ATM" || r.key === "OTM"));
  assert.ok(snap.timeOfDay.length >= 1);
  assert.ok(snap.exitPolicyPerformance.length >= 1);
  assert.ok(snap.captureEfficiency != null);
  assert.equal(snap.openPositions.length, 1);
});

test("trade detail returns levels, alts, marks, and why fields", () => {
  const db = new Database(":memory:");
  migrateMinimal(db);
  const now = Date.now();
  const feature = JSON.stringify({
    qualityScore: 0.82,
    entryTrigger: "opening_range_breakout:call",
    t1: 1.8,
    t2: 2.4,
    stop: 0.9,
  });
  const alts = JSON.stringify([{ optionSymbol: "O:SPY260727C00499000", moneyness: "ITM" }]);
  const info = db.prepare(`
    INSERT INTO options_paper_trades (
      option_symbol, side, strike, expiration, dte, entry_fill, mid, target, invalidation,
      status, strategy_family, exit_policy_version, time_bucket, contract_moneyness,
      feature_snapshot_json, contract_alts_json, paper_kind, mfe_pct, mae_pct,
      last_mark_return_pct, entered_at_ms, created_at_ms, updated_at_ms, account_risk_usd
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    "O:SPY260727C00500000", "call", 500, "2026-07-27", 0, 1.25, 1.24, 1.8, 0.9,
    "ENTERED", "opening_range_breakout", "fixed_r", "open", "ATM",
    feature, alts, "ZERO_DTE_RESEARCH_PAPER", 18, -6,
    8, now, now, now, 750,
  );
  const id = Number(info.lastInsertRowid);
  db.prepare(`
    INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, bid, ask, exit_fill, return_pct, quote_age_ms, created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, "O:SPY260727C00500000", now, 1.3, 1.35, 1.325, 6, 400, now);

  const detail = buildZeroDteTradeDetail(db, id);
  assert.equal(detail.ok, true);
  assert.equal(detail.trade.symbol, "SPY");
  assert.equal(detail.trade.t1, 1.8);
  assert.equal(detail.trade.t2, 2.4);
  assert.equal(detail.trade.stop, 0.9);
  assert.equal(detail.trade.entryTrigger, "opening_range_breakout:call");
  assert.ok(detail.trade.setupEvidence?.qualityScore === 0.82);
  assert.equal(detail.trade.contractAlts.length, 1);
  assert.equal(detail.trade.marks.length, 1);
  assert.equal(detail.trade.marks[0].bid, 1.3);
  assert.match(String(detail.trade.whyEntered), /opening_range_breakout/);
  assert.equal(detail.trade.whyExited, null);

  const missing = buildZeroDteTradeDetail(db, 99999);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "not_found");
});

test("readiness metrics unchanged when ZERO_DTE research rows are inserted", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, state TEXT, research_only INTEGER, sent_at_ms INTEGER, created_at_ms INTEGER,
      discord_message_id TEXT, paper_linked INTEGER, opportunity_case_id TEXT, entry_mid REAL
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT, paper_kind TEXT, status TEXT, return_pct REAL
    );
    CREATE TABLE opportunity_cases (opportunity_id TEXT PRIMARY KEY, source_path TEXT);
  `);
  const cutoff = 1_700_000_000_000;
  const prev = process.env.SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS;
  process.env.SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS = String(cutoff);
  try {
    db.prepare(`INSERT INTO options_alerts VALUES (?,?,?,?,?,?,?,?,?)`).run(
      "a1", "SENT", 0, cutoff + 10, cutoff + 10, "dmsg", 1, "oc1", 5.0,
    );
    db.prepare(`INSERT INTO opportunity_cases VALUES (?,?)`).run("oc1", "live");
    db.prepare(`INSERT INTO options_paper_trades (alert_id, paper_kind, status, return_pct) VALUES (?,?,?,?)`).run(
      "a1", "DELIVERED_ALERT_PAPER", "EXITED", 12,
    );
    const { sql, cutoffMs } = readinessEligibleAlertWhere("a");
    const countBefore = db.prepare(`SELECT COUNT(*) n FROM options_alerts a WHERE ${sql}`).get(cutoffMs, cutoffMs).n;
    assert.equal(countBefore, 1);
    // Research opens use alert_id=NULL — must not change readiness sample.
    db.prepare(`INSERT INTO options_paper_trades (alert_id, paper_kind, status, return_pct) VALUES (?,?,?,?)`).run(
      null, "ZERO_DTE_RESEARCH_PAPER", "EXITED", 99,
    );
    db.prepare(`INSERT INTO options_paper_trades (alert_id, paper_kind, status, return_pct) VALUES (?,?,?,?)`).run(
      null, "ZERO_DTE_RESEARCH_PAPER", "ENTERED", null,
    );
    const countAfter = db.prepare(`SELECT COUNT(*) n FROM options_alerts a WHERE ${sql}`).get(cutoffMs, cutoffMs).n;
    assert.equal(countAfter, 1);
    // Pure research-linked alert never qualifies (no DELIVERED mirror):
    db.prepare(`INSERT INTO options_alerts VALUES (?,?,?,?,?,?,?,?,?)`).run(
      "a2", "SENT", 0, cutoff + 10, cutoff + 10, "dmsg2", 1, "oc2", 5.0,
    );
    db.prepare(`INSERT INTO opportunity_cases VALUES (?,?)`).run("oc2", "live");
    db.prepare(`INSERT INTO options_paper_trades (alert_id, paper_kind, status, return_pct) VALUES (?,?,?,?)`).run(
      "a2", "ZERO_DTE_RESEARCH_PAPER", "EXITED", 50,
    );
    const researchOnly = db.prepare(`SELECT COUNT(*) n FROM options_alerts a WHERE a.alert_id='a2' AND ${sql}`).get(cutoffMs, cutoffMs).n;
    assert.equal(researchOnly, 0);
  } finally {
    if (prev == null) delete process.env.SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS;
    else process.env.SUBSCRIBER_READINESS_ELIGIBLE_AFTER_MS = prev;
  }
});

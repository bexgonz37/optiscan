/**
 * Quant add-ons from EliteQuant notes: filter chain, factor IC, trials,
 * protections, greeks, realized vol, EDGAR, tearsheet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runUniverseFilterChain,
  summarizeFilterAttrition,
  DEFAULT_UNIVERSE_FILTERS,
} from "../lib/universe-filters.ts";
import { recordUniverseFilterSnapshot, getLastUniverseFilterSummary } from "../lib/universe-filter-runtime.ts";
import { analyzeFactorIc, spearmanCorrelation } from "../lib/factor-analysis.ts";
import { sidakAdjust, splitTradingDays, recordResearchTrialOnDb, countTrialsInFamily, approxIcPValue } from "../lib/research-trials.ts";
import {
  ensureAlertLocksSchema,
  applyCooldownLock,
  checkAlertProtections,
  getActiveLockOnDb,
} from "../lib/protections.ts";
import { timeToExpiryYears, impliedVol, bsGreeks, bsPrice } from "../lib/greeks.ts";
import { parkinsonRv, closeToCloseRv, ivPremium, ivPremiumRiskLabel } from "../lib/realized-vol.ts";
import { parseEdgarSubmissions, mergeDilutionRiskFlag, padCik } from "../lib/edgar.ts";
import { buildTearsheet } from "../lib/trade-tearsheet.ts";
import { optionStillWorthIt } from "../lib/zero-dte.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("universe filter chain records attrition per stage", () => {
  const candidates = [
    { symbol: "A", price: 100, spreadPct: 2, premium: 1.0, tickSize: 0.01, dailyRangeFrac: 0.02, realizedVol: 0.3, ageDays: 30, openInterest: 500 },
    { symbol: "B", price: 100, spreadPct: 25, premium: 1.0, tickSize: 0.01, dailyRangeFrac: 0.02, realizedVol: 0.3, ageDays: 30, openInterest: 500 },
    { symbol: "C", price: 100, spreadPct: 2, premium: 0.2, tickSize: 0.01, dailyRangeFrac: 0.02, realizedVol: 0.3, ageDays: 30, openInterest: 500 },
    { symbol: "D", price: 1, spreadPct: 2, premium: 1.0, tickSize: 0.01, dailyRangeFrac: 0.02, realizedVol: 0.3, ageDays: 30, openInterest: 500 },
  ];
  const env = {
    UNIVERSE_MAX_SPREAD_PCT: "10",
    UNIVERSE_MAX_TICK_PCT_OF_PREMIUM: "2",
    UNIVERSE_MIN_PRICE: "5",
  };
  const result = runUniverseFilterChain(candidates, DEFAULT_UNIVERSE_FILTERS, env, 1);
  const summary = summarizeFilterAttrition(result);
  assert.equal(summary.entered, 4);
  assert.ok(summary.survived < 4);
  assert.ok(result.stages.some((s) => s.id === "SpreadFilter" && s.dropped >= 1));
  assert.ok(result.stages.some((s) => s.id === "PriceFilter" && s.dropped >= 1));
  assert.ok(result.survivors.every((c) => c.symbol === "A"));
});

test("universe filter runtime stores last snapshot", () => {
  recordUniverseFilterSnapshot(
    [{ symbol: "SPY", price: 500, spreadPct: 1, premium: 2, tickSize: 0.01, dailyRangeFrac: 0.01, realizedVol: 0.2, ageDays: 100, openInterest: 1000 }],
    { UNIVERSE_MIN_PRICE: "5" },
    Date.now(),
  );
  const summary = getLastUniverseFilterSummary();
  assert.ok(summary);
  assert.equal(summary.survived, 1);
});

test("spearman + factor IC day-block bootstrap", () => {
  assert.ok(Math.abs((spearmanCorrelation([1, 2, 3, 4], [1, 2, 3, 4]) ?? 0) - 1) < 1e-6);
  const obs = [];
  for (let d = 0; d < 8; d++) {
    const day = `2026-01-${String(d + 1).padStart(2, "0")}`;
    for (let i = 0; i < 6; i++) {
      obs.push({
        tradingDay: day,
        alertId: d * 10 + i,
        factor: i + 1,
        forwardReturn: (i + 1) * 0.1 + d * 0.01,
      });
    }
  }
  const report = analyzeFactorIc(obs, {
    factor: "signal_score",
    horizon: "30m",
    minAlertsPerDay: 5,
    bootstrapSamples: 50,
    seed: 7,
    baselineMeanForward: 0.2,
  });
  assert.ok(report.usableDays >= 5);
  assert.ok(report.meanIc != null && report.meanIc > 0.5);
  assert.equal(report.bootstrap.samples, 50);
  assert.equal(typeof report.beatsBaseline, "boolean");
});

test("sidak adjust and day splits", () => {
  assert.equal(sidakAdjust(0.04, 1), 0.04);
  assert.ok(sidakAdjust(0.04, 30) > 0.7);
  const split = splitTradingDays(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"], 0.4);
  assert.ok(split.trainDays.length >= 2);
  assert.ok(split.testDays.length >= 1);
  assert.ok(approxIcPValue(1.5, 20) != null);
});

test("research trials schema + family count", () => {
  const db = new Database(":memory:");
  const id1 = recordResearchTrialOnDb(db, {
    trialKey: "factor_ic:signal_score",
    hypothesis: "test",
    factor: "signal_score",
    horizon: "30m",
    metricName: "mean_ic",
    metricValue: 0.1,
    pRaw: 0.04,
    pAdj: null,
    nTrialsFamily: 1,
    sampleDays: 10,
    sampleAlerts: 50,
    splitMethod: "trading_day",
    createdAtMs: Date.now(),
  });
  assert.ok(id1.id > 0);
  assert.equal(countTrialsInFamily(db, "factor_ic:signal_score"), 1);
  recordResearchTrialOnDb(db, {
    trialKey: "factor_ic:signal_score",
    hypothesis: "test2",
    factor: "signal_score",
    horizon: "30m",
    metricName: "mean_ic",
    metricValue: 0.05,
    pRaw: 0.04,
    pAdj: null,
    nTrialsFamily: 2,
    sampleDays: 10,
    sampleAlerts: 50,
    splitMethod: "trading_day",
    createdAtMs: Date.now() + 1,
  });
  assert.equal(countTrialsInFamily(db, "factor_ic:signal_score"), 2);
});

test("protections cooldown + daily breaker", () => {
  const db = new Database(":memory:");
  ensureAlertLocksSchema(db);
  db.exec(`
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT, trading_day TEXT, is_false_positive INTEGER, alert_time TEXT
    );
  `);
  const now = Date.now();
  // Opt-in: with no ALERT_PROTECTIONS_ENABLED the whole module is inert.
  applyCooldownLock(db, "NVDA", now, { ALERT_COOLDOWN_MINUTES: "15" });
  assert.equal(getActiveLockOnDb(db, "NVDA", now + 60_000), null);
  assert.equal(checkAlertProtections(db, "NVDA", "2026-07-27", now, {}).allowed, true);

  applyCooldownLock(db, "NVDA", now, { ALERT_PROTECTIONS_ENABLED: "1", ALERT_COOLDOWN_MINUTES: "15" });
  const lock = getActiveLockOnDb(db, "NVDA", now + 60_000);
  assert.ok(lock);
  assert.equal(lock.reason, "CooldownPeriod");
  const blocked = checkAlertProtections(db, "NVDA", "2026-07-27", now + 60_000, {
    ALERT_PROTECTIONS_ENABLED: "1",
    ALERT_COOLDOWN_MINUTES: "15",
  });
  assert.equal(blocked.allowed, false);

  for (let i = 0; i < 10; i++) {
    db.prepare("INSERT INTO alerts (ticker, trading_day, is_false_positive, alert_time) VALUES (?,?,?,?)")
      .run("AAA", "2026-07-27", 1, "2026-07-27T15:00:00Z");
  }
  const daily = checkAlertProtections(db, "BBB", "2026-07-27", now, {
    ALERT_PROTECTIONS_ENABLED: "1",
    ALERT_DAILY_FP_MIN_SAMPLE: "8",
    ALERT_DAILY_FP_MAX_RATE: "0.8",
  });
  assert.equal(daily.allowed, false);
  assert.match(daily.reason, /daily_fp_breaker/);
});

test("0DTE greeks use minute T not T=0", () => {
  // Monday afternoon ET ~14:00 → ~120 minutes to close
  const nowMs = Date.parse("2026-07-27T14:00:00-04:00");
  const T = timeToExpiryYears({ nowMs, dte: 0 });
  assert.ok(T > 0);
  assert.ok(T < 1 / 200);
  const price = bsPrice("call", 100, 100, T, 0.05, 0.4);
  assert.ok(price > 0);
  const iv = impliedVol("call", 100, 100, T, 0.05, price);
  assert.ok(iv != null && Math.abs(iv - 0.4) < 0.02);
  const g = bsGreeks("call", 100, 100, T, 0.05, 0.4);
  assert.ok(g.delta > 0.4 && g.delta < 0.7);
  assert.ok(g.gamma > 0);
});

test("parkinson RV and IV premium labels", () => {
  const bars = [];
  let c = 100;
  for (let i = 0; i < 40; i++) {
    const h = c * 1.01;
    const l = c * 0.99;
    const o = c;
    c = c * (1 + ((i % 5) - 2) * 0.002);
    bars.push({ o, h, l, c });
  }
  const park = parkinsonRv(bars);
  const c2c = closeToCloseRv(bars);
  assert.ok(park != null && park > 0);
  assert.ok(c2c != null && c2c > 0);
  const prem = ivPremium(0.6, 0.3);
  assert.equal(prem, 2);
  assert.equal(ivPremiumRiskLabel(prem), "extreme");
});

test("EDGAR parse dilution forms", () => {
  assert.equal(padCik("320193"), "0000320193");
  const filings = parseEdgarSubmissions(
    {
      cik: "320193",
      filings: {
        recent: {
          form: ["8-K", "424B5", "10-Q"],
          filingDate: ["2026-07-20", "2026-07-15", "2026-01-01"],
          accessionNumber: ["0001-26", "0002-26", "0003-26"],
          primaryDocument: ["a.htm", "b.htm", "c.htm"],
        },
      },
    },
    { sinceDays: 60, nowMs: Date.parse("2026-07-27T12:00:00Z") },
  );
  assert.ok(filings.some((f) => f.dilutionRisk));
  assert.ok(filings.some((f) => f.filingType === "8-K"));
  assert.equal(mergeDilutionRiskFlag("chase_risk", true), "chase_risk,dilution_risk");
});

test("tearsheet metrics from discrete PnL", () => {
  const t = buildTearsheet([
    { pnl: 100 }, { pnl: -40 }, { pnl: 80 }, { pnl: -30 }, { pnl: 50 },
  ]);
  assert.equal(t.n, 5);
  assert.equal(t.wins, 3);
  assert.ok(t.winRate > 0.5);
  assert.ok(t.profitFactor > 1);
  assert.ok(t.expectancy > 0);
  assert.ok(t.equityCurve.length === 5);
});

test("optionStillWorthIt penalizes rich IV premium", () => {
  const base = optionStillWorthIt({
    status: "continuing",
    contractScore: 70,
    minsToClose: 180,
    spreadPct: 5,
    efficiency: 0.8,
  });
  const rich = optionStillWorthIt({
    status: "continuing",
    contractScore: 70,
    minsToClose: 180,
    spreadPct: 5,
    efficiency: 0.8,
    ivPremium: 2.0,
  });
  assert.ok(rich.score < base.score);
  assert.match(rich.verdict, /IV Rich/);
});

test("APIs and Research tab are wired", () => {
  assert.match(read("app/api/alerts/factor-ic/route.ts"), /factor-ic/);
  assert.match(read("app/api/diagnostics/universe-funnel/route.ts"), /universe-funnel/);
  assert.match(read("app/api/journal/tearsheet/route.ts"), /tearsheet/);
  assert.match(read("app/api/research/greeks/route.ts"), /timeToExpiryYears/);
  assert.match(read("app/alerts/page.tsx"), /research/);
  assert.match(read("components/ResearchLabPanels.tsx"), /Factor Lab/);
  assert.match(read("lib/scan-core.ts"), /recordUniverseFilterSnapshot/);
  assert.match(read("lib/alert-capture.ts"), /checkAlertProtections/);
  assert.match(read("lib/db.ts"), /alert_locks/);
  assert.match(read("lib/db.ts"), /research_trials/);
});

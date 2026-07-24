import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLegacyPaperLifecycle,
  buildOptionsPaperLifecycle,
  listRecentPaperLifecycles,
} from "../lib/paper-lifecycle.ts";
import { buildDiscordQualityReport } from "../lib/research/options/delivery-quality-report.ts";
import { ensureBrokerSchemaOnDb, openAccount } from "../lib/broker/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  Database = null;
}

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE paper_trades (
      id INTEGER PRIMARY KEY, ticker TEXT, status TEXT, alert_id INTEGER,
      entry_price REAL, exit_price REAL, entry_at_ms INTEGER, exit_at_ms INTEGER,
      exit_reason TEXT, created_at_ms INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE paper_candidates (
      id INTEGER PRIMARY KEY, idempotency_key TEXT, status TEXT, reject_reason TEXT,
      paper_trade_id INTEGER, ticker TEXT, created_at_ms INTEGER
    );
    CREATE TABLE paper_decisions (
      id INTEGER PRIMARY KEY, trade_id INTEGER, decision TEXT, allowed INTEGER, reason TEXT, created_at_ms INTEGER
    );
    CREATE TABLE paper_trade_outcomes (
      id INTEGER PRIMARY KEY, paper_trade_id INTEGER UNIQUE, grade TEXT, grading_status TEXT,
      return_pct REAL, graded_at_ms INTEGER, updated_at_ms INTEGER, data_quality_status TEXT
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT, state TEXT, paper_linked INTEGER,
      failure_reason TEXT, sent_at_ms INTEGER, attempted_at_ms INTEGER
    );
    CREATE TABLE options_delivery_decisions (
      id INTEGER PRIMARY KEY, alert_id TEXT, outcome TEXT, reason TEXT, quality REAL, tier INTEGER,
      final_delivery_outcome TEXT, final_delivery_reason TEXT, delivery_sent INTEGER, created_at_ms INTEGER
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY, option_symbol TEXT, status TEXT, alert_id TEXT, paper_kind TEXT,
      entry_fill REAL, exit_fill REAL, entered_at_ms INTEGER, exit_at_ms INTEGER, exit_reason TEXT,
      return_pct REAL, pnl REAL, created_at_ms INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE options_candidates (
      id INTEGER PRIMARY KEY, symbol TEXT, state TEXT, why TEXT, created_at_ms INTEGER
    );
  `);
  ensureBrokerSchemaOnDb(d);
  return d;
}

test("lifecycle page + APIs are wired", () => {
  assert.match(read("app/api/paper/lifecycle/route.ts"), /listRecentPaperLifecycles/);
  assert.match(read("app/paper-lifecycle/page.tsx"), /Candidate/);
  assert.match(read("components/AxiomShell.tsx"), /\/paper-lifecycle/);
  assert.match(read("app/api/research/discord-quality/route.ts"), /buildDiscordQualityReport/);
});

test("legacy lifecycle surfaces entry cancel blocker", { skip: !Database }, () => {
  const database = db();
  database
    .prepare(
      `INSERT INTO paper_trades (id, ticker, status, exit_reason, created_at_ms, updated_at_ms)
       VALUES (1,'NVDA','CANCELLED','entry window expired',100,100)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO paper_candidates (id, idempotency_key, status, paper_trade_id, ticker, created_at_ms)
       VALUES (1,'k','CREATED',1,'NVDA',90)`,
    )
    .run();
  const report = buildLegacyPaperLifecycle(database, 1);
  assert.ok(report);
  assert.equal(report.lane, "legacy_primary");
  const entry = report.stages.find((s) => s.stage === "entry_filled");
  assert.equal(entry.status, "FAILED");
  assert.match(entry.reason, /entry window expired/);
  assert.equal(report.blocked, true);
});

test("listRecent works when paper_trades lacks updated_at_ms (prod schema)", { skip: !Database }, () => {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE paper_trades (
      id INTEGER PRIMARY KEY, ticker TEXT, status TEXT, exit_reason TEXT,
      entry_price REAL, exit_price REAL, entry_at_ms INTEGER, exit_at_ms INTEGER, created_at_ms INTEGER
    );
    CREATE TABLE paper_candidates (
      id INTEGER PRIMARY KEY, idempotency_key TEXT, status TEXT, reject_reason TEXT,
      paper_trade_id INTEGER, ticker TEXT, created_at_ms INTEGER
    );
  `);
  database
    .prepare(`INSERT INTO paper_trades (id, ticker, status, created_at_ms) VALUES (9,'IWM','CANCELLED',500)`)
    .run();
  const recent = listRecentPaperLifecycles(database, 10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, "legacy:9");
  assert.equal(recent[0].updatedAtMs, 500);
});

test("options lifecycle marks SENT without paper_linked as failed mirror", { skip: !Database }, () => {
  const database = db();
  database
    .prepare(
      `INSERT INTO options_alerts (alert_id, candidate_symbol, state, paper_linked, sent_at_ms)
       VALUES ('oa_1','SPY','SENT',0,1000)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO options_delivery_decisions
        (alert_id, outcome, reason, quality, tier, final_delivery_outcome, delivery_sent, created_at_ms)
       VALUES ('oa_1','DELIVER_TO_DISCORD','ok',0.8,0,'DELIVERED',1,900)`,
    )
    .run();
  const report = buildOptionsPaperLifecycle(database, { alertId: "oa_1" });
  assert.ok(report);
  const paper = report.stages.find((s) => s.stage === "paper_created");
  assert.equal(paper.status, "FAILED");
  assert.match(paper.reason, /paper_linked=0/);
});

test("options lifecycle reaches broker mirror when link exists", { skip: !Database }, () => {
  const database = db();
  database.pragma("foreign_keys = OFF");
  openAccount(database, {
    accountKey: "subscriber_paper",
    accountType: "SUBSCRIBER_PAPER",
    displayName: "S",
    openingDeposit: 1000,
  });
  const acct = database.prepare(`SELECT id FROM broker_accounts LIMIT 1`).get();
  database
    .prepare(
      `INSERT INTO options_paper_trades
        (id, option_symbol, status, alert_id, paper_kind, entry_fill, entered_at_ms, exit_fill, exit_at_ms, exit_reason, return_pct, pnl, created_at_ms, updated_at_ms)
       VALUES (7,'O:SPY','EXITED','oa_2','DELIVERED_ALERT_PAPER',1.2,1000,1.8,2000,'target_hit',0.5,50,900,2000)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO options_alerts (alert_id, candidate_symbol, state, paper_linked, sent_at_ms)
       VALUES ('oa_2','SPY','SENT',1,950)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO broker_legacy_links
        (id, account_id, legacy_table, legacy_id, entry_fill_id, exit_fill_id, record_schema_version, created_at_ms, updated_at_ms)
       VALUES ('blink_1', ?, 'options_paper_trades', '7', 'bfill_e', 'bfill_x', 3, 1000, 1000)`,
    )
    .run(acct.id);

  process.env.PAPER_BROKER_V2_ENABLED = "1";
  const report = buildOptionsPaperLifecycle(database, { optionTradeId: 7, alertId: "oa_2" });
  const graded = report.stages.find((s) => s.stage === "graded");
  const broker = report.stages.find((s) => s.stage === "broker_mirrored");
  assert.equal(graded.status, "OK");
  assert.equal(broker.status, "OK");
  assert.equal(report.blocked, false);
});

test("discord quality report compares before/after windows", { skip: !Database }, () => {
  const database = db();
  const change = 1_000_000;
  database
    .prepare(
      `INSERT INTO options_delivery_decisions
        (alert_id, outcome, reason, quality, tier, final_delivery_outcome, delivery_sent, created_at_ms)
       VALUES ('a','DELIVER_TO_DISCORD','ok',0.64,1,'DELIVERED',1,?),
              ('b','RESEARCH_ONLY','below',0.58,1,'SKIPPED',0,?),
              ('c','DELIVER_TO_DISCORD','ok',0.82,0,'DELIVERED',1,?)`,
    )
    .run(change - 1000, change - 500, change + 1000);
  const report = buildDiscordQualityReport(
    database,
    { OPTIONS_QUALITY_DELIVER_BAR: "0.7", OPTIONS_MAX_DELIVER_PER_FLUSH: "1", DISCORD_QUALITY_CHANGE_MS: String(change) },
    change + 5000,
  );
  assert.ok(report.before.decisions >= 2);
  assert.ok(report.after.decisions >= 1);
  assert.equal(report.after.falsePositiveProxy, 0);
  assert.ok(report.before.falsePositiveProxy >= 1);
});

test("polygon bulk 429 does not fan out recordNoData; market snap shares cache", () => {
  const src = read("lib/polygon-provider.js");
  assert.match(src, /One shared failure must NOT stamp RATE_LIMITED/);
  assert.match(src, /__optiscanMarketSnap/);
  assert.match(src, /MARKET_SNAP_TTL_MS/);
  assert.match(read("lib/research/options/monitor.ts"), /nearMinuteBudget/);
  assert.match(read("lib/scanner-loop.ts"), /intervalMs \* 0\.5/);
  assert.match(read("app/data/page.tsx"), /Scanner health at a glance/);
});

#!/usr/bin/env node
/**
 * integrity-check.mjs — nightly data-integrity sweep (audit P0-5/T9).
 *
 * Guards the accuracy ledger against silent ungradeability: a TRADE-tier
 * options alert with ZERO options_snapshots rows can never be graded — the
 * exact failure a prior audit found (22/23 TRADE orders unmeasurable).
 *
 * Run after the close (e.g. 20:30 ET cron):
 *   node scripts/integrity-check.mjs            # today's ET trading day
 *   node scripts/integrity-check.mjs 2026-07-06 # a specific day
 *
 * Exit codes: 0 = clean, 1 = integrity problems found (alert on this from
 * cron/uptime tooling), 2 = could not run.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function etTradingDay(ms = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
}

const day = process.argv[2] ?? etTradingDay();

let db;
try {
  const Database = require("better-sqlite3");
  const dbPath = path.join(process.env.ALERT_DB_DIR ?? path.join(root, "data"), "optiscan.db");
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(`[integrity] cannot open database: ${err.message}`);
  process.exit(2);
}

let problems = 0;

// 1. TRADE-tier options alerts with zero live marks (ungradeable).
const ungradeable = db.prepare(`
  SELECT a.id, a.ticker, a.alert_time, a.option_symbol
  FROM alerts a
  WHERE a.trading_day = ?
    AND a.capture_action = 'TRADE'
    AND a.option_symbol IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM options_snapshots s WHERE s.alert_id = a.id)
`).all(day);
if (ungradeable.length) {
  problems += ungradeable.length;
  console.error(`[integrity] ${day}: ${ungradeable.length} TRADE alert(s) with ZERO option snapshots (ungradeable):`);
  for (const a of ungradeable) console.error(`  #${a.id} ${a.ticker} ${a.option_symbol} @ ${a.alert_time}`);
}

// 2. Survivorship guard: alerts still 'tracking' from >2 days ago (delisted /
//    halted names silently drop out of accuracy stats).
const stale = db.prepare(`
  SELECT COUNT(*) AS n FROM alerts
  WHERE status = 'tracking' AND trading_day < date(?, '-2 day')
`).get(day);
if (stale.n > 0) {
  problems += stale.n;
  console.error(`[integrity] ${stale.n} alert(s) stuck in 'tracking' for >2 days — finalize or investigate (survivorship bias).`);
}

// 3. Advisory-lock staleness (informational).
try {
  const lock = db.prepare("SELECT pid, heartbeat_at FROM scanner_lock WHERE id = 1").get();
  if (lock) {
    const age = Date.now() - Date.parse(lock.heartbeat_at);
    if (age > 10 * 60_000) {
      console.error(`[integrity] scanner_lock heartbeat is ${Math.round(age / 60000)} min old (pid ${lock.pid}) — loop may be down.`);
      problems += 1;
    }
  }
} catch { /* table appears after first loop boot */ }

if (problems === 0) {
  console.log(`[integrity] ${day}: clean — all TRADE alerts have marks, no stale trackers.`);
  process.exit(0);
}
console.error(`[integrity] ${day}: ${problems} problem(s) found.`);
process.exit(1);

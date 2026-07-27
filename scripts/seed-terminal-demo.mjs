/**
 * Seed realistic demo rows into data/optiscan.db for terminal screenshots.
 * Does NOT flip PAPER_0DTE_RESEARCH_ENABLED in process env for the running server.
 *
 * Usage: node scripts/seed-terminal-demo.mjs
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbPath = path.join(process.env.ALERT_DB_DIR ?? path.join(process.cwd(), "data"), "optiscan.db");
if (!fs.existsSync(dbPath)) {
  console.error("DB missing:", dbPath, "— start the app once so migrations create it");
  process.exit(1);
}
const db = new Database(dbPath);
const now = Date.now();

function occ(root, side, strike, yymmdd = "260727") {
  const cp = side === "put" ? "P" : "C";
  return `O:${root}${yymmdd}${cp}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

function cols(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
}

// Ensure account state
db.exec(`CREATE TABLE IF NOT EXISTS paper_0dte_account_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  equity_usd REAL NOT NULL, cash_usd REAL NOT NULL, starting_balance_usd REAL NOT NULL, updated_at_ms INTEGER NOT NULL
)`);
const acct = db.prepare("SELECT 1 FROM paper_0dte_account_state WHERE id=1").get();
if (!acct) {
  db.prepare(
    "INSERT INTO paper_0dte_account_state (id, equity_usd, cash_usd, starting_balance_usd, updated_at_ms) VALUES (1,100000,100000,100000,?)",
  ).run(now);
}

const opCols = cols("options_paper_trades");
const hasFamily = opCols.has("strategy_family");

function insertResearch({ symbol, side, family, spot, status, ret, mfe, mae, enteredAgoMs, fingerprint }) {
  const opt = occ(symbol, side, spot);
  const entry = 1.35;
  const t0 = now - enteredAgoMs;
  const exit = status === "EXITED" ? +(entry * (1 + (ret ?? 0) / 100)).toFixed(2) : null;
  const pnl = exit != null ? +((exit - entry) * 100).toFixed(2) : null;
  const base = {
    option_symbol: opt, side, strike: spot, expiration: "2026-07-27", dte: 0,
    result_class: "REAL_OPTION_PAPER", bid: 1.3, ask: 1.4, mid: 1.35, spread_pct: 7.4,
    entry_fill: entry, volume: 1800, open_interest: 9000, delta: side === "call" ? 0.5 : -0.5,
    underlying_price: spot, strategy: family, target: 1.9, invalidation: 0.9,
    provenance: "seed:terminal_demo", status,
    exit_fill: exit, pnl, return_pct: ret ?? null, mfe_pct: mfe ?? null, mae_pct: mae ?? null,
    last_mark_return_pct: status === "ENTERED" ? (ret ?? 8) : null,
    exit_reason: status === "EXITED" ? "fixed_r:target_hit" : null,
    entered_at_ms: t0, exit_at_ms: status === "EXITED" ? t0 + 20 * 60_000 : null,
    paper_kind: "ZERO_DTE_RESEARCH_PAPER", entry_source: "zero_dte_research",
    feature_snapshot_json: JSON.stringify({ qualityScore: 0.8, researchLane: "aggressive_0dte", seed: true, t1: 1.9, t2: 2.3, stop: 0.9 }),
    created_at_ms: t0, updated_at_ms: t0,
  };
  if (hasFamily) {
    Object.assign(base, {
      strategy_family: family,
      exit_policy_version: "fixed_r",
      time_bucket: "mid_morning",
      contract_moneyness: "ATM",
      delta_band: "0.45-0.55",
      account_risk_usd: 750,
      fingerprint,
      contract_alts_json: JSON.stringify([{ moneyness: "ITM1", strike: spot - 1 }, { moneyness: "OTM1", strike: spot + 1 }]),
    });
  }
  // Skip if fingerprint exists
  if (hasFamily && fingerprint) {
    const exists = db.prepare("SELECT 1 FROM options_paper_trades WHERE fingerprint=?").get(fingerprint);
    if (exists) return false;
  }
  const keys = Object.keys(base).filter((k) => opCols.has(k) || ["option_symbol","side","strike","expiration","dte","result_class","bid","ask","mid","spread_pct","entry_fill","volume","open_interest","delta","underlying_price","strategy","target","invalidation","provenance","status","exit_fill","pnl","return_pct","mfe_pct","mae_pct","last_mark_return_pct","exit_reason","entered_at_ms","exit_at_ms","paper_kind","entry_source","feature_snapshot_json","created_at_ms","updated_at_ms"].includes(k));
  const usable = keys.filter((k) => opCols.has(k));
  db.prepare(`INSERT INTO options_paper_trades (${usable.join(",")}) VALUES (${usable.map(() => "?").join(",")})`)
    .run(...usable.map((k) => base[k]));
  return true;
}

let n = 0;
n += insertResearch({ symbol: "SPY", side: "call", family: "opening_range_breakout", spot: 635, status: "ENTERED", ret: 11, mfe: 18, mae: -4, enteredAgoMs: 40 * 60_000, fingerprint: "seed|SPY|orb|open" }) ? 1 : 0;
n += insertResearch({ symbol: "QQQ", side: "put", family: "vwap_rejection", spot: 568, status: "ENTERED", ret: -6, mfe: 5, mae: -12, enteredAgoMs: 25 * 60_000, fingerprint: "seed|QQQ|vwap|open" }) ? 1 : 0;
n += insertResearch({ symbol: "SPY", side: "call", family: "momentum_breakout", spot: 636, status: "ENTERED", ret: 22, mfe: 28, mae: -3, enteredAgoMs: 10 * 60_000, fingerprint: "seed|SPY|mom|open" }) ? 1 : 0;
for (const [i, c] of [
  { symbol: "SPY", side: "call", family: "power_hour_continuation", spot: 630, ret: 28, mfe: 42, mae: -8 },
  { symbol: "QQQ", side: "call", family: "vwap_reclaim", spot: 560, ret: 15, mfe: 22, mae: -5 },
  { symbol: "SPY", side: "put", family: "failed_breakout_reversal", spot: 628, ret: -18, mfe: 6, mae: -24 },
  { symbol: "QQQ", side: "put", family: "support_bounce", spot: 555, ret: 35, mfe: 48, mae: -4 },
  { symbol: "SPY", side: "call", family: "high_of_day_break", spot: 632, ret: 12, mfe: 19, mae: -7 },
].entries()) {
  n += insertResearch({
    ...c, status: "EXITED", enteredAgoMs: (8 - i) * 3600_000, fingerprint: `seed|closed|${c.symbol}|${c.family}|${i}`,
  }) ? 1 : 0;
}

// Recompute equity roughly
const realized = db.prepare(
  "SELECT COALESCE(SUM(pnl),0) s FROM options_paper_trades WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND status='EXITED'",
).get().s;
db.prepare("UPDATE paper_0dte_account_state SET equity_usd=?, cash_usd=?, updated_at_ms=? WHERE id=1")
  .run(100000 + Number(realized), 100000 + Number(realized), now);

// Delivery decisions + alerts for ranked setups
for (let i = 0; i < 4; i++) {
  const alertId = `seed_cc_alert_${i}`;
  const sym = i % 2 === 0 ? "SPY" : "QQQ";
  const side = i % 2 === 0 ? "call" : "put";
  const spot = sym === "SPY" ? 634 + i : 566 + i;
  const opt = occ(sym, side, spot);
  const t = now - i * 6 * 60_000;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO options_alerts (
        alert_id, candidate_symbol, strategy, option_symbol, side, research_only, state, message_hash, message,
        delivered_bid, delivered_ask, delivered_underlying, paper_linked, entry_mid, target_t1, target_stop,
        discord_message_id, opportunity_case_id, sent_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      alertId, sym, i % 2 === 0 ? "momentum_acceleration" : "sr_reclaim", opt, side, 0,
      i === 0 ? "READY" : "SENT", `h${i}`, `seed ${sym}`,
      1.2, 1.3, spot, i === 0 ? 0 : 1, 1.25, 1.7, 0.85,
      i === 0 ? null : `dmsg_${i}`, i === 0 ? null : `oc_seed_${i}`,
      i === 0 ? null : t, t, t,
    );
  } catch (e) { console.warn("alert", e.message); }
  try {
    const exists = db.prepare("SELECT 1 FROM options_delivery_decisions WHERE alert_id=?").get(alertId);
    if (!exists) {
      db.prepare(
        `INSERT INTO options_delivery_decisions (
          batch_id, symbol, strategy, side, tier, outcome, reason, quality, rank, batch_size,
          components_json, alert_id, final_delivery_outcome, final_delivery_reason, created_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        `seed_batch_${i}`, sym, i % 2 === 0 ? "momentum_acceleration" : "sr_reclaim", side, 0,
        i === 3 ? "REJECT" : i === 2 ? "RESEARCH_ONLY" : "DELIVER_TO_DISCORD",
        i === 3 ? "spread_too_wide" : "ranked_top",
        0.9 - i * 0.06, i + 1, 4,
        JSON.stringify({
          optionSymbol: opt, bid: 1.2, ask: 1.3, entryMid: 1.25, targetT1: 1.7, targetStop: 0.85,
          spreadPct: 7.5, entryQuality: i === 3 ? "FAIL" : "PASS",
        }),
        alertId,
        i === 3 ? "REJECTED" : i === 2 ? "RESEARCH_ONLY" : "DELIVER_TO_DISCORD",
        i === 3 ? "spread_too_wide" : "portfolio_selected",
        t,
      );
    }
  } catch (e) { console.warn("decision", e.message); }
  if (i > 0) {
    try {
      const exists = db.prepare("SELECT 1 FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER'").get(alertId);
      if (!exists) {
        db.prepare(
          `INSERT INTO options_paper_trades (
            option_symbol, side, strike, expiration, dte, result_class, bid, ask, mid, spread_pct, entry_fill,
            volume, open_interest, delta, underlying_price, strategy, target, invalidation, provenance, status,
            return_pct, mfe_pct, mae_pct, last_mark_return_pct, entered_at_ms, paper_kind, alert_id, entry_source,
            created_at_ms, updated_at_ms
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          opt, side, spot, "2026-07-27", 0, "REAL_OPTION_PAPER", 1.2, 1.3, 1.25, 8, 1.25,
          900, 4000, 0.5, spot, i % 2 === 0 ? "momentum_acceleration" : "sr_reclaim", 1.7, 0.85,
          "seed:delivered", i === 1 ? "ENTERED" : "EXITED",
          i === 1 ? null : 18 - i * 4, 28, -5, i === 1 ? 8.2 : null, t,
          "DELIVERED_ALERT_PAPER", alertId, "discord_sent", t, t,
        );
      }
    } catch (e) { console.warn("delivered", e.message); }
  }
}

// Seed mark paths for sparklines (DB-only, review demo)
try {
  const openTrades = db.prepare(
    `SELECT id, option_symbol, entry_fill, last_mark_return_pct FROM options_paper_trades
     WHERE status='ENTERED' AND (paper_kind='ZERO_DTE_RESEARCH_PAPER' OR paper_kind='DELIVERED_ALERT_PAPER')`,
  ).all();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO options_paper_marks
      (trade_id, option_symbol, mark_at_ms, bid, ask, exit_fill, return_pct, quote_age_ms, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  let marks = 0;
  for (const tr of openTrades) {
    const entry = Number(tr.entry_fill ?? 1.25);
    const finalRet = Number(tr.last_mark_return_pct ?? 8);
    for (let i = 0; i < 12; i++) {
      const ret = +(finalRet * (i / 11)).toFixed(2);
      const mid = +(entry * (1 + ret / 100)).toFixed(3);
      const t = now - (12 - i) * 3 * 60_000;
      try {
        ins.run(tr.id, tr.option_symbol, t, mid - 0.02, mid + 0.02, mid, ret, 800, t);
        marks += 1;
      } catch { /* */ }
    }
  }
  // Extra alert underlying history for SPY/QQQ sparks
  for (let i = 0; i < 10; i++) {
    const t = now - (10 - i) * 8 * 60_000;
    const spy = 632 + i * 0.4;
    const qqq = 564 + i * 0.35;
    try {
      db.prepare(
        `INSERT OR IGNORE INTO options_alerts (
          alert_id, candidate_symbol, strategy, option_symbol, side, research_only, state, message_hash, message,
          delivered_underlying, paper_linked, created_at_ms, updated_at_ms, sent_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        `seed_spark_spy_${i}`, "SPY", "momentum_acceleration", `O:SPY260727C00${634 + i}000`, "call", 0,
        "SENT", `spark${i}`, "seed spark", spy, 1, t, t, t,
      );
    } catch { /* */ }
    try {
      db.prepare(
        `INSERT OR IGNORE INTO options_alerts (
          alert_id, candidate_symbol, strategy, option_symbol, side, research_only, state, message_hash, message,
          delivered_underlying, paper_linked, created_at_ms, updated_at_ms, sent_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        `seed_spark_qqq_${i}`, "QQQ", "sr_reclaim", `O:QQQ260727P00${566 + i}000`, "put", 0,
        "SENT", `sparkq${i}`, "seed spark", qqq, 1, t, t, t,
      );
    } catch { /* */ }
  }
  console.log(JSON.stringify({ ok: true, dbPath, researchInserted: n, equity: 100000 + Number(realized), marksSeeded: marks }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ok: true, dbPath, researchInserted: n, equity: 100000 + Number(realized), markError: String(e.message ?? e) }, null, 2));
}

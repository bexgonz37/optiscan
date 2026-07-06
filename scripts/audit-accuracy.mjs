/**
 * audit-accuracy.mjs — bucket today's trade-tier alerts by failure mode vs 5m move.
 * Usage: node scripts/audit-accuracy.mjs [YYYY-MM-DD]
 */
import Database from "better-sqlite3";
import { computeTradeVerdict, isClearTradeSignal, hasLiveSpeedProof, MIN_SPEED_PCT_PER_MIN } from "../lib/trade-verdict.ts";
import { EARLY_MOVE_WIN_PCT } from "../lib/early-accuracy.ts";

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const dbPath = process.env.ALERT_DB_DIR
  ? `${process.env.ALERT_DB_DIR}/optiscan.db`
  : "data/optiscan.db";

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (err) {
  console.error(`Cannot open ${dbPath}:`, err.message);
  process.exit(1);
}

const move5m = db.prepare(
  `SELECT percent_move_from_alert FROM alert_performance WHERE alert_id=? AND checkpoint='5m'`,
);

function parseFlags(raw) {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function alertInput(a) {
  return {
    ticker: a.ticker,
    direction: a.direction,
    trade_bias: a.trade_bias,
    signal_score: a.signal_score,
    risk_score: a.risk_score,
    option_worth_score: a.option_worth_score,
    worth_verdict: a.worth_verdict,
    zero_dte_contract_score: a.zero_dte_contract_score,
    options_liquidity_score: a.options_liquidity_score,
    move_status: a.move_status,
    risk_flags: a.risk_flags,
    option_side: a.option_side,
    strike: a.strike,
    dte: a.dte,
    percent_move_at_alert: a.percent_move_at_alert,
    relative_volume: a.relative_volume,
    short_rate_at_alert: a.short_rate_at_alert,
    volume_surge_at_alert: a.volume_surge_at_alert,
    long_call_score: a.long_call_score,
    long_put_score: a.long_put_score,
    alert_tier: a.alert_tier,
  };
}

function liveAtCapture(a) {
  return {
    shortRate: a.short_rate_at_alert,
    surge: a.volume_surge_at_alert,
    direction: a.direction,
  };
}

function sideFromAlert(a) {
  return a.option_side === "put" ? "PUT" : a.option_side === "call" ? "CALL" : "NONE";
}

const alerts = db.prepare(
  `SELECT * FROM alerts WHERE trading_day=? AND alert_tier='trade' ORDER BY id`,
).all(day);

console.log(`\n=== Accuracy audit for ${day} ===`);
console.log(`Trade-tier alerts: ${alerts.length}\n`);

if (!alerts.length) {
  console.log("No trade-tier alerts for this day.");
  process.exit(0);
}

const buckets = {
  surge_only: { n: 0, wins: 0, moves: [] },
  setup_55_74: { n: 0, wins: 0, moves: [] },
  setup_75_plus: { n: 0, wins: 0, moves: [] },
  fake_breakout_flag: { n: 0, wins: 0, moves: [] },
  exhausted_or_risky: { n: 0, wins: 0, moves: [] },
  negative_speed: { n: 0, wins: 0, moves: [] },
  trade_at_capture: { n: 0, wins: 0, moves: [] },
  wait_at_capture: { n: 0, wins: 0, moves: [] },
  clear_at_capture: { n: 0, wins: 0, moves: [] },
  no_5m_yet: { n: 0, wins: 0, moves: [] },
};

let earlyWins = 0;
let earlyGraded = 0;
let tradeCaptureWins = 0;
let tradeCaptureGraded = 0;
let clearWins = 0;
let clearGraded = 0;

for (const a of alerts) {
  const m5row = move5m.get(a.id);
  const m5 = m5row?.percent_move_from_alert ?? null;
  const win = m5 != null && m5 >= EARLY_MOVE_WIN_PCT;
  if (m5 != null) {
    earlyGraded++;
    if (win) earlyWins++;
  } else {
    buckets.no_5m_yet.n++;
  }

  const live = liveAtCapture(a);
  const v = computeTradeVerdict(alertInput(a), live);
  const clear = isClearTradeSignal(alertInput(a), live);
  const side = sideFromAlert(a);
  const speedProof = hasLiveSpeedProof(alertInput(a), side, live);
  const surgeOnly = !speedProof && (a.volume_surge_at_alert ?? 0) >= 1.3;
  const flags = parseFlags(a.risk_flags);

  function add(bucket) {
    bucket.n++;
    if (m5 != null) {
      bucket.moves.push(m5);
      if (win) bucket.wins++;
    }
  }

  if (surgeOnly) add(buckets.surge_only);
  if ((a.signal_score ?? 0) >= 55 && (a.signal_score ?? 0) < 75) add(buckets.setup_55_74);
  if ((a.signal_score ?? 0) >= 75) add(buckets.setup_75_plus);
  if (flags.includes("Fake Breakout Risk")) add(buckets.fake_breakout_flag);
  if (a.move_status === "exhausted" || a.move_status === "extended_risky") add(buckets.exhausted_or_risky);
  if (a.short_rate_at_alert != null && Math.abs(a.short_rate_at_alert) < MIN_SPEED_PCT_PER_MIN) add(buckets.negative_speed);

  if (v.action === "TRADE") {
    add(buckets.trade_at_capture);
    if (m5 != null) {
      tradeCaptureGraded++;
      if (win) tradeCaptureWins++;
    }
  } else if (v.action === "WAIT") {
    add(buckets.wait_at_capture);
  }
  if (clear) {
    add(buckets.clear_at_capture);
    if (m5 != null) {
      clearGraded++;
      if (win) clearWins++;
    }
  }
}

function pct(w, n) {
  return n > 0 ? `${Math.round((w / n) * 100)}%` : "—";
}

function avg(arr) {
  return arr.length ? (arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(3) : "—";
}

console.log("--- Early hit rate @ 5m (≥" + EARLY_MOVE_WIN_PCT + "%) ---");
console.log(`  All trade-tier:     ${earlyWins}/${earlyGraded} (${pct(earlyWins, earlyGraded)})`);
console.log(`  TRADE at capture:   ${tradeCaptureWins}/${tradeCaptureGraded} (${pct(tradeCaptureWins, tradeCaptureGraded)})`);
console.log(`  Clear signal:       ${clearWins}/${clearGraded} (${pct(clearWins, clearGraded)})`);
console.log(`  Pending 5m:         ${buckets.no_5m_yet.n} alerts\n`);

console.log("--- Failure mode buckets (avg move @ 5m | early win rate) ---");
for (const [name, b] of Object.entries(buckets)) {
  if (name === "no_5m_yet") continue;
  const graded = b.moves.length;
  console.log(`  ${name.padEnd(22)} n=${String(b.n).padStart(3)}  avg5m=${avg(b.moves).padStart(7)}%  win=${pct(b.wins, graded)} (${b.wins}/${graded})`);
}

const top = alerts
  .map((a) => {
    const m5row = move5m.get(a.id);
    return { ticker: a.ticker, m5: m5row?.percent_move_from_alert ?? null, setup: a.signal_score, sr: a.short_rate_at_alert };
  })
  .filter((r) => r.m5 != null && r.m5 >= EARLY_MOVE_WIN_PCT)
  .sort((a, b) => b.m5 - a.m5);

console.log("\n--- Early winners ---");
for (const r of top.slice(0, 10)) {
  console.log(`  ${r.ticker.padEnd(6)} +${r.m5?.toFixed(2)}%  setup=${r.setup}  speed=${r.sr?.toFixed(2) ?? "n/a"}/min`);
}

db.close();

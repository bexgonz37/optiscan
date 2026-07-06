/**
 * calibrate-accuracy.mjs — sweep threshold combos on historical alerts to find
 * best early hit rate @ 5m while keeping min daily volume.
 * Usage: node scripts/calibrate-accuracy.mjs [--days=14] [--min-volume=40]
 */
import Database from "better-sqlite3";
import { computeTradeVerdict, passesQualityGates, hasLiveSpeedProof } from "../lib/trade-verdict.ts";
import { EARLY_MOVE_WIN_PCT } from "../lib/early-accuracy.ts";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const days = Number(args.days ?? 14);
const minVolume = Number(args["min-volume"] ?? 40);

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

const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

const rows = db.prepare(
  `SELECT a.*, p.percent_move_from_alert AS move_5m
   FROM alerts a
   LEFT JOIN alert_performance p ON p.alert_id = a.id AND p.checkpoint = '5m'
   WHERE a.trading_day >= ? AND a.alert_tier = 'trade'`,
).all(since);

const byDay = new Map();
for (const r of rows) {
  byDay.set(r.trading_day, (byDay.get(r.trading_day) ?? 0) + 1);
}
const avgDaily = byDay.size ? [...byDay.values()].reduce((s, n) => s + n, 0) / byDay.size : 0;

console.log(`\n=== Calibrate accuracy (${days}d, ${rows.length} trade-tier alerts) ===`);
console.log(`Avg callouts/day: ${avgDaily.toFixed(1)} | Target min volume: ${minVolume}/day\n`);

function wouldPass(a, { minSetup, minSpeed, minSurge, minEff, requireTradeCapture }) {
  if ((a.signal_score ?? 0) < minSetup) return false;
  if (a.efficiency != null && a.efficiency < minEff) return false;
  const sr = Math.abs(a.short_rate_at_alert ?? 0);
  const surge = a.volume_surge_at_alert ?? 0;
  if (sr < minSpeed && surge < minSurge) return false;

  const live = { shortRate: a.short_rate_at_alert, surge: a.volume_surge_at_alert, direction: a.direction };
  const input = {
    ticker: a.ticker, direction: a.direction, trade_bias: a.trade_bias,
    signal_score: a.signal_score, risk_score: a.risk_score,
    option_worth_score: a.option_worth_score, worth_verdict: a.worth_verdict,
    zero_dte_contract_score: a.zero_dte_contract_score,
    options_liquidity_score: a.options_liquidity_score,
    move_status: a.move_status, risk_flags: a.risk_flags,
    short_rate_at_alert: a.short_rate_at_alert, volume_surge_at_alert: a.volume_surge_at_alert,
    long_call_score: a.long_call_score, long_put_score: a.long_put_score,
  };
  const side = a.option_side === "put" ? "PUT" : "CALL";
  const v = computeTradeVerdict(input, live);
  if (requireTradeCapture && v.action !== "TRADE") return false;
  if (!requireTradeCapture) {
    const qg = passesQualityGates(input);
    const sp = hasLiveSpeedProof(input, side, live);
    if (!qg && !sp) return false;
  }
  return true;
}

function scoreCombo(params) {
  const kept = rows.filter((r) => wouldPass(r, params));
  const graded = kept.filter((r) => r.move_5m != null);
  const wins = graded.filter((r) => r.move_5m >= EARLY_MOVE_WIN_PCT).length;
  const hitRate = graded.length ? wins / graded.length : 0;
  const estDaily = (kept.length / Math.max(1, byDay.size));
  return { ...params, kept: kept.length, graded: graded.length, wins, hitRate, estDaily };
}

const setups = [62, 65, 68, 75];
const speeds = [0.15, 0.18, 0.2, 0.22];
const surges = [1.3, 1.4, 1.5];
const effs = [0.3, 0.35, 0.4];
const tradeOnly = [false, true];

const results = [];
for (const minSetup of setups) {
  for (const minSpeed of speeds) {
    for (const minSurge of surges) {
      for (const minEff of effs) {
        for (const requireTradeCapture of tradeOnly) {
          results.push(scoreCombo({ minSetup, minSpeed, minSurge, minEff, requireTradeCapture }));
        }
      }
    }
  }
}

const eligible = results.filter((r) => r.estDaily >= minVolume && r.graded >= 5);
eligible.sort((a, b) => {
  const distA = Math.abs(a.hitRate - 0.7);
  const distB = Math.abs(b.hitRate - 0.7);
  if (Math.abs(distA - distB) > 0.01) return distA - distB;
  return b.estDaily - a.estDaily;
});

console.log("Top 5 combos (closest to 70% hit @ 5m, volume ≥ min):");
for (const r of eligible.slice(0, 5)) {
  console.log(
    `  setup≥${r.minSetup} speed≥${r.minSpeed} surge≥${r.minSurge} eff≥${r.minEff} tradeOnly=${r.requireTradeCapture}` +
    ` → hit=${Math.round(r.hitRate * 100)}% (${r.wins}/${r.graded}) estDaily=${r.estDaily.toFixed(1)}`,
  );
}

const best = eligible[0];
if (best) {
  console.log("\nRecommended .env.local / Settings:");
  console.log(`  ALERT_MIN_MOMENTUM_SCORE=${best.minSetup}`);
  console.log(`  SCANNER_MIN_RATE_PCT_MIN=${best.minSpeed}`);
  console.log(`  SCANNER_MIN_VOL_SURGE=${best.minSurge}`);
  console.log(`  SCANNER_MIN_EFFICIENCY=${best.minEff}`);
  console.log(`  # requireTradeCapture=${best.requireTradeCapture} (tier rule — already in code)`);
} else {
  console.log("\nNo combo met min volume + graded threshold. Try lowering --min-volume or collecting more data.");
}

db.close();

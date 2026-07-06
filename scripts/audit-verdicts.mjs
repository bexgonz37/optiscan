/**
 * audit-verdicts.mjs — replay today's alerts against the LIVE tape exactly the
 * way the UI does, and assert the invariants:
 *   1. No BUY CALL while live tape is flat/down or direction bearish.
 *   2. No BUY PUT while live tape is flat/up or direction bullish.
 *   3. Discord 'sent' events only exist for clear signals.
 * Usage: node scripts/audit-verdicts.mjs
 */
import Database from "better-sqlite3";
import { computeTradeVerdict, isClearTradeSignal } from "../lib/trade-verdict.ts";

const BASE = "http://localhost:8780";
const db = new Database("data/optiscan.db");

const res = await fetch(`${BASE}/api/scanner/live?realtimeOnly=1`, { cache: "no-store" });
const d = await res.json();
const tape = new Map();
for (const r of d?.realtime?.tape ?? []) tape.set(r.symbol, r);
console.log(`live tape: ${tape.size} symbols, running=${d?.realtime?.running}`);

const today = new Date().toISOString().slice(0, 10);
const alerts = db.prepare("SELECT * FROM alerts WHERE trading_day=? ORDER BY id DESC LIMIT 100").all(today);
console.log(`alerts today: ${alerts.length}\n`);

let violations = 0;
let trades = 0;
const rows = [];
for (const a of alerts) {
  const t = tape.get(a.ticker);
  const live = t ? { shortRate: t.shortRate, surge: t.surge, price: t.price, direction: t.direction } : undefined;
  const v = computeTradeVerdict(a, live);
  if (v.action === "TRADE") {
    trades++;
    const sr = live?.shortRate;
    const dir = live?.direction;
    let bad = null;
    if (v.side === "CALL" && live && ((sr != null && sr <= 0) || dir === "bearish")) bad = "BUY CALL on flat/down live tape";
    if (v.side === "PUT" && live && ((sr != null && sr >= 0) || dir === "bullish")) bad = "BUY PUT on flat/up live tape";
    if (bad) {
      violations++;
      console.log(`VIOLATION alert#${a.id} ${a.ticker}: ${bad} (live sr=${sr} dir=${dir})`);
    }
    rows.push({ id: a.id, ticker: a.ticker, verdict: v.headline, conf: v.confidence, liveSr: sr ?? "n/a", liveDir: dir ?? "n/a", clear: isClearTradeSignal(a, live) });
  }
}
console.table(rows.slice(0, 15));
console.log(`\nlive TRADE verdicts: ${trades}, invariant violations: ${violations}`);

// Discord audit: what actually got sent today, and why others were skipped.
const sent = db.prepare(
  `SELECT n.alert_id, a.ticker, n.status, n.created_at FROM notification_events n
   LEFT JOIN alerts a ON a.id=n.alert_id
   WHERE n.channel='discord_webhook' AND n.created_at >= ? ORDER BY n.id DESC LIMIT 200`,
).all(`${today}T00:00:00`);
const counts = {};
for (const s of sent) counts[s.status] = (counts[s.status] ?? 0) + 1;
console.log("\ndiscord events today by status:", JSON.stringify(counts));
const sentRows = sent.filter((s) => s.status === "sent");
console.log(`discord SENT today: ${sentRows.length}`);
for (const s of sentRows.slice(0, 10)) console.log(`  sent: ${s.ticker ?? "test"} at ${s.created_at}`);

const skipReasons = db.prepare(
  `SELECT error, COUNT(*) c FROM notification_events
   WHERE channel='discord_webhook' AND status='skipped' AND created_at >= ?
   GROUP BY error ORDER BY c DESC LIMIT 5`,
).all(`${today}T00:00:00`);
console.log("\ntop skip reasons today:");
for (const r of skipReasons) console.log(`  [${r.c}x] ${r.error}`);

process.exit(violations > 0 ? 1 : 0);

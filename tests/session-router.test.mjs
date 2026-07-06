/**
 * SPEC tests for the session router (same style as architecture.test.mjs):
 * source-level guarantees that stock capture never touches option chains and
 * that options capture is suppressed outside regular hours.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("SPEC: stock capture NEVER fetches an option chain", () => {
  const src = read("lib/stock-capture.ts");
  assert.ok(!src.includes("fetchOptionChain"), "stock-capture must not import/call fetchOptionChain");
  assert.ok(!src.includes("rankZeroDteContracts"), "stock-capture must not rank contracts");
  const signals = read("lib/stock-signals.ts");
  assert.ok(!signals.includes("fetchOptionChain"), "stock-signals must stay underlying-only");
});

test("SPEC: options capture is session-guarded (no 0DTE callouts outside RTH)", () => {
  const cap = read("lib/alert-capture.ts");
  assert.ok(cap.includes("isOptionsSession"), "captureZeroDte must import the RTH guard");
  const beforeInsert = cap.slice(0, cap.indexOf("insertAlert({"));
  assert.ok(/if \(!isOptionsSession\(nowMs\)\) return null/.test(beforeInsert), "guard must run before any insert");
});

test("SPEC: scanner loop routes triggers by session and pauses when closed", () => {
  const loop = read("lib/scanner-loop.ts");
  assert.ok(loop.includes("marketSession"), "loop must read the market session");
  assert.ok(loop.includes("handleStockTrigger"), "loop needs a stock trigger path");
  assert.ok(/session === "closed"/.test(loop), "loop must pause when closed");
  assert.ok(/session === "regular"\s*\?\s*handleTrigger/.test(loop), "options trigger only in RTH");
  // Live option-quote refresh (chain fetches) must be RTH-gated too.
  assert.ok(/if \(session === "regular"\) refreshActiveAlerts/.test(loop), "active-alert chain refresh is RTH-only");
});

test("SPEC: stock alerts persist asset_class + session; options stamp regular", () => {
  const stock = read("lib/stock-capture.ts");
  assert.ok(stock.includes('assetClass: "stock"'), "stock alerts must persist asset_class='stock'");
  assert.ok(stock.includes("session"), "stock alerts must persist their session");
  const cap = read("lib/alert-capture.ts");
  assert.ok(cap.includes('assetClass: "options"'), "options alerts must persist asset_class='options'");
  const db = read("lib/db.ts");
  assert.ok(db.includes("asset_class"), "db migration must add asset_class");
  assert.ok(db.includes('["session"'), "db migration must add session");
});

test("SPEC: stock capture keeps the catalysts-never-block rule", () => {
  const src = read("lib/stock-capture.ts");
  assert.ok(src.includes("attachCatalystLater"), "late catalyst attach required");
  const beforeInsert = src.slice(0, src.indexOf("insertAlert({"));
  assert.ok(!beforeInsert.includes("await fetchNews"), "news must not be awaited before insert");
});

test("SPEC: Discord stock wording has no option contract line", () => {
  const fmt = read("lib/alert-format.js");
  const stockFn = fmt.slice(fmt.indexOf("formatDiscordStockAlert"), fmt.indexOf("export function formatDiscordAlert"));
  assert.ok(stockFn.length > 0, "formatDiscordStockAlert must exist");
  assert.ok(!stockFn.includes("contractLine"), "stock Discord message must not include a contract line");
  assert.ok(!/strike|DTE/i.test(stockFn), "stock Discord message must not mention strike/DTE");
  assert.ok(stockFn.includes("not financial advice"), "research-language disclaimer required");
});

test("SPEC: options alerts never notify outside RTH (Discord + swing capture)", () => {
  const notif = read("lib/notifications.ts");
  assert.ok(notif.includes("isOptionsSession"), "notifyNewAlert must session-guard options");
  const cap = read("lib/alert-capture.ts");
  const capAlerts = cap.slice(cap.indexOf("export async function captureAlerts"));
  assert.ok(/if \(!isOptionsSession\(nowMs\)\) return/.test(capAlerts), "captureAlerts must no-op outside RTH");
  const verdict = read("lib/trade-verdict.ts");
  assert.ok(verdict.includes("isStockAlert"), "trade verdict must distinguish stock vs options");
  assert.ok(verdict.includes("Buy stock ↑") || verdict.includes("Bet stock ↓"), "stock verdict must use plain-English shares labels, not CALL/PUT");
});

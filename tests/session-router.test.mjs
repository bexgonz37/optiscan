/**
 * SPEC tests for options-only scanner (stocks mode removed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("SPEC: options capture is session-guarded (no 0DTE callouts outside RTH)", () => {
  const cap = read("lib/alert-capture.ts");
  assert.ok(cap.includes("isOptionsSession"), "captureZeroDte must import the RTH guard");
  const beforeInsert = cap.slice(0, cap.indexOf("insertAlert({"));
  assert.ok(/if \(!isOptionsSession\(nowMs\)\) return null/.test(beforeInsert), "guard must run before any insert");
});

test("SPEC: scanner loop is options-only — no stock trigger path", () => {
  const loop = read("lib/scanner-loop.ts");
  assert.ok(loop.includes("marketSession"), "loop must read the market session");
  assert.ok(!loop.includes("handleStockTrigger"), "stock trigger removed");
  assert.ok(!loop.includes("captureStockAlert"), "stock capture removed from loop");
  assert.ok(/session === "closed"/.test(loop), "loop must pause when closed");
  assert.ok(/session !== "regular"\) continue/.test(loop), "callouts only in RTH");
  assert.ok(/if \(session === "regular"\) refreshActiveAlerts/.test(loop), "active-alert chain refresh is RTH-only");
});

test("SPEC: options alerts persist asset_class", () => {
  const cap = read("lib/alert-capture.ts");
  assert.ok(cap.includes('assetClass: "options"'), "options alerts must persist asset_class='options'");
});

test("SPEC: options alerts never notify outside RTH", () => {
  const notif = read("lib/notifications.ts");
  assert.ok(notif.includes("isOptionsSession"), "notifyNewAlert must session-guard options");
  assert.ok(notif.includes("stock alerts removed"), "stock discord path removed");
  const verdict = read("lib/trade-verdict.ts");
  assert.ok(verdict.includes("BUY CALL"), "options verdict uses BUY CALL/PUT headlines");
});

test("SPEC: AlertPopup is options-only", () => {
  const popup = read("components/AlertPopup.tsx");
  assert.ok(!popup.includes("StockAlertCard"), "stock popup card removed");
  assert.ok(popup.includes("OptionAlertCard"), "options popup card remains");
});

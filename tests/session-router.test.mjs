/**
 * SPEC tests for session routing — options RTH + optional stock callouts.
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

test("SPEC: scanner loop routes options in RTH; stock when STOCK_CALLOUTS=1", () => {
  const loop = read("lib/scanner-loop.ts");
  assert.ok(loop.includes("marketSession"), "loop must read the market session");
  assert.ok(loop.includes("handleStockTrigger"), "stock trigger behind STOCK_CALLOUTS");
  assert.ok(loop.includes('session === "regular"'), "options path in regular session");
  assert.ok(/STOCK_CALLOUTS === "1"/.test(loop), "stock path gated by env");
  assert.ok(/session === "closed"/.test(loop), "loop must pause when closed");
});

test("SPEC: options alerts persist asset_class", () => {
  const cap = read("lib/alert-capture.ts");
  assert.ok(cap.includes('assetClass: "options"'), "options alerts must persist asset_class='options'");
});

test("SPEC: discord notifications use embed builders and session guards", () => {
  const notif = read("lib/notifications.ts");
  assert.ok(notif.includes("buildOptionsBuyEmbed"), "options BUY embeds");
  assert.ok(notif.includes("isOptionsSession"), "options notify guarded");
  assert.ok(notif.includes("wait=true"), "message id persistence");
  assert.ok(notif.includes("editDiscordMessage"), "result PATCH support");
});

test("SPEC: AlertPopup is options-only", () => {
  const popup = read("components/AlertPopup.tsx");
  assert.ok(!popup.includes("StockAlertCard"), "stock popup card removed");
  assert.ok(popup.includes("OptionAlertCard"), "options popup card remains");
});

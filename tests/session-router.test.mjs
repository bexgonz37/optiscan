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

test("SPEC: scanner loop routes options and stock in parallel during RTH", () => {
  const loop = read("lib/scanner-loop.ts");
  assert.ok(loop.includes("marketSession"), "loop must read the market session");
  assert.ok(loop.includes("handleStockTrigger"), "stock trigger behind STOCK_CALLOUTS");
  assert.ok(loop.includes('session === "regular"'), "options path in regular session");
  assert.ok(/STOCK_CALLOUTS === "1"/.test(loop), "stock path gated by env");
  assert.ok(loop.includes("Promise.allSettled(tasks)"), "RTH paths must run fire-and-forget in parallel");
  assert.ok(loop.includes("optionsCooldownUntil"), "options path needs an independent cooldown");
  assert.ok(loop.includes("stockCooldownUntil"), "stock path needs an independent cooldown");
  assert.ok(/if \(fired && session === "regular"\) tasks\.push\(handleTrigger/.test(loop), "options path runs in RTH on real triggers");
  assert.ok(/if \(stockEnabled && stockClassGate\.allowed && stockPolicyGate\.ok\) tasks\.push\(handleStockTrigger/.test(loop), "stock path runs when enabled, the fresh-mover class gate allows it, and the broad/fast stock policy passes");
  assert.ok(/session === "closed"/.test(loop), "loop must pause when closed");
});

test("SPEC: core bullish impulse can start option selection faster without bypassing final gates", () => {
  const loop = read("lib/scanner-loop.ts");
  assert.ok(/coreBullishImpulse/.test(loop), "core impulse branch present");
  assert.ok(/dir\.direction === "bullish"/.test(loop), "limited to bullish call-style moves");
  assert.ok(/levels\.aboveVwap !== false/.test(loop), "requires VWAP alignment when known");
  assert.ok(/Math\.max\(triggerMinRate \* 1\.15, 0\.2\)/.test(loop), "requires Discord-grade speed");
  assert.ok(/const fired = \(persistOk && accelOk && tapeMoving && shouldTriggerOk\) \|\| coreBullishImpulse/.test(loop), "only accelerates trigger discovery");
  assert.ok(/captureZeroDte/.test(loop), "still routes through capture/contract/freshness gates");
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
  assert.ok(/kind === "stocks"\) return process\.env\.DISCORD_WEBHOOK_STOCKS;/.test(notif), "stocks use the dedicated webhook only");
});

test("SPEC: AlertPopup is options-only", () => {
  const popup = read("components/AlertPopup.tsx");
  assert.ok(!popup.includes("StockAlertCard"), "stock popup card removed");
  assert.ok(popup.includes("OptionAlertCard"), "options popup card remains");
});

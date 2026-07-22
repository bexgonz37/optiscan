import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { deliverOptionsCallout, optionsWebhookTransportTest, readDeliveryMetricsOnDb, optionsAlertId } from "../lib/research/options/delivery.ts";

function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT, delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0, discord_status INTEGER, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT, attempted_at_ms INTEGER, sent_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);`);
  return d;
}
const NOW = 5_000_000;
const ON = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", EARLY_OPTIONS_CALLOUTS_ENABLED: "1", DISCORD_WEBHOOK_OPTIONS: "https://discord.com/api/webhooks/SECRET" };
const input = (over = {}) => ({
  candidateSymbol: "HOOD", strategy: "breakout_forming", researchOnly: false,
  contract: { optionSymbol: "O:HOOD260320C00101000", side: "call", strike: 101, expiration: "2026-03-20", bid: 1.2, ask: 1.3, spreadPct: 8, quoteAgeMs: 1000 },
  message: "HOOD CALL\n$101 — 03/20\nEntry: $1.20–$1.30\nTargets: $1.80 / $2.40\nWhy: breakout forming",
  observedUnderlyingPrice: 100, currentUnderlyingPrice: 100.1, chaseLimitPct: 0.6, underlyingPrice: 100.1,
  paperOptionSymbol: "O:HOOD260320C00101000", ...over,
});
const okSend = () => { const spy = { calls: [] }; return { spy, send: async (p) => { spy.calls.push(p); return { ok: true, status: 204, messageId: "m1", latencyMs: 42, ambiguous: false, error: null }; } }; };

test("1. callout flag OFF → zero webhook requests", async () => {
  const { spy, send } = okSend();
  const r = await deliverOptionsCallout(input(), { getDb: () => db(), send, now: () => NOW }, { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1" }); // callouts flag absent
  assert.equal(r.sent, false);
  assert.equal(spy.calls.length, 0);
});

test("2/9. READY + valid call + flags on → ONE message; SENT only after success", async () => {
  const d = db(); const { spy, send } = okSend();
  const r = await deliverOptionsCallout(input(), { getDb: () => d, send, now: () => NOW }, ON);
  assert.equal(r.state, "SENT"); assert.equal(r.sent, true);
  assert.equal(spy.calls.length, 1);
  assert.match(spy.calls[0].content, /PAPER\/BETA TEST — NOT FINANCIAL ADVICE/);
  const row = d.prepare("SELECT state, sent_at_ms, discord_status, paper_linked FROM options_alerts").get();
  assert.equal(row.state, "SENT"); assert.ok(row.sent_at_ms > 0); assert.equal(row.discord_status, 204);
});

test("3/8. duplicate event → no second message (dedup by alertId)", async () => {
  const d = db(); const { spy, send } = okSend();
  await deliverOptionsCallout(input(), { getDb: () => d, send, now: () => NOW }, ON);
  const r2 = await deliverOptionsCallout(input(), { getDb: () => d, send, now: () => NOW }, ON);
  assert.equal(r2.reason, "duplicate_suppressed");
  assert.equal(spy.calls.length, 1, "only one webhook request");
});

test("4. stale quote sends nothing (TOO_LATE)", async () => {
  const { spy, send } = okSend();
  const r = await deliverOptionsCallout(input({ contract: { ...input().contract, quoteAgeMs: 999999 } }), { getDb: () => db(), send, now: () => NOW }, ON);
  assert.equal(r.state, "TOO_LATE"); assert.equal(spy.calls.length, 0);
});

test("5. excessive spread sends nothing (REJECTED)", async () => {
  const { spy, send } = okSend();
  const r = await deliverOptionsCallout(input({ contract: { ...input().contract, spreadPct: 40 } }), { getDb: () => db(), send, now: () => NOW }, ON);
  assert.equal(r.state, "REJECTED"); assert.equal(spy.calls.length, 0);
});

test("6. exceeded chase → TOO_LATE, sends nothing", async () => {
  const { spy, send } = okSend();
  const r = await deliverOptionsCallout(input({ currentUnderlyingPrice: 105 }), { getDb: () => db(), send, now: () => NOW }, ON);
  assert.equal(r.state, "TOO_LATE"); assert.equal(spy.calls.length, 0);
});

test("7. webhook failure does not throw / block; state SEND_FAILED", async () => {
  const d = db();
  const r = await deliverOptionsCallout(input(), { getDb: () => d, send: async () => ({ ok: false, status: 500, messageId: null, latencyMs: 10, ambiguous: false, error: "discord 500" }), now: () => NOW, maxRetries: 0 }, ON);
  assert.equal(r.state, "SEND_FAILED"); assert.equal(r.sent, false);
  assert.equal(d.prepare("SELECT state FROM options_alerts").get().state, "SEND_FAILED");
});

test("8b. an ambiguous timeout is NOT retried and cannot be resent by a later call", async () => {
  const d = db();
  let calls = 0;
  const send = async () => { calls++; return { ok: false, status: null, messageId: null, latencyMs: 12000, ambiguous: true, error: "timeout" }; };
  await deliverOptionsCallout(input(), { getDb: () => d, send, now: () => NOW }, ON);
  const r2 = await deliverOptionsCallout(input(), { getDb: () => d, send, now: () => NOW }, ON);
  assert.equal(calls, 1, "ambiguous timeout never re-sent");
  assert.equal(r2.reason, "retry_ceiling_reached");
});

test("10. linked paper uses the EXACT same OCC contract", async () => {
  const d = db(); const { send } = okSend();
  await deliverOptionsCallout(input(), { getDb: () => d, send, now: () => NOW }, ON);
  assert.equal(d.prepare("SELECT paper_linked FROM options_alerts").get().paper_linked, 1);
  const d2 = db();
  await deliverOptionsCallout(input({ paperOptionSymbol: "O:HOOD_DIFFERENT" }), { getDb: () => d2, send, now: () => NOW }, ON);
  assert.equal(d2.prepare("SELECT paper_linked FROM options_alerts").get().paper_linked, 0);
});

test("11. research-only puts are NOT sent as actionable callouts (suppressed)", async () => {
  const d = db(); const { spy, send } = okSend();
  const r = await deliverOptionsCallout(input({ researchOnly: true, contract: { ...input().contract, side: "put", optionSymbol: "O:HOOD260320P00099000" } }), { getDb: () => d, send, now: () => NOW }, ON);
  assert.equal(r.state, "REJECTED"); assert.match(r.reason, /research_only_put/);
  assert.equal(spy.calls.length, 0);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_alerts WHERE research_only=1").get().n, 1);
});

test("12. transport test sends a synthetic message; creates NO trade/performance record", async () => {
  const spy = { calls: [] };
  const res = await optionsWebhookTransportTest({ env: { DISCORD_WEBHOOK_OPTIONS: "https://discord.com/api/webhooks/X" }, send: async (p) => { spy.calls.push(p); return { ok: true, status: 204, messageId: null, latencyMs: 30, ambiguous: false, error: null }; } });
  assert.equal(res.ok, true); assert.equal(res.configured, true);
  assert.match(spy.calls[0].content, /transport test/i);
  assert.doesNotMatch(spy.calls[0].content, /\b(CALL|PUT)\b|Entry:|strike/i);
  // not configured → reports, does not send
  assert.equal((await optionsWebhookTransportTest({ env: {} })).configured, false);
});

test("13. delivery metrics never expose the webhook secret", async () => {
  const d = db(); const { send } = okSend();
  await deliverOptionsCallout(input(), { getDb: () => d, send, now: () => NOW }, ON);
  const m = readDeliveryMetricsOnDb(d);
  const json = JSON.stringify(m);
  assert.doesNotMatch(json, /discord\.com\/api\/webhooks|SECRET/);
  assert.equal(m.sent, 1); assert.ok(m.latencyMs.p50 != null);
});

test("alertId is deterministic per symbol/strategy/contract/time-bucket", () => {
  assert.equal(optionsAlertId("HOOD", "breakout_forming", "O:X", NOW), optionsAlertId("hood", "breakout_forming", "O:X", NOW + 1000));
  assert.notEqual(optionsAlertId("HOOD", "breakout_forming", "O:X", NOW), optionsAlertId("HOOD", "breakout_forming", "O:X", NOW + 400_000));
});

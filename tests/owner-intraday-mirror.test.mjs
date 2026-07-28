import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  mirrorOwnerIntradayOnSent,
  shouldMirrorIntradayActionable,
  intradayMirrorDedupKey,
  buildIntradayActionablePayload,
} from "../lib/notifications/owner-intraday-mirror.ts";
import { formatIntradayActionable } from "../lib/notifications/owner-research-notify.ts";

const REGULAR_MS = Date.parse("2026-07-27T14:30:00-04:00");
const AFTERHOURS_MS = Date.parse("2026-07-27T18:00:00-04:00");

const OWNER_ON = {
  OWNER_RESEARCH_DISCORD_ENABLED: "1",
  OWNER_RESEARCH_INTRADAY_ENABLED: "1",
  DISCORD_WEBHOOK_RECAP: "https://discord.com/api/webhooks/recap-secret",
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function notifyDb() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE owner_research_notify_log (
      trading_day TEXT NOT NULL,
      kind TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      sent_at_ms INTEGER NOT NULL,
      PRIMARY KEY (trading_day, kind, symbol)
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY,
      candidate_symbol TEXT NOT NULL,
      strategy TEXT,
      option_symbol TEXT,
      side TEXT,
      research_only INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      message_hash TEXT,
      message TEXT,
      delivered_bid REAL,
      delivered_ask REAL,
      delivered_underlying REAL,
      paper_linked INTEGER NOT NULL DEFAULT 0,
      discord_status INTEGER,
      latency_ms INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      attempted_at_ms INTEGER,
      sent_at_ms INTEGER,
      session_state TEXT,
      entry_mid REAL,
      delivered_spread_pct REAL,
      quote_ts_ms INTEGER,
      target_t1 REAL,
      target_t2 REAL,
      target_stop REAL,
      target_method TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
  return d;
}

function deliveryInput(over = {}) {
  return {
    candidateSymbol: "SPY",
    strategy: "opening_range_breakout",
    researchOnly: false,
    contract: {
      optionSymbol: "O:SPY260727C00635000",
      side: "call",
      strike: 635,
      expiration: "2026-07-27",
      bid: 1.2,
      ask: 1.3,
      spreadPct: 7.5,
      quoteAgeMs: 800,
      dte: 0,
    },
    message: "SPY CALL",
    observedUnderlyingPrice: 634.5,
    currentUnderlyingPrice: 635.1,
    chaseLimitPct: 0.6,
    underlyingPrice: 635.1,
    decisionMs: REGULAR_MS,
    session: "regular",
    entry: { mid: 1.25, t1: 1.66, t2: 2.1, stop: 0.89, methodology: "fixed_r" },
    tier: 0,
    maxSpreadPct: 10,
    maxQuoteAgeMs: 15_000,
    tradingSessionDate: "2026-07-27",
    featureSnapshot: { confidence: 88 },
    ...over,
  };
}

test("formatIntradayActionable includes TRADE NOW CANDIDATE and contract details", () => {
  const msg = formatIntradayActionable(buildIntradayActionablePayload({
    delivery: deliveryInput(),
    actionableReason: "ORB held above opening range high",
    invalidation: "Lose VWAP and opening range low",
    opportunityCaseId: "oc_demo",
  }));
  assert.match(msg, /TRADE NOW CANDIDATE/);
  assert.match(msg, /O:SPY260727C00635000/);
  assert.match(msg, /Bid\/Ask/);
  assert.match(msg, /Trigger confirmed/);
  assert.match(msg, /not guaranteed profit/i);
});

test("regular-session SEND mirror creates one owner recap post", async () => {
  const db = notifyDb();
  const recapCalls = [];
  const fp = "fp_spy_send";
  const r1 = await mirrorOwnerIntradayOnSent({
    db,
    delivery: deliveryInput(),
    alertId: "oa_test",
    opportunityFingerprint: fp,
    actionableReason: "ORB held",
    invalidation: "Lose VWAP",
    nowMs: REGULAR_MS,
    env: OWNER_ON,
    postRecap: async (content) => {
      recapCalls.push(content);
      return { ok: true };
    },
  });
  assert.equal(r1.mirrored, true);
  assert.equal(recapCalls.length, 1);
  assert.match(recapCalls[0], /LIVE · \*\*TRADE NOW CANDIDATE\*\*/);

  const r2 = await mirrorOwnerIntradayOnSent({
    db,
    delivery: deliveryInput(),
    alertId: "oa_test_dup",
    opportunityFingerprint: fp,
    actionableReason: "ORB held",
    invalidation: "Lose VWAP",
    nowMs: REGULAR_MS,
    env: OWNER_ON,
    postRecap: async (content) => {
      recapCalls.push(content);
      return { ok: true };
    },
  });
  assert.equal(r2.skipped, true);
  assert.match(r2.reason, /already sent/);
  assert.equal(recapCalls.length, 1, "duplicate SEND suppressed");
});

test("after-hours state does not mirror as TRADE NOW", async () => {
  const gate = shouldMirrorIntradayActionable({
    delivery: deliveryInput(),
    nowMs: AFTERHOURS_MS,
    env: OWNER_ON,
    opportunityFingerprint: "fp_after",
  });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /session_gate:AFTER_HOURS_RESEARCH/);

  const recapCalls = [];
  const r = await mirrorOwnerIntradayOnSent({
    db: notifyDb(),
    delivery: deliveryInput(),
    alertId: "oa_after",
    opportunityFingerprint: "fp_after",
    actionableReason: "Should not send",
    invalidation: "n/a",
    nowMs: AFTERHOURS_MS,
    env: OWNER_ON,
    postRecap: async (c) => { recapCalls.push(c); return { ok: true }; },
  });
  assert.equal(r.mirrored, false);
  assert.equal(recapCalls.length, 0);
});

test("intraday flag off suppresses mirror", async () => {
  const recapCalls = [];
  const r = await mirrorOwnerIntradayOnSent({
    db: notifyDb(),
    delivery: deliveryInput(),
    alertId: "oa_off",
    opportunityFingerprint: "fp_off",
    actionableReason: "n/a",
    invalidation: "n/a",
    nowMs: REGULAR_MS,
    env: { ...OWNER_ON, OWNER_RESEARCH_INTRADAY_ENABLED: "0" },
    postRecap: async (c) => { recapCalls.push(c); return { ok: true }; },
  });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /OWNER_RESEARCH_INTRADAY_ENABLED/);
  assert.equal(recapCalls.length, 0);
});

test("stale quote and missing bid/ask are rejected", () => {
  const stale = shouldMirrorIntradayActionable({
    delivery: deliveryInput({ contract: { ...deliveryInput().contract, quoteAgeMs: 60_000 } }),
    nowMs: REGULAR_MS,
    env: OWNER_ON,
    opportunityFingerprint: "fp_stale",
  });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /stale_quote/);

  const noBid = shouldMirrorIntradayActionable({
    delivery: deliveryInput({ contract: { ...deliveryInput().contract, bid: null } }),
    nowMs: REGULAR_MS,
    env: OWNER_ON,
    opportunityFingerprint: "fp_nobid",
  });
  assert.equal(noBid.ok, false);
  assert.match(noBid.reason, /missing_fresh_bid_ask/);
});

test("recap webhook failure does not throw", async () => {
  const db = notifyDb();
  const mirror = await mirrorOwnerIntradayOnSent({
    db,
    delivery: deliveryInput(),
    alertId: "oa_fail",
    opportunityFingerprint: "fp_fail",
    actionableReason: "test",
    invalidation: "test",
    nowMs: REGULAR_MS,
    env: OWNER_ON,
    postRecap: async () => ({ ok: false, reason: "recap down" }),
  });
  assert.equal(mirror.mirrored, false);
  assert.match(mirror.reason, /recap down/);
});

test("missing recap webhook skips mirror without throwing", async () => {
  const r = await mirrorOwnerIntradayOnSent({
    db: notifyDb(),
    delivery: deliveryInput(),
    alertId: "oa_norecap",
    opportunityFingerprint: "fp_norecap",
    actionableReason: "test",
    invalidation: "test",
    nowMs: REGULAR_MS,
    env: { ...OWNER_ON, DISCORD_WEBHOOK_RECAP: "" },
  });
  assert.equal(r.mirrored, false);
  assert.ok(r.reason, "expected a failure reason when recap webhook is missing");
});

test("owner mirror module never posts to subscriber options webhook", () => {
  const mirror = read("lib/notifications/owner-intraday-mirror.ts");
  const notify = read("lib/notifications/owner-research-notify.ts");
  assert.match(notify, /webhook: "recap"/);
  assert.ok(!/webhook: "options"/.test(mirror));
  assert.ok(!/postToTwitter|CONTENT_EVENTS|content-drafts/i.test(mirror));
});

test("dedup key uses canonical fingerprint and contract", () => {
  const key = intradayMirrorDedupKey("abc123", "O:SPY260727C00635000", "send");
  assert.equal(key, "abc123|O:SPY260727C00635000|send");
});

test("delivery.ts wires owner intraday mirror after SENT", () => {
  const src = read("lib/research/options/delivery.ts");
  assert.match(src, /mirrorOwnerIntradayOnSent/);
  assert.match(src, /owner-intraday-mirror/);
});

test("OWNER_RESEARCH_INTRADAY_ENABLED defaults off in example env", () => {
  const env = read(".env.railway.example");
  assert.match(env, /OWNER_RESEARCH_INTRADAY_ENABLED=0/);
});

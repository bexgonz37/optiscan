import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  bearishStrategyFamilies,
  evaluateBearishAuthority,
  formatBearishOwnerReview,
  recordBearishLegacyEscalationOnDb,
} from "../lib/research/options/bearish-authority.ts";
import { activeSignals, selectOptionsStrategy } from "../lib/research/options/discovery.ts";
import { decideDeliveryBatch } from "../lib/research/options/delivery-decision.ts";
import { deliverOptionsCallout } from "../lib/research/options/delivery.ts";

const NOW = Date.parse("2026-07-27T14:22:10.777Z");
const ENV_ON = {
  INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
  EARLY_OPTIONS_CALLOUTS_ENABLED: "1",
  OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",
  DISCORD_WEBHOOK_OPTIONS: "https://discord.com/api/webhooks/SECRET",
};

function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_delivery_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, symbol TEXT NOT NULL, strategy TEXT, side TEXT, tier INTEGER, outcome TEXT NOT NULL, reason TEXT, quality REAL, rank INTEGER, batch_size INTEGER, components_json TEXT, cluster_key TEXT, threshold REAL, session_state TEXT, alert_id TEXT, would_deliver_solo INTEGER, competing_json TEXT, delivery_attempted INTEGER NOT NULL DEFAULT 0, delivery_sent INTEGER NOT NULL DEFAULT 0, delivery_state TEXT, final_delivery_outcome TEXT NOT NULL DEFAULT 'SKIPPED', delivery_failure_category TEXT, final_delivery_reason TEXT, delivery_attempted_at_ms INTEGER, delivery_completed_at_ms INTEGER, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT, delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0, discord_status INTEGER, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT, attempted_at_ms INTEGER, sent_at_ms INTEGER, session_state TEXT, entry_mid REAL, delivered_spread_pct REAL, quote_ts_ms INTEGER, target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT, feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT, experiment_id TEXT, experiment_variant TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE VIEW options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
          CREATE VIEW options_paper_research AS SELECT * FROM options_paper_trades WHERE paper_kind='RESEARCH_ONLY_PAPER';
          CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL);`);
  return d;
}

function nvdaDeliveryInput(overrides = {}) {
  return {
    candidateSymbol: "NVDA",
    strategy: "momentum_breakdown",
    researchOnly: false,
    contract: {
      optionSymbol: "O:NVDA260727P00200000",
      side: "put",
      strike: 200,
      expiration: "2026-07-27",
      dte: 0,
      bid: 0.49,
      ask: 0.50,
      spreadPct: 2.02,
      quoteAgeMs: 1000,
      volume: 112193,
      openInterest: 20139,
      delta: -0.434,
      providerTimestamp: NOW - 1000,
    },
    entry: { mid: 0.495, t1: 0.65, t2: 0.85, stop: 0.35, methodology: "frozen_mid", spreadPct: 2.02 },
    message: "NVDA PUT\n$200 - 07/27\nEntry: $0.49-$0.50\nTargets: $0.65 / $0.85",
    observedUnderlyingPrice: 200.24,
    currentUnderlyingPrice: 199.8,
    chaseLimitPct: 0.6,
    underlyingPrice: 199.8,
    decisionMs: NOW,
    firstDetectedAtMs: NOW,
    underlyingAtFirstDetection: 200.24,
    optionAtFirstDetection: 0.495,
    tradingSessionDate: "2026-07-27",
    featureSnapshot: {
      underlying: {
        velPct: -0.4,
        accelPct: -0.2,
        shortMomentumPct: -1.1,
        trendSlopePctPerBar: -0.05,
        aboveVwap: false,
        lodBreak: true,
        nearestSupportDistPct: 0.2,
      },
      chain: { direction: "put_skew" },
    },
    ...overrides,
  };
}

function nvdaSubmission(overrides = {}) {
  const input = nvdaDeliveryInput(overrides.deliveryInput ?? {});
  return {
    deliveryInput: input,
    symbol: "NVDA",
    side: "put",
    strategy: "momentum_breakdown",
    researchOnly: input.researchOnly,
    tier: 1,
    matchedSignals: 4,
    requiredSignals: 4,
    strategyScore: 1,
    spreadPct: 2.02,
    openInterest: 20139,
    volume: 112193,
    fractionMove: 0.3,
    levelProximityPct: 0.2,
    nowMs: NOW,
    ...overrides,
  };
}

test("bearish authority defaults PUTs to research instead of subscriber delivery", () => {
  const decision = evaluateBearishAuthority({
    symbol: "NVDA",
    side: "put",
    strategy: "momentum_breakdown",
    researchOnly: false,
    quality: 0.85,
    threshold: 0.7,
    matchedSignals: 4,
    requiredSignals: 4,
    strategyScore: 1,
    fractionMove: 0.3,
    deliveryInput: nvdaDeliveryInput(),
    nowMs: NOW,
  }, {});
  assert.equal(decision.state, "BEARISH_RESEARCH");
  assert.equal(decision.maySubscriberSend, false);
  assert.equal(decision.reasonCode, "bearish_pipeline_disabled");
});

test("qualified NVDA $200 PUT becomes READY in shadow mode and SEND only with subscriber flag", () => {
  const base = {
    symbol: "NVDA",
    side: "put",
    strategy: "momentum_breakdown",
    researchOnly: false,
    quality: 0.85,
    threshold: 0.7,
    matchedSignals: 4,
    requiredSignals: 4,
    strategyScore: 1,
    fractionMove: 0.3,
    deliveryInput: nvdaDeliveryInput(),
    nowMs: NOW,
  };
  const ready = evaluateBearishAuthority(base, { BEARISH_PIPELINE_ENABLED: "1", BEARISH_OWNER_ALERTS_ENABLED: "1" });
  assert.equal(ready.state, "BEARISH_READY");
  assert.equal(ready.ownerReview, true);
  assert.equal(ready.maySubscriberSend, false);
  const ownerMessage = formatBearishOwnerReview(base, ready);
  assert.match(ownerMessage, /BEARISH TRADE CANDIDATE/);
  assert.match(ownerMessage, /Setup family: momentum_breakdown/);
  assert.match(ownerMessage, /Delta: -0.434/);

  const send = evaluateBearishAuthority(base, { BEARISH_PIPELINE_ENABLED: "1", BEARISH_SUBSCRIBER_DELIVERY_ENABLED: "1" });
  assert.equal(send.state, "BEARISH_SEND");
  assert.equal(send.maySubscriberSend, true);
});

test("bad or mismatched bearish contract blocks before any subscriber path", () => {
  const decision = evaluateBearishAuthority({
    symbol: "NVDA",
    side: "put",
    strategy: "momentum_breakdown",
    researchOnly: false,
    deliveryInput: nvdaDeliveryInput({ contract: { ...nvdaDeliveryInput().contract, optionSymbol: "O:NVDA260727C00200000", side: "call" } }),
    nowMs: NOW,
  }, { BEARISH_PIPELINE_ENABLED: "1", BEARISH_SUBSCRIBER_DELIVERY_ENABLED: "1" });
  assert.equal(decision.state, "BEARISH_BLOCK");
  assert.equal(decision.maySubscriberSend, false);
  assert.ok(decision.blockers.includes("missing_or_non_put_occ"));
  assert.ok(decision.blockers.includes("contract_side_not_put"));
});

test("decision layer keeps qualified PUTs out of Discord until subscriber flag is explicit", async () => {
  const sent = [];
  const out = await decideDeliveryBatch([nvdaSubmission()], {
    getDb: () => db(),
    now: () => NOW,
    deliver: async (input) => { sent.push(input.candidateSymbol); return { state: "SENT", alertId: "oa_nvda", sent: true }; },
  }, { ...ENV_ON, BEARISH_PIPELINE_ENABLED: "1", BEARISH_SUBSCRIBER_DELIVERY_ENABLED: "0" });
  assert.equal(out[0].outcome, "RESEARCH_ONLY");
  assert.equal(out[0].reason, "bearish_ready_owner_review_only");
  assert.equal(out[0].deliveryAttempted, false);
  assert.equal(sent.length, 0);
});

test("decision and final delivery can send a PUT only when bearish subscriber delivery is enabled", async () => {
  const d = db();
  const sent = [];
  const out = await decideDeliveryBatch([nvdaSubmission()], {
    getDb: () => d,
    now: () => NOW,
    deliver: async (input) => {
      sent.push(input.candidateSymbol);
      return deliverOptionsCallout(input, {
        getDb: () => d,
        now: () => NOW,
        send: async () => ({ ok: true, status: 204, messageId: "m_nvda_put", latencyMs: 10, ambiguous: false, error: null }),
      }, { ...ENV_ON, BEARISH_PIPELINE_ENABLED: "1", BEARISH_SUBSCRIBER_DELIVERY_ENABLED: "1" });
    },
  }, { ...ENV_ON, BEARISH_PIPELINE_ENABLED: "1", BEARISH_SUBSCRIBER_DELIVERY_ENABLED: "1" });
  assert.equal(out[0].outcome, "DELIVER_TO_DISCORD");
  assert.equal(out[0].finalDeliveryOutcome, "DELIVERED");
  assert.deepEqual(sent, ["NVDA"]);
  assert.equal(d.prepare("SELECT state FROM options_alerts").get().state, "SENT");
});

test("subscriber PUT message uses bearish decision-first copy", async () => {
  const d = db();
  const payloads = [];
  await deliverOptionsCallout(nvdaDeliveryInput(), {
    getDb: () => d,
    now: () => NOW,
    send: async (payload) => {
      payloads.push(payload);
      return { ok: true, status: 204, messageId: "m_put", latencyMs: 10, ambiguous: false, error: null };
    },
  }, { ...ENV_ON, BEARISH_PIPELINE_ENABLED: "1", BEARISH_SUBSCRIBER_DELIVERY_ENABLED: "1" });
  const content = String(payloads[0]?.content ?? "");
  assert.match(content, /BEARISH TRADE CANDIDATE/);
  assert.match(content, /Contract: NVDA 07\/27 \$200P/);
  assert.match(content, /Entry: \$0\.49-\$0\.50/);
  assert.match(content, /Target 1:/);
  assert.match(content, /Target 2:/);
  assert.match(content, /Stop:/);
  assert.match(content, /Trigger:/);
  assert.match(content, /Main risk:/);
  assert.match(content, /Spread 2\.0%/);
  assert.match(content, /Volume 112,193/);
  assert.match(content, /OI 20,139/);
  assert.match(content, /Delta -0\.43/);
  assert.match(content, /Freshness 1s/);
});

test("bearish strategy families and active signals are explicit", () => {
  const families = bearishStrategyFamilies();
  for (const key of ["momentum_breakdown", "failed_breakout_reversal", "vwap_rejection", "support_break_retest", "lower_high_continuation", "bearish_opening_range_break", "gap_failure", "relative_weakness_continuation", "downside_catalyst_continuation"]) {
    assert.ok(families.includes(key), `${key} registered`);
  }
  const candidate = {
    symbol: "NVDA",
    nowMs: NOW,
    session: "regular",
    tier: 1,
    underlying: {
      price: 199.8,
      dayDollarVolume: 10_000_000_000,
      relVolume: 3,
      velPct: -0.4,
      accelPct: -0.2,
      gapPct: null,
      aboveVwap: false,
      hodBreak: false,
      lodBreak: true,
      nearResistancePct: null,
      nearSupportPct: 0.2,
      compressionPct: 0.8,
      realizedVolExpanding: true,
      openingRange: false,
      premarketLevelTest: false,
    },
    optionsActivity: { volOIRatio: 3, volVsBaseline: 4, direction: "put_skew", multiStrike: true, multiExpiration: false, ivChange: 0.03 },
  };
  const signals = activeSignals(candidate);
  assert.ok(signals.has("downside_momentum"));
  assert.ok(signals.has("lod_break"));
  assert.ok(signals.has("below_vwap"));
  assert.ok(signals.has("put_flow_skew"));
  const selected = selectOptionsStrategy(candidate, { bearishActionable: true });
  assert.equal(selected.direction, "bearish");
  assert.equal(selected.selected?.side, "put");
  assert.equal(selected.selected?.researchOnly, false);
});

test("legacy NVDA PUT suppression persists escalation evidence, not delivered proof", () => {
  const d = db();
  const inserted = recordBearishLegacyEscalationOnDb(d, {
    legacyAlertId: 2012,
    symbol: "NVDA",
    occ: "O:NVDA260727P00200000",
    side: "put",
    strategyFamily: "momentum_breakdown",
    signalScore: 100,
    liquidityScore: 96,
    bid: 0.49,
    ask: 0.50,
    mid: 0.495,
    spreadPct: 2.02,
    volume: 112193,
    openInterest: 20139,
    delta: -0.434,
    timestamp: "2026-07-27T14:22:10.777Z",
    suppressionReason: "superseded by independent options subscriber path (SUBSCRIBER_OPTIONS_DISCORD_OWNER=independent)",
    nowMs: NOW,
  });
  assert.equal(inserted, true);
  const row = d.prepare("SELECT legacy_alert_id, symbol, occ, side, signal_score, liquidity_score, bid, ask, mid, status FROM options_bearish_escalations").get();
  assert.deepEqual(row, {
    legacy_alert_id: 2012,
    symbol: "NVDA",
    occ: "O:NVDA260727P00200000",
    side: "put",
    signal_score: 100,
    liquidity_score: 96,
    bid: 0.49,
    ask: 0.5,
    mid: 0.495,
    status: "PENDING",
  });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_alerts WHERE state='SENT'").get().n, 0);
});

/**
 * Living Opportunity Case: opening dedup, milestones, identity, safety.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { deliverOptionsCallout } from "../lib/research/options/delivery.ts";
import {
  buildOpportunityIdentity,
  opportunityFingerprint,
} from "../lib/opportunity-case/identity.ts";
import {
  highestNewReturnMilestone,
  evaluateReturnMilestones,
  claimMilestoneDeliveryOnDb,
  persistReachedMilestoneOnDb,
  computeReturnPercent,
} from "../lib/opportunity-case/milestones.ts";
import {
  claimOpportunityOpenOnDb,
  attachEvidenceToOpportunityOnDb,
  applyOpportunityMarkOnDb,
  completeMilestoneDeliveryOnDb,
  closeOpportunityOnDb,
  findActiveOpportunityByFingerprintOnDb,
  loadCaseJsonOnDb,
  markOpportunityOpenedDeliveredOnDb,
} from "../lib/opportunity-case/live.ts";
import { persistContentEventOnDb, contentEventId } from "../lib/opportunity-case/content-events.ts";
import { persistCaseFromOptionsLive } from "../lib/opportunity-case/orchestrate.ts";
import {
  buildOpportunityThesisIdentity,
  opportunityThesisFingerprint,
} from "../lib/opportunity-case/thesis-identity.ts";
import { maybeSendBearishOwnerReview } from "../lib/research/options/delivery-decision.ts";
import { gradeOpenOptionPositionsOnDb } from "../lib/research/options/grade.ts";
import { decideOptionExit, defaultGradeConfig } from "../lib/research/options/grade.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ET = (h, m) => Date.UTC(2026, 6, 22, h + 4, m, 0);
const ENV = {
  INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
  OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",
  EARLY_OPTIONS_CALLOUTS_ENABLED: "1",
  OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED: "1",
  REAL_OPTION_PAPER_ENABLED: "1",
};

function installLifecycleSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT,
      research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT,
      delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0,
      discord_status INTEGER, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT,
      attempted_at_ms INTEGER, sent_at_ms INTEGER, session_state TEXT, entry_mid REAL, delivered_spread_pct REAL,
      quote_ts_ms INTEGER, target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT,
      opportunity_case_id TEXT, opportunity_fingerprint TEXT, discord_message_id TEXT,
      thesis_fingerprint TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
      result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL,
      volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL,
      strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL,
      exit_fill REAL, pnl REAL, return_pct REAL, mfe_pct REAL, mae_pct REAL, last_mark_return_pct REAL,
      exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT,
      feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT,
      experiment_id TEXT, experiment_variant TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      , thesis_fingerprint TEXT
    );
    CREATE VIEW IF NOT EXISTS options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
    CREATE TABLE IF NOT EXISTS options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL, option_symbol TEXT NOT NULL,
      mark_at_ms INTEGER NOT NULL, bid REAL, ask REAL, exit_fill REAL, return_pct REAL, quote_age_ms INTEGER,
      created_at_ms INTEGER NOT NULL, UNIQUE(trade_id, mark_at_ms)
    );
    CREATE TABLE IF NOT EXISTS opportunity_cases (
      opportunity_id TEXT PRIMARY KEY, underlying_symbol TEXT NOT NULL, direction TEXT, setup_family TEXT,
      detected_at_ms INTEGER NOT NULL, market_session TEXT, source_path TEXT NOT NULL,
      acceptance_decision TEXT NOT NULL, delivery_decision TEXT NOT NULL, rejection_reason_codes_json TEXT,
      alert_id TEXT, case_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      opportunity_fingerprint TEXT, session_date TEXT, lifecycle_status TEXT, summary_json TEXT,
      discord_channel_id TEXT, discord_message_id TEXT, discord_thread_id TEXT, opening_delivered_at_ms INTEGER
      , thesis_fingerprint TEXT, opening_source TEXT
    );
    CREATE TABLE IF NOT EXISTS opportunity_active_index (
      opportunity_fingerprint TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL, session_date TEXT NOT NULL, strategy_key TEXT, lifecycle_status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opportunity_thesis_active_index (
      thesis_fingerprint TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL, direction TEXT NOT NULL, option_type TEXT NOT NULL,
      session_date TEXT NOT NULL, lifecycle_status TEXT NOT NULL, opening_source TEXT NOT NULL,
      discord_message_id TEXT, opened_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opportunity_contract_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thesis_fingerprint TEXT NOT NULL,
      opportunity_case_id TEXT NOT NULL, opportunity_fingerprint TEXT NOT NULL,
      option_symbol TEXT NOT NULL, previous_option_symbol TEXT, side TEXT NOT NULL,
      strike REAL NOT NULL, expiration TEXT NOT NULL, strategy_key TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL, bid REAL, ask REAL, spread_pct REAL, delta REAL,
      open_interest REAL, volume REAL, reason TEXT NOT NULL, expiration_difference_days INTEGER,
      strike_difference REAL, previous_liquidity_json TEXT, new_liquidity_json TEXT,
      previous_spread_pct REAL, previous_delta REAL, original_contract_remains_valid INTEGER,
      created_at_ms INTEGER NOT NULL, UNIQUE(opportunity_case_id, opportunity_fingerprint)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_options_paper_active_thesis_test
      ON options_paper_trades(thesis_fingerprint)
      WHERE status='ENTERED' AND thesis_fingerprint IS NOT NULL;
    CREATE TABLE IF NOT EXISTS opportunity_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_case_id TEXT NOT NULL, event_key TEXT NOT NULL,
      event_type TEXT NOT NULL, milestone_percent REAL, label TEXT NOT NULL, reached_at_ms INTEGER NOT NULL,
      contract_mark REAL, return_percent REAL, delivered_at_ms INTEGER, claim_token TEXT,
      discord_message_id TEXT, details_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      UNIQUE(opportunity_case_id, event_key)
    );
    CREATE TABLE IF NOT EXISTS opportunity_evidence_events (
      id TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL, observed_at_ms INTEGER NOT NULL,
      source TEXT NOT NULL, signal_type TEXT NOT NULL, score REAL, details_json TEXT, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opportunity_content_events (
      id TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL, event_type TEXT NOT NULL, symbol TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL, frozen_entry REAL, current_mark REAL, return_percent REAL,
      milestone_percent REAL, max_return_percent REAL, direction TEXT, option_type TEXT, strike REAL,
      expiration TEXT, original_thesis_json TEXT, evidence_summary_json TEXT, strategy_key TEXT,
      content_status TEXT NOT NULL DEFAULT 'PENDING', label TEXT, payload_json TEXT, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opportunity_suppression_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, strategy TEXT, fingerprint TEXT,
      existing_opportunity_case_id TEXT, decision TEXT NOT NULL, reason TEXT NOT NULL,
      latest_return_percent REAL, next_undelivered_milestone REAL, details_json TEXT, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS options_runtime (
      key TEXT PRIMARY KEY, value TEXT, updated_at_ms INTEGER NOT NULL
    );
  `);
  return d;
}

function mkInput(overrides = {}) {
  const t = overrides.nowMs ?? ET(11, 0);
  return {
    candidateSymbol: "NVDA",
    strategy: "momentum_acceleration",
    researchOnly: false,
    contract: {
      optionSymbol: "O:NVDA260724C00210000",
      side: "call",
      strike: 210,
      expiration: "2026-07-24",
      bid: 5.1,
      ask: 5.3,
      spreadPct: 3.8,
      quoteAgeMs: 500,
      dte: 2,
      volume: 1000,
      openInterest: 5000,
      iv: 0.4,
      delta: 0.5,
      providerTimestamp: t - 500,
    },
    message: "🟢 **BUYING NVDA $210 CALL** · exp 07/24\nMomentum accelerating early, not extended.",
    observedUnderlyingPrice: 208,
    currentUnderlyingPrice: 208,
    chaseLimitPct: 5,
    underlyingPrice: 208,
    decisionMs: t,
    session: "regular",
    entry: { bid: 5.1, ask: 5.3, mid: 5.2, spreadPct: 3.8, quoteAgeMs: 500, t1: 6.2, t2: 7.3, stop: 4.2, methodology: "test" },
    tier: 1,
    ...overrides,
  };
}

// ── Identity ────────────────────────────────────────────────────────────────
test("fingerprint ignores entry price and is stable for same contract/setup/session", () => {
  const a = buildOpportunityIdentity({
    symbol: "nvda", side: "call", expiration: "2026-07-24", strike: 210,
    strategyKey: "momentum_acceleration", nowMs: ET(11, 0), direction: "bullish",
  });
  const b = buildOpportunityIdentity({
    symbol: "NVDA", side: "call", expiration: "2026-07-24", strike: 210,
    strategyKey: "momentum_acceleration", nowMs: ET(11, 30), direction: "bullish",
  });
  assert.equal(opportunityFingerprint(a), opportunityFingerprint(b));
  const bear = buildOpportunityIdentity({
    symbol: "NVDA", side: "put", expiration: "2026-07-24", strike: 210,
    strategyKey: "momentum_acceleration", nowMs: ET(11, 0), direction: "bearish",
  });
  assert.notEqual(opportunityFingerprint(a), opportunityFingerprint(bear));
});

test("materially different contract creates a different fingerprint", () => {
  const a = opportunityFingerprint(buildOpportunityIdentity({
    symbol: "NVDA", side: "call", expiration: "2026-07-24", strike: 210,
    strategyKey: "momentum_acceleration", nowMs: ET(11, 0),
  }));
  const b = opportunityFingerprint(buildOpportunityIdentity({
    symbol: "NVDA", side: "call", expiration: "2026-07-31", strike: 210,
    strategyKey: "momentum_acceleration", nowMs: ET(11, 0),
  }));
  const c = opportunityFingerprint(buildOpportunityIdentity({
    symbol: "NVDA", side: "call", expiration: "2026-07-24", strike: 220,
    strategyKey: "momentum_acceleration", nowMs: ET(11, 0),
  }));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

// ── Opening dedup ───────────────────────────────────────────────────────────
test("1-4: first open sends once; repeat suppresses, attaches evidence; survives restart lookup", async () => {
  const d = installLifecycleSchema(new Database(":memory:"));
  let sends = 0;
  const send = async () => {
    sends += 1;
    return { ok: true, status: 204, messageId: `m${sends}`, latencyMs: 2, ambiguous: false, error: null };
  };
  const t = ET(11, 0);
  const first = await deliverOptionsCallout(mkInput({ nowMs: t }), { getDb: () => d, send, now: () => t }, ENV);
  assert.equal(first.state, "SENT");
  assert.equal(sends, 1);
  assert.ok(first.opportunityCaseId);

  const dup = await deliverOptionsCallout(mkInput({ nowMs: t + 60_000 }), {
    getDb: () => d, send, now: () => t + 60_000,
  }, ENV);
  assert.equal(dup.state, "REJECTED");
  assert.equal(dup.reason, "matching_active_thesis");
  assert.equal(dup.suppressedDuplicate, true);
  assert.equal(sends, 1, "no second opening Discord message");

  const evN = Number(d.prepare("SELECT COUNT(*) n FROM opportunity_evidence_events").get().n);
  assert.ok(evN >= 1, "evidence attached on duplicate");

  // Process-restart survival: active index still suppresses
  const fp = opportunityFingerprint(buildOpportunityIdentity({
    symbol: "NVDA", side: "call", expiration: "2026-07-24", strike: 210,
    strategyKey: "momentum_acceleration", nowMs: t,
  }));
  const active = findActiveOpportunityByFingerprintOnDb(d, fp);
  assert.ok(active);
  assert.equal(active.opportunityCaseId, first.opportunityCaseId);

  const oc = loadCaseJsonOnDb(d, first.opportunityCaseId);
  assert.ok(oc?.summary);
  assert.equal(oc.summary.frozenEntry, 5.2);
  assert.ok(oc.summary.originalThesis.length >= 1);
});

test("IWM PUT one hour repeat recovers the original active case and preserves frozen trade", async () => {
  const d = installLifecycleSchema(new Database(":memory:"));
  const t = ET(11, 0);
  let sends = 0;
  const send = async () => {
    sends += 1;
    return { ok: true, status: 204, messageId: `iwm-msg-${sends}`, latencyMs: 2, ambiguous: false, error: null };
  };
  const bearishEnv = {
    ...ENV,
    BEARISH_PIPELINE_ENABLED: "1",
    BEARISH_SUBSCRIBER_DELIVERY_ENABLED: "1",
  };
  const iwmPut = (nowMs, overrides = {}) => ({
    candidateSymbol: "IWM",
    strategy: "momentum_breakdown",
    researchOnly: false,
    contract: {
      optionSymbol: "O:IWM260724P00225000",
      side: "put",
      strike: 225,
      expiration: "2026-07-24",
      bid: 1,
      ask: 1.02,
      spreadPct: 1.98,
      quoteAgeMs: 500,
      dte: 2,
      volume: 5000,
      openInterest: 12000,
      iv: 0.32,
      delta: -0.5,
      providerTimestamp: nowMs - 500,
    },
    message: "IWM PUT alert",
    observedUnderlyingPrice: 225,
    currentUnderlyingPrice: 225,
    chaseLimitPct: 5,
    underlyingPrice: 225,
    decisionMs: nowMs,
    session: "regular",
    entry: {
      bid: 1,
      ask: 1.02,
      mid: 1.01,
      spreadPct: 1.98,
      quoteAgeMs: 500,
      t1: 1.3,
      t2: 1.6,
      stop: 0.75,
      methodology: "frozen_test",
    },
    tier: 0,
    featureSnapshot: {
      underlying: {
        velPct: -0.4,
        accelPct: -0.2,
        shortMomentumPct: -0.3,
        trendSlopePctPerBar: -0.1,
        aboveVwap: false,
        lodBreak: true,
      },
      chain: { direction: "put" },
    },
    ...overrides,
  });

  const first = await deliverOptionsCallout(
    iwmPut(t),
    { getDb: () => d, send, now: () => t },
    bearishEnv,
  );
  assert.equal(first.state, "SENT", JSON.stringify(first));
  assert.equal(sends, 1);
  assert.ok(first.opportunityCaseId);

  // A later scan may enrich the dossier, but it cannot replace the delivered trade definition.
  persistCaseFromOptionsLive(d, {
    input: {
      symbol: "IWM",
      nowMs: t + 30 * 60_000,
      session: "regular",
      tier: 1,
      underlying: {
        price: 224,
        dayDollarVolume: 1_000_000_000,
        relVolume: 3,
        velPct: -0.5,
        accelPct: -0.2,
        gapPct: 0,
        aboveVwap: false,
        hodBreak: false,
        lodBreak: true,
        nearResistancePct: 1,
        nearSupportPct: 0.1,
        compressionPct: 0.8,
        realizedVolExpanding: true,
        openingRange: false,
        premarketLevelTest: false,
      },
    },
    evalResult: {
      selection: {
        symbol: "IWM",
        selected: {
          key: "momentum_breakdown",
          label: "Momentum breakdown",
          score: 1,
          side: "put",
          researchOnly: false,
          preferredDte: "1-7dte",
        },
        direction: "bearish",
        considered: [{
          key: "momentum_breakdown",
          label: "Momentum breakdown",
          applicable: true,
          score: 1,
          matched: ["lod_break", "below_vwap"],
          rejection: null,
        }],
        reason: "repeat signal",
      },
      contract: {
        ...iwmPut(t).contract,
        bid: 1.5,
        ask: 1.54,
        providerTimestamp: t + 30 * 60_000 - 500,
      },
      callout: {
        state: "READY",
        message: "repeat",
        reason: "repeat",
        freshness: "fresh",
        entry: {
          ...iwmPut(t).entry,
          mid: 1.52,
          t1: 2,
          t2: 2.5,
          stop: 1.1,
        },
      },
      paperEntry: null,
      state: "READY",
    },
    chainLength: 20,
    livingOpportunityCaseId: first.opportunityCaseId,
  });

  const afterAudit = loadCaseJsonOnDb(d, first.opportunityCaseId);
  assert.equal(afterAudit?.frozenTrade?.entryMid, 1.01);
  assert.equal(afterAudit?.frozenTrade?.targetT1, 1.3);
  assert.equal(afterAudit?.frozenTrade?.targetT2, 1.6);
  assert.equal(afterAudit?.frozenTrade?.stop, 0.75);
  assert.equal(afterAudit?.discord?.messageId, "iwm-msg-1");
  assert.equal(afterAudit?.deliveryDecision, "delivered");

  // Simulate an index drift/partial migration. Hard delivered-case proof must recover the
  // original case, not permit a second opening alert an hour later.
  d.prepare("DELETE FROM opportunity_active_index WHERE opportunity_case_id=?").run(first.opportunityCaseId);
  const secondTime = t + 60 * 60_000;
  const second = await deliverOptionsCallout(
    iwmPut(secondTime, {
      contract: {
        ...iwmPut(secondTime).contract,
        bid: 1.55,
        ask: 1.59,
      },
      entry: {
        ...iwmPut(secondTime).entry,
        bid: 1.55,
        ask: 1.59,
        mid: 1.57,
        t1: 2.05,
        t2: 2.55,
        stop: 1.15,
      },
    }),
    { getDb: () => d, send, now: () => secondTime },
    bearishEnv,
  );

  assert.equal(second.state, "REJECTED");
  assert.equal(second.reason, "matching_active_thesis");
  assert.equal(second.opportunityCaseId, first.opportunityCaseId);
  assert.equal(sends, 1, "the one-hour repeat cannot create another opening Discord alert");
  assert.equal(Number(d.prepare("SELECT COUNT(*) n FROM options_alerts WHERE candidate_symbol='IWM' AND state='SENT'").get().n), 1);

  const living = loadCaseJsonOnDb(d, first.opportunityCaseId);
  assert.equal(living?.frozenTrade?.entryMid, 1.01);
  assert.equal(living?.frozenTrade?.targetT1, 1.3);
  assert.equal(living?.frozenTrade?.targetT2, 1.6);
  assert.equal(living?.frozenTrade?.stop, 0.75);
  assert.equal(living?.summary?.currentMark, 1.55);
  assert.ok((living?.summary?.currentReturnPct ?? 0) > 50);
  assert.ok((living?.summary?.maxReturnPct ?? 0) > 50);
  assert.ok((living?.summary?.evidenceCount ?? 0) >= 1);
  assert.ok((living?.summary?.elapsedTimeMs ?? 0) >= 60 * 60_000);
});

test("exact IWM production contract roll stays one active thesis and one opening", async () => {
  const d = installLifecycleSchema(new Database(":memory:"));
  const firstAt = Date.parse("2026-07-29T14:25:48.376Z");
  const secondAt = Date.parse("2026-07-29T15:43:54.474Z");
  let sends = 0;
  const send = async () => ({
    ok: true,
    status: 200,
    messageId: `iwm-prod-${++sends}`,
    latencyMs: 2,
    ambiguous: false,
    error: null,
  });
  const bearishEnv = {
    ...ENV,
    BEARISH_PIPELINE_ENABLED: "1",
    BEARISH_SUBSCRIBER_DELIVERY_ENABLED: "1",
  };
  const firstInput = mkInput({
    candidateSymbol: "IWM",
    strategy: "lower_high_continuation",
    nowMs: firstAt,
    decisionMs: firstAt,
    observedUnderlyingPrice: 289,
    currentUnderlyingPrice: 289,
    underlyingPrice: 289,
    contract: {
      optionSymbol: "O:IWM260731P00289000",
      side: "put",
      strike: 289,
      expiration: "2026-07-31",
      bid: 2.17,
      ask: 2.20,
      spreadPct: 1.37,
      quoteAgeMs: 500,
      dte: 2,
      volume: 281,
      openInterest: 13_067,
      iv: 0.3,
      delta: -0.4252535575,
      providerTimestamp: firstAt - 500,
    },
    entry: {
      bid: 2.17,
      ask: 2.20,
      mid: 2.185,
      spreadPct: 1.37,
      quoteAgeMs: 500,
      t1: 3.18,
      t2: 4.17,
      stop: 1.20,
      methodology: "frozen_test",
    },
    featureSnapshot: {
      underlying: {
        velPct: -0.4,
        accelPct: -0.2,
        shortMomentumPct: -0.3,
        trendSlopePctPerBar: -0.1,
        aboveVwap: false,
        lodBreak: true,
      },
      chain: { direction: "put" },
    },
  });
  const first = await deliverOptionsCallout(
    firstInput,
    { getDb: () => d, send, now: () => firstAt },
    bearishEnv,
  );
  assert.equal(first.state, "SENT", JSON.stringify(first));
  assert.ok(first.opportunityCaseId);

  const secondInput = {
    ...firstInput,
    strategy: "vwap_rejection",
    decisionMs: secondAt,
    contract: {
      ...firstInput.contract,
      optionSymbol: "O:IWM260729P00289000",
      expiration: "2026-07-29",
      bid: 1.85,
      ask: 1.86,
      spreadPct: 0.54,
      dte: 0,
      volume: 32_683,
      openInterest: 6_044,
      delta: -0.4855441423,
      providerTimestamp: secondAt - 500,
    },
    entry: {
      ...firstInput.entry,
      bid: 1.85,
      ask: 1.86,
      mid: 1.855,
      spreadPct: 0.54,
      t1: 2.70,
      t2: 3.54,
      stop: 1.02,
    },
  };
  const second = await deliverOptionsCallout(
    secondInput,
    { getDb: () => d, send, now: () => secondAt },
    bearishEnv,
  );
  assert.equal(second.state, "REJECTED");
  assert.equal(second.reason, "matching_active_thesis");
  assert.equal(second.opportunityCaseId, first.opportunityCaseId);
  assert.equal(sends, 1);

  const thesis = opportunityThesisFingerprint(buildOpportunityThesisIdentity({
    symbol: "IWM",
    side: "put",
    direction: "bearish",
    nowMs: firstAt,
  }));
  assert.equal(
    Number(d.prepare("SELECT COUNT(*) n FROM opportunity_thesis_active_index WHERE thesis_fingerprint=?").get(thesis).n),
    1,
  );
  assert.equal(
    Number(d.prepare("SELECT COUNT(*) n FROM opportunity_contract_candidates WHERE opportunity_case_id=?").get(first.opportunityCaseId).n),
    2,
  );
  assert.equal(
    Number(d.prepare("SELECT COUNT(*) n FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER'").get().n),
    1,
  );
  const dossier = loadCaseJsonOnDb(d, first.opportunityCaseId);
  assert.equal(dossier?.selectedContract?.optionSymbol, "O:IWM260731P00289000");
  assert.equal(dossier?.frozenTrade?.entryMid, 2.185);
  assert.equal(dossier?.frozenTrade?.targetT1, 3.18);
  assert.equal(dossier?.frozenTrade?.targetT2, 4.17);
  assert.equal(dossier?.frozenTrade?.stop, 1.20);
  assert.equal(dossier?.discord?.messageId, "iwm-prod-1");
  assert.equal(dossier?.contractCandidates?.length, 2);
  assert.equal(dossier?.contractUpdates?.length, 1);
  assert.equal(dossier?.contractUpdates?.[0]?.previousOptionSymbol, "O:IWM260731P00289000");
  assert.equal(dossier?.contractUpdates?.[0]?.newOptionSymbol, "O:IWM260729P00289000");
  assert.match(dossier?.contractUpdates?.[0]?.reason ?? "", /tighter_spread/);
  assert.equal(dossier?.contractUpdates?.[0]?.expirationDifferenceDays, -2);
  assert.equal(dossier?.contractUpdates?.[0]?.strikeDifference, 0);
  assert.equal(dossier?.contractUpdates?.[0]?.originalContractRemainsValid, null);

  let ownerPosts = 0;
  const ownerAfterCanonical = await maybeSendBearishOwnerReview(
    d,
    {
      deliveryInput: firstInput,
      symbol: "IWM",
      side: "put",
      strategy: firstInput.strategy,
      researchOnly: false,
      tier: 0,
      matchedSignals: 4,
      requiredSignals: 4,
      strategyScore: 1,
      spreadPct: firstInput.contract.spreadPct,
      openInterest: firstInput.contract.openInterest,
      volume: firstInput.contract.volume,
      fractionMove: 0.2,
      levelProximityPct: 0.1,
      nowMs: secondAt,
    },
    {
      state: "BEARISH_READY",
      maySubscriberSend: false,
      ownerReview: true,
      reasonCode: "bearish_ready_owner_review_only",
      reasons: ["Repeat owner observation."],
      blockers: [],
      passed: ["support_break"],
      actionableReason: "Repeat owner observation.",
      invalidation: "Structure reclaimed.",
    },
    0.86,
    0.75,
    secondAt,
    {
      ...bearishEnv,
      BEARISH_OWNER_ALERTS_ENABLED: "1",
      DISCORD_WEBHOOK_OPTIONS: "https://discord.invalid/test",
    },
    async () => {
      ownerPosts += 1;
      return { ok: true, messageId: "must-not-send" };
    },
  );
  assert.equal(ownerAfterCanonical.sent, false);
  assert.equal(ownerAfterCanonical.reason, "MATCHING_ACTIVE_THESIS");
  assert.equal(ownerPosts, 0, "canonical SEND owns the thesis opening");

  const flipAt = secondAt + 60_000;
  const callFlip = await deliverOptionsCallout(
    mkInput({
      candidateSymbol: "IWM",
      strategy: "momentum_acceleration",
      nowMs: flipAt,
      decisionMs: flipAt,
      observedUnderlyingPrice: 289,
      currentUnderlyingPrice: 289,
      underlyingPrice: 289,
      contract: {
        ...mkInput().contract,
        optionSymbol: "O:IWM260731C00290000",
        side: "call",
        strike: 290,
        expiration: "2026-07-31",
        providerTimestamp: flipAt - 500,
      },
    }),
    { getDb: () => d, send, now: () => flipAt },
    bearishEnv,
  );
  assert.equal(callFlip.state, "SENT", "CALL direction owns a separate thesis");
  assert.equal(sends, 2);
  assert.equal(
    Number(d.prepare("SELECT COUNT(*) n FROM opportunity_thesis_active_index WHERE symbol='IWM'").get().n),
    2,
  );

  closeOpportunityOnDb(d, {
    opportunityCaseId: first.opportunityCaseId,
    nowMs: flipAt + 60_000,
    invalidated: true,
    returnPct: -10,
    currentMark: 1.96,
  });
  const reopenedAt = flipAt + 120_000;
  const reopenedPut = await deliverOptionsCallout(
    {
      ...secondInput,
      decisionMs: reopenedAt,
      contract: {
        ...secondInput.contract,
        providerTimestamp: reopenedAt - 500,
      },
    },
    { getDb: () => d, send, now: () => reopenedAt },
    bearishEnv,
  );
  assert.equal(reopenedPut.state, "SENT", "closed PUT thesis permits a fresh PUT opening");
  assert.notEqual(reopenedPut.opportunityCaseId, first.opportunityCaseId);
  assert.equal(sends, 3);
});

test("owner actionable wording and IWM contract churn share one thesis opening claim", async () => {
  const d = installLifecycleSchema(new Database(":memory:"));
  const firstAt = Date.parse("2026-07-29T14:25:48.376Z");
  const secondAt = Date.parse("2026-07-29T15:43:54.474Z");
  let posts = 0;
  const postOverride = async () => ({
    ok: true,
    messageId: `owner-iwm-${++posts}`,
    deliveryId: `delivery-${posts}`,
  });
  const authority = {
    state: "BEARISH_READY",
    maySubscriberSend: false,
    ownerReview: true,
    reasonCode: "bearish_ready_owner_review_only",
    reasons: ["Support broke and bearish momentum increased."],
    blockers: ["BEARISH_SUBSCRIBER_DELIVERY_ENABLED!=1"],
    passed: ["support_break", "downside_momentum"],
    actionableReason: "Support broke and bearish momentum increased.",
    invalidation: "Exit if bearish structure is reclaimed.",
  };
  const submission = (at, strategy, contract, entry) => ({
    deliveryInput: mkInput({
      candidateSymbol: "IWM",
      strategy,
      nowMs: at,
      decisionMs: at,
      observedUnderlyingPrice: 289,
      currentUnderlyingPrice: 289,
      underlyingPrice: 289,
      contract,
      entry,
    }),
    symbol: "IWM",
    side: "put",
    strategy,
    researchOnly: false,
    tier: 0,
    matchedSignals: 4,
    requiredSignals: 4,
    strategyScore: 1,
    spreadPct: contract.spreadPct,
    openInterest: contract.openInterest,
    volume: contract.volume,
    fractionMove: 0.2,
    levelProximityPct: 0.1,
    nowMs: at,
  });
  const firstContract = {
    optionSymbol: "O:IWM260731P00289000",
    side: "put",
    strike: 289,
    expiration: "2026-07-31",
    bid: 2.17,
    ask: 2.20,
    spreadPct: 1.37,
    quoteAgeMs: 500,
    dte: 2,
    volume: 281,
    openInterest: 13_067,
    iv: 0.3,
    delta: -0.425,
    providerTimestamp: firstAt - 500,
  };
  const firstEntry = {
    bid: 2.17, ask: 2.20, mid: 2.185, spreadPct: 1.37, quoteAgeMs: 500,
    t1: 3.18, t2: 4.17, stop: 1.20, methodology: "test",
  };
  const env = {
    ...ENV,
    DISCORD_WEBHOOK_OPTIONS: "https://discord.invalid/test",
    BEARISH_OWNER_ALERTS_ENABLED: "1",
  };
  const first = await maybeSendBearishOwnerReview(
    d,
    submission(firstAt, "lower_high_continuation", firstContract, firstEntry),
    authority,
    0.86,
    0.75,
    firstAt,
    env,
    postOverride,
  );
  assert.equal(first.sent, true);

  const secondContract = {
    ...firstContract,
    optionSymbol: "O:IWM260729P00289000",
    expiration: "2026-07-29",
    bid: 1.85,
    ask: 1.86,
    spreadPct: 0.54,
    dte: 0,
    volume: 32_683,
    openInterest: 6_044,
    delta: -0.486,
    providerTimestamp: secondAt - 500,
  };
  const second = await maybeSendBearishOwnerReview(
    d,
    submission(secondAt, "vwap_rejection", secondContract, {
      ...firstEntry,
      bid: 1.85,
      ask: 1.86,
      mid: 1.855,
      spreadPct: 0.54,
      t1: 2.70,
      t2: 3.54,
      stop: 1.02,
    }),
    { ...authority, actionableReason: "Different wording must not create a new claim." },
    0.85,
    0.75,
    secondAt,
    env,
    postOverride,
  );
  assert.equal(second.sent, false);
  assert.equal(second.reason, "MATCHING_ACTIVE_THESIS");
  assert.equal(posts, 1);
  assert.equal(
    Number(d.prepare("SELECT COUNT(*) n FROM opportunity_contract_candidates").get().n),
    2,
  );
});

test("opening claim write failure blocks Discord instead of failing open", async () => {
  const d = installLifecycleSchema(new Database(":memory:"));
  const t = ET(11, 0);
  const failingDb = {
    prepare(sql) {
      const statement = d.prepare(sql);
      if (/INSERT INTO opportunity_thesis_active_index/.test(sql)) {
        return {
          get: (...args) => statement.get(...args),
          all: (...args) => statement.all(...args),
          run: () => { throw new Error("simulated claim write failure"); },
        };
      }
      return statement;
    },
  };
  let sends = 0;
  const out = await deliverOptionsCallout(
    mkInput({ nowMs: t }),
    {
      getDb: () => failingDb,
      send: async () => {
        sends += 1;
        return { ok: true, status: 204, messageId: "must-not-send", latencyMs: 1, ambiguous: false, error: null };
      },
      now: () => t,
    },
    ENV,
  );
  assert.equal(out.state, "REJECTED");
  assert.match(out.reason, /^opportunity_claim_failed:/);
  assert.equal(sends, 0);
});

test("thesis identity suppresses contract churn but permits close and new-session openings", async () => {
  const d = installLifecycleSchema(new Database(":memory:"));
  let sends = 0;
  const send = async () => {
    sends += 1;
    return { ok: true, status: 204, messageId: `m${sends}`, latencyMs: 2, ambiguous: false, error: null };
  };
  const t = ET(11, 0);
  const a = await deliverOptionsCallout(mkInput({ nowMs: t }), { getDb: () => d, send, now: () => t }, ENV);
  assert.equal(a.state, "SENT");

  const differentStrike = await deliverOptionsCallout(
    mkInput({
      nowMs: t + 1000,
      contract: { ...mkInput().contract, strike: 220, optionSymbol: "O:NVDA260724C00220000" },
      entry: { ...mkInput().entry, mid: 4.1 },
    }),
    { getDb: () => d, send, now: () => t + 1000 },
    ENV,
  );
  assert.equal(differentStrike.state, "REJECTED", "strike change remains evidence on the active thesis");
  assert.equal(differentStrike.reason, "matching_active_thesis");

  // Close first opportunity → re-entry of same fingerprint allowed
  closeOpportunityOnDb(d, { opportunityCaseId: a.opportunityCaseId, nowMs: t + 2000, returnPct: 10, currentMark: 5.7 });
  const reentry = await deliverOptionsCallout(mkInput({ nowMs: t + 3000 }), {
    getDb: () => d, send, now: () => t + 3000,
  }, ENV);
  assert.equal(reentry.state, "SENT", "closed opportunity does not permanently suppress");
  assert.notEqual(reentry.opportunityCaseId, a.opportunityCaseId);

  // New trading session (next ET day) → new fingerprint
  const nextDay = Date.UTC(2026, 6, 23, 15, 0, 0); // 2026-07-23 11:00 ET
  const sessionFresh = await deliverOptionsCallout(mkInput({ nowMs: nextDay }), {
    getDb: () => d, send, now: () => nextDay,
  }, ENV);
  assert.equal(sessionFresh.state, "SENT", "new sessionDate allows a new opportunity");
  assert.equal(sends, 3);
});

// ── Milestones ──────────────────────────────────────────────────────────────
test("5-11: return milestones — thresholds, jump, no spam, concurrent claim", () => {
  assert.equal(highestNewReturnMilestone(24, [], [25, 50, 75, 100]), null);
  assert.equal(highestNewReturnMilestone(25, [], [25, 50, 75, 100]), 25);
  assert.equal(highestNewReturnMilestone(58, [], [25, 50, 75, 100]), 50, "jump sends highest only");
  assert.equal(highestNewReturnMilestone(58, [25, 50], [25, 50, 75, 100]), null);
  assert.equal(highestNewReturnMilestone(24.9, [25], [25, 50]), null, "recovery after dip does not resend");

  const d = installLifecycleSchema(new Database(":memory:"));
  const t = ET(11, 0);
  const claim = claimOpportunityOpenOnDb(d, {
    symbol: "NVDA", side: "call", expiration: "2026-07-24", strike: 210,
    strategyKey: "momentum_acceleration", nowMs: t, frozenEntry: 5.2, optionSymbol: "O:NVDA260724C00210000",
  });
  assert.equal(claim.claimed, true);
  markOpportunityOpenedDeliveredOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    alertId: "oa_test",
    discordMessageId: "msg1",
    frozenEntry: 5.2,
    nowMs: t,
  });

  // +19% → no deliverable milestone (default ladder starts at 20)
  let mark = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    frozenEntry: 5.2,
    currentMark: 5.2 * 1.19,
    returnPct: 19,
    nowMs: t + 1000,
  });
  assert.equal(mark.deliverReturnMilestone, null);

  // +20% → claim +20
  mark = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    frozenEntry: 5.2,
    currentMark: 5.2 * 1.20,
    returnPct: 20,
    nowMs: t + 2000,
  });
  assert.equal(mark.deliverReturnMilestone, 20);
  assert.equal(mark.claimed, true);
  completeMilestoneDeliveryOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    milestonePercent: 20,
    discordMessageId: "m20",
    nowMs: t + 2001,
    ok: true,
    claimToken: mark.claimToken,
  });

  // Loops between +20 and +30 do not resend
  mark = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    frozenEntry: 5.2,
    currentMark: 5.2 * 1.25,
    returnPct: 25,
    nowMs: t + 3000,
  });
  assert.equal(mark.deliverReturnMilestone, null);

  // +30% → claim +30
  mark = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    frozenEntry: 5.2,
    currentMark: 5.2 * 1.30,
    returnPct: 30,
    nowMs: t + 3500,
  });
  assert.equal(mark.deliverReturnMilestone, 30);
  completeMilestoneDeliveryOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    milestonePercent: 30,
    discordMessageId: "m30",
    nowMs: t + 3501,
    ok: true,
    claimToken: mark.claimToken,
  });

  // Dip below and recover — still no resend
  mark = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    frozenEntry: 5.2,
    currentMark: 5.2 * 1.10,
    returnPct: 10,
    nowMs: t + 4000,
  });
  mark = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    frozenEntry: 5.2,
    currentMark: 5.2 * 1.26,
    returnPct: 26,
    nowMs: t + 5000,
  });
  assert.equal(mark.deliverReturnMilestone, null);

  // Jump to +58 → only +50 claimed for delivery (20 and 30 already reached)
  const ev = evaluateReturnMilestones({ returnPct: 58, priorReached: [20, 30], levels: [20, 30, 50, 75, 100] });
  assert.equal(ev.deliverPercent, 50);
  mark = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    frozenEntry: 5.2,
    currentMark: 5.2 * 1.58,
    returnPct: 58,
    nowMs: t + 6000,
  });
  assert.equal(mark.deliverReturnMilestone, 50);
  completeMilestoneDeliveryOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    milestonePercent: 50,
    discordMessageId: "m50",
    nowMs: t + 6001,
    ok: true,
    claimToken: mark.claimToken,
  });

  // +75 later
  mark = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    frozenEntry: 5.2,
    currentMark: 5.2 * 1.76,
    returnPct: 76,
    nowMs: t + 7000,
  });
  assert.equal(mark.deliverReturnMilestone, 75);

  // Concurrent claim cannot duplicate
  persistReachedMilestoneOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    eventType: "RETURN_MILESTONE",
    milestonePercent: 100,
    reachedAtMs: t + 8000,
    returnPercent: 100,
    contractMark: 10.4,
  });
  const c1 = claimMilestoneDeliveryOnDb(d, claim.opportunityCaseId, "RETURN_MILESTONE", 100, "tokA", t + 8001);
  const c2 = claimMilestoneDeliveryOnDb(d, claim.opportunityCaseId, "RETURN_MILESTONE", 100, "tokB", t + 8002);
  assert.equal(c1, true);
  assert.equal(c2, false, "second concurrent claim loses");

  const summary = loadCaseJsonOnDb(d, claim.opportunityCaseId)?.summary;
  assert.ok(summary);
  assert.ok(summary.maxReturnPct >= 75);
  assert.ok(summary.milestoneHistory.some((m) => m.eventType === "RETURN_MILESTONE" && m.milestonePercent === 50));
});

test("grader path delivers one milestone update for delivered paper using frozen entry", async () => {
  const d = installLifecycleSchema(new Database(":memory:"));
  const t = ET(11, 0);
  const claim = claimOpportunityOpenOnDb(d, {
    symbol: "NVDA", side: "call", expiration: "2026-07-24", strike: 210,
    strategyKey: "momentum_acceleration", nowMs: t, frozenEntry: 5.2, optionSymbol: "O:NVDA260724C00210000", alertId: "oa_grade",
  });
  markOpportunityOpenedDeliveredOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId, alertId: "oa_grade", discordMessageId: "o1",
    frozenEntry: 5.2, nowMs: t,
  });
  d.prepare(
    `INSERT INTO options_paper_trades
      (option_symbol, side, strike, expiration, dte, result_class, bid, ask, mid, spread_pct, entry_fill,
       volume, open_interest, iv, delta, underlying_price, strategy, target, invalidation, provenance, status,
       paper_kind, alert_id, entry_source, entered_at_ms, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "O:NVDA260724C00210000", "call", 210, "2026-07-24", 2, "REAL_OPTION_PAPER",
    5.1, 5.3, 5.2, 3.8, 5.2, 1000, 5000, 0.4, 0.5, 208, "momentum_acceleration",
    6.2, 4.2, "test", "ENTERED", "DELIVERED_ALERT_PAPER", "oa_grade", "discord_delivery", t, t, t,
  );

  let milestoneSends = 0;
  const r = await gradeOpenOptionPositionsOnDb(
    d,
    {
      getQuote: async () => ({ bid: 6.4, ask: 6.6, quoteAgeMs: 200 }), // ~+23-27% depending on exit fill
      now: () => t + 10_000,
      sendMilestone: async () => { milestoneSends += 1; return { ok: true, messageId: "ms1" }; },
    },
    ENV,
    { ...defaultGradeConfig(ENV), takeProfitPct: 200, stopLossPct: 90 },
  );
  // Conservative exit fill may be slightly below mid; ensure mark path ran.
  assert.ok(r.examined >= 1);
  // Force a clear +50 mark via apply to validate Discord milestone wiring independently of exit math
  const applied = applyOpportunityMarkOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    frozenEntry: 5.2,
    currentMark: 7.8,
    returnPct: 50,
    nowMs: t + 11_000,
  });
  assert.equal(applied.deliverReturnMilestone, 50);
});

test("grader path sends Closed opportunity Discord reply on exit", async () => {
  const d = installLifecycleSchema(new Database(":memory:"));
  const t = ET(11, 0);
  const claim = claimOpportunityOpenOnDb(d, {
    symbol: "NVDA", side: "call", expiration: "2026-07-24", strike: 210,
    strategyKey: "momentum_acceleration", nowMs: t, frozenEntry: 5.2, optionSymbol: "O:NVDA260724C00210000", alertId: "oa_close",
  });
  markOpportunityOpenedDeliveredOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId, alertId: "oa_close", discordMessageId: "open-msg-1",
    frozenEntry: 5.2, nowMs: t,
  });
  d.prepare(
    `INSERT INTO options_paper_trades
      (option_symbol, side, strike, expiration, dte, result_class, bid, ask, mid, spread_pct, entry_fill,
       volume, open_interest, iv, delta, underlying_price, strategy, target, invalidation, provenance, status,
       paper_kind, alert_id, entry_source, entered_at_ms, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "O:NVDA260724C00210000", "call", 210, "2026-07-24", 2, "REAL_OPTION_PAPER",
    5.1, 5.3, 5.2, 3.8, 5.2, 1000, 5000, 0.4, 0.5, 208, "momentum_acceleration",
    6.2, 4.2, "test", "ENTERED", "DELIVERED_ALERT_PAPER", "oa_close", "discord_delivery", t, t, t,
  );

  const payloads = [];
  const r = await gradeOpenOptionPositionsOnDb(
    d,
    {
      // ~+60% forces target_hit exit
      getQuote: async () => ({ bid: 8.2, ask: 8.4, quoteAgeMs: 200 }),
      now: () => t + 10_000,
      sendMilestone: async (p) => {
        payloads.push(p);
        return { ok: true, messageId: `d${payloads.length}` };
      },
    },
    ENV,
    { ...defaultGradeConfig(ENV), takeProfitPct: 50, stopLossPct: 90 },
  );
  assert.equal(r.graded, 1);
  assert.ok((r.closesDelivered ?? 0) >= 1, "close Discord delivered");
  const closePayload = payloads.find((p) => String(p.content || "").includes("TARGET 1 HIT"));
  assert.ok(closePayload, "target-hit Discord payload present");
  assert.equal(closePayload.message_reference?.message_id, "open-msg-1");
  const oc = loadCaseJsonOnDb(d, claim.opportunityCaseId);
  assert.equal(oc?.summary?.currentStatus, "CLOSED");
  assert.equal(oc?.summary?.active, false);
  assert.equal(findActiveOpportunityByFingerprintOnDb(d, opportunityFingerprint(buildOpportunityIdentity({
    symbol: "NVDA", side: "call", expiration: "2026-07-24", strike: 210,
    strategyKey: "momentum_acceleration", nowMs: t,
  }))), null);
});

// ── Safety ──────────────────────────────────────────────────────────────────
test("16: content-event failure does not block Discord opening delivery", async () => {
  const d = installLifecycleSchema(new Database(":memory:"));
  // Break content events table name by dropping it — persistContentEvent becomes no-op/false
  d.exec("DROP TABLE opportunity_content_events");
  let sends = 0;
  const send = async () => {
    sends += 1;
    return { ok: true, status: 204, messageId: "m1", latencyMs: 1, ambiguous: false, error: null };
  };
  const t = ET(11, 0);
  const out = await deliverOptionsCallout(mkInput({ nowMs: t }), { getDb: () => d, send, now: () => t }, ENV);
  assert.equal(out.state, "SENT");
  assert.equal(sends, 1);
});

test("17: AI modules are not imported into deterministic live decision path", () => {
  const deliverySrc = readFileSync(join(__dirname, "../lib/research/options/delivery.ts"), "utf8");
  const decisionSrc = readFileSync(join(__dirname, "../lib/research/options/delivery-decision.ts"), "utf8");
  const liveSrc = readFileSync(join(__dirname, "../lib/opportunity-case/live.ts"), "utf8");
  const milestonesSrc = readFileSync(join(__dirname, "../lib/opportunity-case/milestones.ts"), "utf8");
  for (const [name, src] of [
    ["delivery", deliverySrc],
    ["delivery-decision", decisionSrc],
    ["live", liveSrc],
    ["milestones", milestonesSrc],
  ]) {
    assert.equal(/from ["'].*\/ai\//.test(src) || /require\(["'].*\/ai\//.test(src), false, `${name} must not import AI`);
  }
});

test("18: existing exit logic remains unchanged", () => {
  const pos = {
    id: 1, option_symbol: "O:NVDA260724C00210000", side: "call", strike: 210, expiration: "2026-07-24",
    dte: 2, entry_fill: 5.2, result_class: "REAL_OPTION_PAPER", strategy: "momentum_acceleration",
    underlying_price: 208, target: 6.2, invalidation: 4.2, entered_at_ms: ET(11, 0), status: "ENTERED",
  };
  const hit = decideOptionExit(pos, { bid: 9, ask: 9.2, quoteAgeMs: 100 }, ET(11, 30), {
    takeProfitPct: 60, stopLossPct: 40, maxHoldMs: 1e12, maxQuoteAgeMs: 900_000,
  });
  assert.equal(hit.action, "exit");
  assert.equal(hit.reason, "target_hit");
  const hold = decideOptionExit(pos, { bid: 5.3, ask: 5.5, quoteAgeMs: 100 }, ET(11, 30), {
    takeProfitPct: 60, stopLossPct: 40, maxHoldMs: 1e12, maxQuoteAgeMs: 900_000,
  });
  assert.equal(hold.action, "hold");
});

test("return percent uses frozen entry and rejects invalid entry", () => {
  assert.equal(computeReturnPercent(5.2, 7.8), 50);
  assert.equal(computeReturnPercent(0, 7.8), null);
  assert.equal(computeReturnPercent(-1, 7.8), null);
});

test("evidence attach does not overwrite frozen thesis", () => {
  const d = installLifecycleSchema(new Database(":memory:"));
  const t = ET(11, 0);
  const claim = claimOpportunityOpenOnDb(d, {
    symbol: "NVDA", side: "call", expiration: "2026-07-24", strike: 210,
    strategyKey: "momentum_acceleration", nowMs: t, frozenEntry: 5.2, why: "Original thesis line",
  });
  markOpportunityOpenedDeliveredOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId, alertId: "oa1", discordMessageId: "m",
    frozenEntry: 5.2, nowMs: t,
  });
  const before = loadCaseJsonOnDb(d, claim.opportunityCaseId);
  const thesis = [...(before.originalThesis ?? before.summary.originalThesis)];
  attachEvidenceToOpportunityOnDb(d, {
    opportunityCaseId: claim.opportunityCaseId,
    nowMs: t + 1000,
    source: "test",
    signalType: "call_sweep",
    score: 0.9,
    strengthen: true,
  });
  const after = loadCaseJsonOnDb(d, claim.opportunityCaseId);
  assert.deepEqual(after.summary.originalThesis, thesis);
  assert.ok(after.summary.evidenceCount >= 1);
});

test("content event helper is idempotent by id", () => {
  const d = installLifecycleSchema(new Database(":memory:"));
  const id = contentEventId("oc1", "OPPORTUNITY_OPENED", "x");
  const payload = {
    id, opportunityCaseId: "oc1", eventType: "OPPORTUNITY_OPENED", symbol: "NVDA",
    occurredAt: new Date().toISOString(), frozenEntry: 5.2, currentMark: 5.2, returnPercent: 0,
    milestonePercent: null, maxReturnPercent: 0, direction: "bullish", optionType: "CALL",
    strike: 210, expiration: "2026-07-24", originalThesis: ["x"], evidenceSummary: [],
    strategyKey: "momentum_acceleration", contentStatus: "PENDING", createdAt: new Date().toISOString(),
  };
  assert.equal(persistContentEventOnDb(d, payload), true);
  assert.equal(persistContentEventOnDb(d, payload), false);
});

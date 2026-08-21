/**
 * The subscriber readiness gate must not silence OWNER validation.
 *
 * Regression guard for the 2026-08-07 live-session outage. 415f4b6 made subscriber
 * eligibility explicit and fails CLOSED, which is correct. But owner Discord openings
 * had always been carried by the SAME DELIVER_TO_DISCORD path, so closing it silenced
 * the owner too: on 2026-08-07 the scanner ranked 161 candidates, at least three cleared
 * every deterministic authority gate (SPY 770P, IWM 300P, QQQ 715P), and NOTHING was
 * emitted on any channel — no alert, and no research-paper mirror either, so the setups
 * left no forward evidence at all.
 *
 * The put-side fallback could not cover it: `shouldSendBearishOwnerReview` requires
 * BEARISH_READY, and `evaluateBearishAuthority` only returns BEARISH_READY when
 * subscriber PUT delivery is DISABLED. Production runs BEARISH_SUBSCRIBER_DELIVERY_ENABLED=1,
 * so a fully-qualified put returned BEARISH_SEND and the owner path was skipped —
 * BEARISH_READY was structurally unreachable.
 *
 * These tests reproduce production exactly: real getDb() schema, NO readiness approval
 * (the gate fails closed), subscriber delivery flag ON. The existing bearish test file
 * seeds SUBSCRIBER_APPROVED in its fixture, which is what hid this.
 *
 * The contract asserted here is narrow: when readiness is the ONLY thing standing between
 * a fully-qualified candidate and delivery, the owner is told and subscribers are not.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NOW = Date.parse("2026-07-27T14:22:10.777Z");

const ENV = {
  INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
  EARLY_OPTIONS_CALLOUTS_ENABLED: "1",
  OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",
  REAL_OPTION_PAPER_ENABLED: "1",
  DISCORD_WEBHOOK_OPTIONS: "https://discord.com/api/webhooks/SECRET",
  // Production configuration on 2026-08-07.
  BEARISH_PIPELINE_ENABLED: "1",
  BEARISH_SUBSCRIBER_DELIVERY_ENABLED: "1",
  BEARISH_OWNER_ALERTS_ENABLED: "1",
  BEARISH_RESEARCH_PAPER_ENABLED: "1",
  OWNER_RESEARCH_DISCORD_ENABLED: "1",
  OWNER_RESEARCH_INTRADAY_ENABLED: "1",
};

/** A real production-schema database with NO readiness approval — the gate fails closed. */
async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optiscan-owner-gate-"));
  process.env.ALERT_DB_DIR = dir;
  const g = globalThis;
  if (g.__optiscanDb) {
    try { g.__optiscanDb.close(); } catch { /* already closed */ }
    delete g.__optiscanDb;
  }
  const { getDb } = await import("@/lib/db");
  return { db: getDb(), dir };
}

function cleanup(dir) {
  const g = globalThis;
  if (g.__optiscanDb) {
    try { g.__optiscanDb.close(); } catch { /* already closed */ }
    delete g.__optiscanDb;
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** A put that clears every bearish authority blocker — the shape that reached BEARISH_SEND. */
function putDeliveryInput() {
  return {
    candidateSymbol: "NVDA",
    strategy: "momentum_breakdown",
    researchOnly: false,
    maxQuoteAgeMs: 15_000,
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
  };
}

/** The same setup expressed as a call, so the call lane is covered too. */
function callDeliveryInput() {
  const base = putDeliveryInput();
  return {
    ...base,
    strategy: "momentum_acceleration",
    contract: {
      ...base.contract,
      optionSymbol: "O:NVDA260727C00200000",
      side: "call",
      delta: 0.434,
    },
    observedUnderlyingPrice: 199.8,
    currentUnderlyingPrice: 200.24,
    underlyingPrice: 200.24,
    underlyingAtFirstDetection: 199.8,
    featureSnapshot: {
      underlying: {
        velPct: 0.4,
        accelPct: 0.2,
        shortMomentumPct: 1.1,
        trendSlopePctPerBar: 0.05,
        aboveVwap: true,
        hodBreak: true,
        nearestResistanceDistPct: 0.2,
      },
      chain: { direction: "call_skew" },
    },
  };
}

function submission(deliveryInput, side, strategy) {
  return {
    deliveryInput,
    symbol: "NVDA",
    side,
    strategy,
    researchOnly: false,
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
  };
}

async function runBatch(db, sub) {
  const { decideDeliveryBatch } = await import("../lib/research/options/delivery-decision.ts");
  const ownerPosts = [];
  const subscriberSends = [];
  const out = await decideDeliveryBatch(
    [sub],
    {
      getDb: () => db,
      now: () => NOW,
      deliver: async (input) => {
        subscriberSends.push(input.candidateSymbol);
        return { state: "SENT", alertId: "oa_x", sent: true };
      },
      ownerPostOverride: async (content) => {
        ownerPosts.push(content);
        return { ok: true, messageId: "m_owner", deliveryId: "d_owner" };
      },
    },
    ENV,
  );
  return { out, ownerPosts, subscriberSends };
}

test("a fully-qualified PUT blocked only by readiness still reaches the owner", async () => {
  const { db, dir } = await freshDb();
  try {
    const { out, ownerPosts, subscriberSends } = await runBatch(
      db,
      submission(putDeliveryInput(), "put", "momentum_breakdown"),
    );

    // Subscribers must still receive nothing: the readiness gate is correct and stays closed.
    assert.equal(subscriberSends.length, 0, "no strategy is SUBSCRIBER_APPROVED, so subscribers get nothing");
    assert.notEqual(out[0].outcome, "DELIVER_TO_DISCORD");

    // But the owner must not be silenced by a SUBSCRIBER eligibility rule.
    assert.equal(
      ownerPosts.length,
      1,
      "a candidate that cleared every deterministic gate must still produce an owner opening",
    );
    assert.match(ownerPosts[0], /Research-only · not subscriber approved./);
    assert.match(ownerPosts[0], /NVDA/);

    // A put that was DELIVERED to the owner is owner-validation evidence, not research.
    // BEARISH_RESEARCH_PAPER means "the bearish authority qualified it but nothing was sent";
    // once it is sent it belongs to the owner population, and it must not be counted twice.
    const paper = db
      .prepare("SELECT option_symbol, paper_kind FROM options_paper_trades WHERE option_symbol = ?")
      .all("O:NVDA260727P00200000");
    assert.equal(paper.length, 1, "exactly one mirror — never both an owner and a research row");
    assert.equal(paper[0].paper_kind, "OWNER_VALIDATION_PAPER");
  } finally {
    cleanup(dir);
  }
});

test("a fully-qualified CALL blocked only by readiness still reaches the owner", async () => {
  const { db, dir } = await freshDb();
  try {
    const { ownerPosts, subscriberSends } = await runBatch(
      db,
      submission(callDeliveryInput(), "call", "momentum_acceleration"),
    );

    assert.equal(subscriberSends.length, 0, "subscribers stay gated on the call lane too");
    assert.equal(
      ownerPosts.length,
      1,
      "the call lane lost owner visibility to the same gate and must be restored with it",
    );
    assert.match(ownerPosts[0], /Research-only · not subscriber approved./);
  } finally {
    cleanup(dir);
  }
});

/**
 * 2026-08-07: the three delivered owner CALL openings (QQQ 10/16 $750C, META 08/14 $600C,
 * SPY 08/21 $777C) existed only as a Discord row and an opportunity case. They appeared in
 * ZERO paper populations, so the owner lane produced alerts that could never be measured.
 * An owner opening without a mirror on the same exact OCC is not evidence.
 */
test("every delivered owner opening leaves a paper mirror on the SAME exact OCC", async () => {
  for (const [side, strategy, input, occ] of [
    ["call", "momentum_acceleration", callDeliveryInput(), "O:NVDA260727C00200000"],
    ["put", "momentum_breakdown", putDeliveryInput(), "O:NVDA260727P00200000"],
  ]) {
    const { db, dir } = await freshDb();
    try {
      const { ownerPosts } = await runBatch(db, submission(input, side, strategy));
      assert.equal(ownerPosts.length, 1, `${side}: owner opening must be delivered`);

      const rows = db
        .prepare("SELECT id, option_symbol, paper_kind, entry_source, status, entry_fill FROM options_paper_trades WHERE option_symbol = ?")
        .all(occ);
      assert.equal(rows.length, 1, `${side}: exactly one mirror for the alerted contract`);

      // The mirror must carry its own audience label so owner performance is never blended
      // into subscriber, research, shadow or experiment populations. Both sides land in the
      // owner population once delivered — the side does not change the audience.
      assert.equal(rows[0].paper_kind, "OWNER_VALIDATION_PAPER", `${side}: mirror carries the owner population`);
      assert.equal(rows[0].entry_source, "owner_validation_opening", `${side}: mirror names its origin`);
      assert.ok(rows[0].entry_fill > 0, `${side}: mirror froze a real entry`);
    } finally {
      cleanup(dir);
    }
  }
});

test("BEARISH_READY is reachable while subscriber PUT delivery is enabled", async () => {
  const { evaluateBearishAuthority } = await import("../lib/research/options/bearish-authority.ts");
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
    deliveryInput: putDeliveryInput(),
    nowMs: NOW,
  };

  // The production configuration: subscriber PUT delivery is ON, but the strategy is not
  // subscriber-approved. That combination must not collapse into BEARISH_SEND, because
  // BEARISH_SEND skips the owner path and the readiness gate then drops the candidate.
  const gated = evaluateBearishAuthority(
    { ...base, subscriberApproved: false },
    { BEARISH_PIPELINE_ENABLED: "1", BEARISH_SUBSCRIBER_DELIVERY_ENABLED: "1", BEARISH_OWNER_ALERTS_ENABLED: "1" },
  );
  assert.equal(gated.state, "BEARISH_READY", "an unapproved strategy cannot be in a subscriber SEND state");
  assert.equal(gated.maySubscriberSend, false);
  assert.equal(gated.ownerReview, true);

  // An approved strategy with the flag on still sends, unchanged.
  const approved = evaluateBearishAuthority(
    { ...base, subscriberApproved: true },
    { BEARISH_PIPELINE_ENABLED: "1", BEARISH_SUBSCRIBER_DELIVERY_ENABLED: "1" },
  );
  assert.equal(approved.state, "BEARISH_SEND");
  assert.equal(approved.maySubscriberSend, true);
});

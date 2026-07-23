import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { blendEvidence, computeSubscriberQuality, decideDeliveryBatch } from "../lib/research/options/delivery-decision.ts";

// The 5-year historical replay data + accruing forward mirrors improve callout quality via a modest,
// sample-gated evidence nudge (10% weight) — it can NEVER carry delivery alone, and forward outcomes
// dominate historical when they conflict. HISTORICAL is underlying-forward, not option P&L.

const NOW = Date.UTC(2026, 6, 21, 15, 0, 0);
const SUB = (over = {}) => ({ deliveryInput: null, symbol: "NVDA", side: "call", strategy: "sr_reclaim", researchOnly: false, tier: 1, matchedSignals: 3, requiredSignals: 4, strategyScore: 0.75, spreadPct: 4, openInterest: 5000, volume: 1000, fractionMove: 0.3, levelProximityPct: 0.4, nowMs: NOW, ...over });

test("blendEvidence: neutral when no qualifying samples; below the floors → still neutral", () => {
  assert.deepEqual(blendEvidence(null, null, {}).source, "none");
  assert.equal(blendEvidence(null, null, {}).value, 0.5);
  // forward n=4 (<5) and historical n=30 (<40) → neither qualifies → neutral
  assert.equal(blendEvidence({ n: 4, winRate: 0.9 }, { n: 30, winRate: 0.9 }, {}).source, "none");
});

test("blendEvidence: forward-only when only forward qualifies; historical-only when only historical", () => {
  const fwd = blendEvidence({ n: 20, winRate: 0.7 }, null, {});
  assert.equal(fwd.source, "forward");
  assert.ok(Math.abs(fwd.value - 0.7) < 1e-6);
  const hist = blendEvidence(null, { n: 200, winRate: 0.6 }, {});
  assert.equal(hist.source, "historical");
  assert.ok(Math.abs(hist.value - 0.6) < 1e-6, "historical replay win rate used when forward is absent");
});

test("blendEvidence: forward DOMINATES historical when they conflict (higher per-sample trust)", () => {
  // forward says 0.8 (n=20 → weight 1.0), historical says 0.2 (n=200 → weight 0.6)
  const b = blendEvidence({ n: 20, winRate: 0.8 }, { n: 200, winRate: 0.2 }, {});
  assert.equal(b.source, "blended");
  // weighted avg = (1.0*0.8 + 0.6*0.2) / 1.6 = 0.575 → closer to forward than a naive average (0.5)
  assert.ok(b.value > 0.55 && b.value < 0.6, `forward-weighted blend ${b.value}`);
});

test("blendEvidence: historical can be disabled via env; forward min/hist min are env-tunable", () => {
  const off = blendEvidence(null, { n: 500, winRate: 0.9 }, { OPTIONS_HISTORICAL_EVIDENCE_ENABLED: "0" });
  assert.equal(off.source, "none", "historical evidence fully disabled");
  const lowered = blendEvidence(null, { n: 45, winRate: 0.9 }, { OPTIONS_EVIDENCE_MIN_HISTORICAL: "40" });
  assert.equal(lowered.source, "historical");
});

test("evidence is bounded to 10% — it can NUDGE but never CARRY delivery", () => {
  // identical deterministic setup, worst vs best evidence: score differs by at most ~0.10
  const worst = computeSubscriberQuality(SUB(), null, { value: 0, forwardN: 30, historicalN: 0, source: "forward" });
  const best = computeSubscriberQuality(SUB(), null, { value: 1, forwardN: 30, historicalN: 0, source: "forward" });
  assert.ok(best.quality - worst.quality <= 0.1001, `evidence swing ${best.quality - worst.quality} ≤ 0.10`);
  // a below-floor deterministic setup cannot be lifted to the deliver bar by perfect evidence alone
  const weakSetup = SUB({ matchedSignals: 1, requiredSignals: 4, strategyScore: 0.2, spreadPct: 9.9, openInterest: 0, fractionMove: 0.9, levelProximityPct: null });
  const lifted = computeSubscriberQuality(weakSetup, null, { value: 1, forwardN: 999, historicalN: 999, source: "blended" });
  assert.ok(lifted.quality < 0.62, `weak setup + perfect evidence still below the bar: ${lifted.quality}`);
});

test("components persist forward/historical sample counts for honest observability", () => {
  const q = computeSubscriberQuality(SUB(), null, { value: 0.7, forwardN: 12, historicalN: 340, source: "blended" });
  assert.equal(q.components.evidenceForwardN, 12);
  assert.equal(q.components.evidenceHistoricalN, 340);
  assert.equal(q.components.evidence, 0.7);
});

// ── end-to-end: replay evidence flows through decideDeliveryBatch ──
function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_delivery_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, symbol TEXT NOT NULL, strategy TEXT, side TEXT, tier INTEGER, outcome TEXT NOT NULL, reason TEXT, quality REAL, rank INTEGER, batch_size INTEGER, components_json TEXT, cluster_key TEXT, threshold REAL, session_state TEXT, alert_id TEXT, would_deliver_solo INTEGER, competing_json TEXT, delivery_attempted INTEGER NOT NULL DEFAULT 0, delivery_sent INTEGER NOT NULL DEFAULT 0, delivery_state TEXT, final_delivery_outcome TEXT NOT NULL DEFAULT 'SKIPPED', delivery_failure_category TEXT, final_delivery_reason TEXT, delivery_attempted_at_ms INTEGER, delivery_completed_at_ms INTEGER, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, side TEXT, state TEXT NOT NULL, sent_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE TABLE options_replay_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, t_ms INTEGER NOT NULL, symbol TEXT NOT NULL, strategy TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, quality REAL, strategy_score REAL, matched_signals INTEGER, required_signals INTEGER, fraction_move REAL, hour_et INTEGER, fwd30_pct REAL, fwd60_pct REAL, fwd_eod_pct REAL, grading_basis TEXT NOT NULL, created_at_ms INTEGER NOT NULL);`);
  return d;
}
const SUBMIT = (sym) => ({ deliveryInput: { candidateSymbol: sym, strategy: "sr_reclaim", researchOnly: false, contract: { optionSymbol: `O:${sym}260724C00100000`, side: "call", strike: 100, expiration: "2026-07-24", bid: 1, ask: 1.1, spreadPct: 5, quoteAgeMs: 1000 }, message: "x", observedUnderlyingPrice: 100, currentUnderlyingPrice: 100, chaseLimitPct: 5, underlyingPrice: 100, decisionMs: NOW }, symbol: sym, side: "call", strategy: "sr_reclaim", researchOnly: false, tier: 1, matchedSignals: 3, requiredSignals: 4, strategyScore: 0.75, spreadPct: 4, openInterest: 5000, volume: 1000, fractionMove: 0.3, levelProximityPct: 0.4, nowMs: NOW });

test("END-TO-END: replay-lab evidence for a strategy raises that candidate's persisted quality vs no evidence", async () => {
  const noEvidence = db();
  const out0 = await decideDeliveryBatch([SUBMIT("NVDA")], { getDb: () => noEvidence, now: () => NOW, deliver: async () => ({ state: "SENT", alertId: "a", sent: true }) }, { OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1" });
  const q0 = out0[0].quality;

  const withEvidence = db();
  // seed 60 historical replay candidates for sr_reclaim, mostly winning (fwd60 > 0)
  const ins = withEvidence.prepare("INSERT INTO options_replay_candidates (run_id, t_ms, symbol, strategy, side, quality, fwd60_pct, grading_basis, created_at_ms) VALUES (1,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 60; i++) ins.run(NOW - i * 60000, "NVDA", "sr_reclaim", "call", 0.7, i < 48 ? 0.8 : -0.5, "UNDERLYING_FORWARD", NOW); // 80% win rate, n=60
  const out1 = await decideDeliveryBatch([SUBMIT("NVDA")], { getDb: () => withEvidence, now: () => NOW, deliver: async () => ({ state: "SENT", alertId: "a", sent: true }) }, { OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1" });
  const row = withEvidence.prepare("SELECT quality, components_json FROM options_delivery_decisions LIMIT 1").get();
  const comps = JSON.parse(row.components_json);
  assert.equal(comps.evidenceHistoricalN, 60, "historical sample count recorded honestly");
  assert.ok(comps.evidence > 0.5, "winning historical evidence lifts the evidence component above neutral");
  assert.ok(out1[0].quality > q0, `evidence raised quality ${q0} → ${out1[0].quality}`);
});

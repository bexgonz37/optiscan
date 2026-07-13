import test from "node:test";
import assert from "node:assert/strict";
import { buildCallout } from "../lib/callouts/callout.ts";
import { decideEmission } from "../lib/callouts/dedup.ts";
import { loadPriorCalloutsOnDb, persistCalloutStateOnDb, calloutStateSummaryOnDb } from "../lib/callouts/state-store.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }

const DDL = `
CREATE TABLE IF NOT EXISTS callout_state (
  callout_key TEXT PRIMARY KEY, ticker TEXT NOT NULL, direction TEXT NOT NULL, horizon TEXT NOT NULL,
  last_status TEXT NOT NULL, last_material_hash TEXT, last_emit_at_ms INTEGER, last_idempotency_key TEXT,
  last_delivery_id TEXT, last_delivery_status TEXT, updated_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`;

const NOW = Date.parse("2026-07-11T15:00:00Z");
function ar(over = {}) {
  return {
    agentId: "call_0DTE", agentVersion: 1, strategy: "zero_dte_momentum", strategyVersion: 1,
    ticker: "SPY", direction: "bullish", horizon: "0DTE", dteRange: [0, 1],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 78,
    verifiedInputs: {}, requiredConditions: [], selectorProfile: "zero_dte_momentum",
    selectedContract: { optionSymbol: "O:SPY_C500", strike: 500, expiration: "2026-07-11", dte: 0, side: "call", bid: 1.1, ask: 1.2, mid: 1.15, spreadPct: 4, delta: 0.5, iv: 0.3, volume: 500, openInterest: 1000, breakevenPct: 0.5 },
    passedGates: [], failedGates: [], evidenceStatus: "NOT_TRACKED",
    statisticsSnapshot: { evidenceStatus: "NOT_TRACKED", evidenceSummary: "", gradedSampleSize: 0 },
    modelStatus: "INACTIVE_NO_TRAINABLE_DATA", probability: null,
    actionability: "ACTIONABLE", researchOnly: false, reasons: ["x"],
    improvementConditions: [], invalidationConditions: [], freshness: { ok: true, reason: null },
    marketContext: null, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: NOW,
    ...over,
  };
}

if (Database) {
  test("empty DB ⇒ empty prior map", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    assert.equal(loadPriorCalloutsOnDb(db).size, 0);
  });

  test("persist an emitted callout ⇒ prior map reflects it (survives 'restart')", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const c = buildCallout(ar());
    const d = decideEmission(c, undefined, { nowMs: NOW });
    assert.equal(d.emit, true);
    persistCalloutStateOnDb(db, [{ callout: c, decision: d, deliveryId: "dd_1", deliveryStatus: "SENT" }], NOW);

    // Simulate a restart: a brand-new load from the same DB.
    const prior = loadPriorCalloutsOnDb(db);
    assert.equal(prior.get(c.key).status, "ACTIONABLE_NOW");
    assert.equal(prior.get(c.key).lastEmitMs, NOW);

    // Re-deciding with the restored prior suppresses the unchanged callout.
    const d2 = decideEmission(c, prior.get(c.key), { nowMs: NOW + 1000 });
    assert.equal(d2.emit, false, "restart does not resend an unchanged callout");
  });

  test("suppressed re-observation does not clobber the real last-sent record", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const c = buildCallout(ar());
    persistCalloutStateOnDb(db, [{ callout: c, decision: decideEmission(c, undefined, { nowMs: NOW }), deliveryId: "dd_1", deliveryStatus: "SENT" }], NOW);
    // A later suppressed observation (emit=false) must keep the prior emit time + delivery id.
    const suppress = { emit: false, kind: "suppress", idempotencyKey: "k", reason: "same" };
    persistCalloutStateOnDb(db, [{ callout: c, decision: suppress }], NOW + 60_000);
    const row = db.prepare("SELECT last_emit_at_ms, last_delivery_id FROM callout_state WHERE callout_key=?").get(c.key);
    assert.equal(row.last_emit_at_ms, NOW, "emit time preserved");
    assert.equal(row.last_delivery_id, "dd_1", "delivery id preserved");
  });

  test("meaningful transition updates prior status and re-emits", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const near = buildCallout(ar({ candidateStatus: "NEAR_TRIGGER" }));
    persistCalloutStateOnDb(db, [{ callout: near, decision: decideEmission(near, undefined, { nowMs: NOW }) }], NOW);
    const prior = loadPriorCalloutsOnDb(db);
    const actionable = buildCallout(ar({ candidateStatus: "ACTIONABLE_NOW" }));
    const d = decideEmission(actionable, prior.get(actionable.key), { nowMs: NOW + 120_000 });
    assert.equal(d.emit, true);
    assert.equal(d.kind, "update");
  });

  test("summary reports counts by status", () => {
    const db = new Database(":memory:"); db.exec(DDL);
    const c = buildCallout(ar());
    persistCalloutStateOnDb(db, [{ callout: c, decision: decideEmission(c, undefined, { nowMs: NOW }) }], NOW);
    const s = calloutStateSummaryOnDb(db);
    assert.equal(s.total, 1);
    assert.equal(s.byStatus.ACTIONABLE_NOW, 1);
    assert.equal(s.lastEmitAtMs, NOW);
  });
}

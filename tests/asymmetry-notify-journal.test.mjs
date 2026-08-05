/**
 * The notification decision journal.
 *
 * ASYM_NOTIFY_V2's 120s staleness window and 50% give-back threshold are
 * provisional defaults. They can only ever be validated if the inputs AND the
 * thresholds in force are written down at the moment of each decision. These
 * tests assert exactly that, plus the counterfactual replay it enables.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureNotifyJournalSchema, recordNotifyDecisionOnDb, attachNotifyOutcomeOnDb,
  listNotifyDecisionsOnDb, listNotifyDecisionsForOccOnDb, journalRatioOnDb,
  giveBackFraction, NOTIFY_JOURNAL_VERSION,
} from "../lib/research/asymmetry/notify-journal.ts";
import {
  decideNotification, DEFAULT_NOTIFICATION_STRENGTH, NOTIFICATION_GATE_VERSION,
} from "../lib/research/asymmetry/notification-gate.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }
const skip = Database ? false : "better-sqlite3 unavailable";

const OCC = "O:NVDA260807C00200000";

function entry(over = {}) {
  const decision = over.decision ?? decideNotification({
    state: "HIGH_ASYMMETRY", optionSymbol: OCC, bid: 3.55, ask: 3.65, quoteAtMs: 1000,
    underlyingPrice: 198.1, spreadPct: 2.7, premiumChasePct: 12.3,
    openInterest: 5000, contractVolume: 900, missingEvidence: [], trigger: null, invalidation: null,
    nowMs: 6000, entryAskAtCapture: 3.25, peakAskSinceCapture: 3.65,
  });
  return {
    sessionDate: "2026-07-31", fingerprint: `2026-07-31|${OCC}`, decidedAtMs: 6000,
    symbol: "NVDA", optionSymbol: OCC, direction: "CALL",
    fromState: "CONFIRMING", toState: "HIGH_ASYMMETRY",
    decision, config: DEFAULT_NOTIFICATION_STRENGTH,
    bid: 3.55, ask: 3.65, quoteAtMs: 1000, underlyingPrice: 198.1,
    spreadPct: 2.7, premiumChasePct: 12.3, openInterest: 5000, contractVolume: 900,
    entryAskAtCapture: 3.25, peakAskSinceCapture: 3.65,
    missingEvidenceCount: 0, firstDetectedAtMs: 0,
    ...over,
  };
}

test("schema creation is repeat-safe", { skip }, () => {
  const db = new Database(":memory:");
  ensureNotifyJournalSchema(db);
  ensureNotifyJournalSchema(db);
  ensureNotifyJournalSchema(db);
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='asymmetry_notify_decisions'").get();
  assert.ok(t, "table exists after repeated creation");
  db.close();
});

test("legacy notify journals gain strategy and ranking columns repeat-safely", { skip }, () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE asymmetry_notify_decisions (
      session_date TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      decided_at_ms INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      option_symbol TEXT NOT NULL,
      to_state TEXT NOT NULL,
      notify INTEGER NOT NULL,
      timing TEXT NOT NULL,
      reason TEXT NOT NULL,
      gate_version TEXT NOT NULL,
      silent_capture INTEGER NOT NULL,
      journal_version TEXT NOT NULL,
      PRIMARY KEY (session_date, fingerprint, to_state, decided_at_ms)
    );
  `);
  ensureNotifyJournalSchema(db);
  ensureNotifyJournalSchema(db);
  const cols = db.prepare("PRAGMA table_info(asymmetry_notify_decisions)").all().map((c) => c.name);
  assert.ok(cols.includes("action"));
  assert.ok(cols.includes("cfg_max_capture_to_notify_ms"));
  for (const col of ["setup_family", "freshness_source", "quality_score", "delivery_level", "strategy_policy_json", "decision_metrics_json"]) {
    assert.ok(cols.includes(col), `${col} must be added after legacy table creation`);
  }
  db.close();
});

test("a decision persists its inputs AND the thresholds in force", { skip }, () => {
  const db = new Database(":memory:");
  const res = recordNotifyDecisionOnDb(db, entry());
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  const [row] = listNotifyDecisionsOnDb(db, "2026-07-31");
  // The evidence.
  assert.equal(row.ask, 3.65);
  assert.equal(row.bid, 3.55);
  assert.equal(row.quoteAgeMs, 5000, "derived at write time from decidedAt - quoteAt");
  assert.equal(row.captureToNotifyMs, 6000);
  assert.equal(row.entryAskAtCapture, 3.25);
  assert.equal(row.peakAskSinceCapture, 3.65);
  assert.equal(row.action, "HIGH_ASYMMETRY_ALERT");
  // The thresholds. Without these the row cannot be honestly re-evaluated.
  assert.equal(row.cfgMaxQuoteAgeMs, 120_000);
  assert.equal(row.cfgMaxGiveBackFraction, 0.5);
  assert.equal(row.cfgMaxSpreadPct, 15);
  assert.equal(row.cfgMaxChasePct, 20);
  assert.equal(row.cfgMaxCaptureToNotifyMs, 15 * 60_000);
  assert.equal(row.gateVersion, NOTIFICATION_GATE_VERSION);
  db.close();
});

test("the same decision recorded twice does not duplicate", { skip }, () => {
  const db = new Database(":memory:");
  assert.equal(recordNotifyDecisionOnDb(db, entry()).created, true);
  assert.equal(recordNotifyDecisionOnDb(db, entry()).created, false, "repeat-safe by primary key");
  assert.equal(listNotifyDecisionsOnDb(db, "2026-07-31").length, 1);
  db.close();
});

test("a suppression is journalled just as fully as a send", { skip }, () => {
  const db = new Database(":memory:");
  const stale = decideNotification({
    state: "HIGH_ASYMMETRY", optionSymbol: OCC, bid: 3.55, ask: 3.65, quoteAtMs: 0,
    underlyingPrice: 198.1, spreadPct: 2.7, premiumChasePct: 5,
    openInterest: 5000, contractVolume: 900, missingEvidence: [], trigger: null, invalidation: null,
    nowMs: 126_000, entryAskAtCapture: 3.25, peakAskSinceCapture: null,
  });
  assert.equal(stale.notify, false);
  assert.equal(stale.timing, "STALE_EVIDENCE");
  recordNotifyDecisionOnDb(db, entry({ decision: stale, decidedAtMs: 126_000, quoteAtMs: 0 }));
  const [row] = listNotifyDecisionsOnDb(db, "2026-07-31");
  assert.equal(row.notify, false);
  assert.equal(row.timing, "STALE_EVIDENCE");
  assert.equal(row.quoteAgeMs, 126_000, "the age that triggered it is recoverable");
  assert.match(row.reason, /STALE_126S/);
  db.close();
});

test("delivery outcome and send latency attach to the decision row", { skip }, () => {
  const db = new Database(":memory:");
  recordNotifyDecisionOnDb(db, entry());
  const r = attachNotifyOutcomeOnDb(db,
    { sessionDate: "2026-07-31", fingerprint: `2026-07-31|${OCC}`, toState: "HIGH_ASYMMETRY", decidedAtMs: 6000 },
    { notifyOutcome: "SENT", sentAtMs: 6420 });
  assert.equal(r.created, true);
  const [row] = listNotifyDecisionsOnDb(db, "2026-07-31");
  assert.equal(row.notifyOutcome, "SENT");
  assert.equal(row.sentAtMs, 6420);
  assert.equal(row.sendLatencyMs, 420, "the part of the delay that belongs to us");
  db.close();
});

test("a suppressed decision records no send time", { skip }, () => {
  const db = new Database(":memory:");
  recordNotifyDecisionOnDb(db, entry());
  attachNotifyOutcomeOnDb(db,
    { sessionDate: "2026-07-31", fingerprint: `2026-07-31|${OCC}`, toState: "HIGH_ASYMMETRY", decidedAtMs: 6000 },
    { notifyOutcome: "SUPPRESSED_RATE_LIMIT", sentAtMs: null });
  const [row] = listNotifyDecisionsOnDb(db, "2026-07-31");
  assert.equal(row.sentAtMs, null);
  assert.equal(row.sendLatencyMs, null, "never zero — absence is not a latency of zero");
  db.close();
});

test("give-back fraction is null when there is no measurable peak gain", { skip }, () => {
  assert.equal(giveBackFraction(3.25, 3.25, 3.00), null, "peak equal to entry is not a gain");
  assert.equal(giveBackFraction(null, 4, 3), null);
  assert.equal(giveBackFraction(0, 4, 3), null);
  assert.equal(giveBackFraction(2, 4, 3), 0.5);
});

test("the ratio report counts distinct cases, not decisions", { skip }, () => {
  const db = new Database(":memory:");
  // Same case decided three times; only one delivered.
  for (const t of [1000, 2000, 3000]) {
    recordNotifyDecisionOnDb(db, entry({ decidedAtMs: t, toState: "HIGH_ASYMMETRY", fingerprint: "fp-a" }));
    attachNotifyOutcomeOnDb(db, { sessionDate: "2026-07-31", fingerprint: "fp-a", toState: "HIGH_ASYMMETRY", decidedAtMs: t },
      { notifyOutcome: t === 1000 ? "SENT" : "SUPPRESSED_UNCHANGED", sentAtMs: t === 1000 ? t : null });
  }
  recordNotifyDecisionOnDb(db, entry({ decidedAtMs: 4000, fingerprint: "fp-b" }));
  attachNotifyOutcomeOnDb(db, { sessionDate: "2026-07-31", fingerprint: "fp-b", toState: "HIGH_ASYMMETRY", decidedAtMs: 4000 },
    { notifyOutcome: "SUPPRESSED_RATE_LIMIT", sentAtMs: null });

  const r = journalRatioOnDb(db, "2026-07-31");
  assert.equal(r.decisions, 4);
  assert.equal(r.notified, 1);
  assert.equal(r.suppressed, 3);
  assert.equal(r.distinctCases, 2);
  assert.equal(r.alertToCaptureRatioPct, 50, "1 delivered / 2 distinct cases");
  db.close();
});

test("ratio is null, never zero, when nothing was captured", { skip }, () => {
  const db = new Database(":memory:");
  ensureNotifyJournalSchema(db);
  assert.equal(journalRatioOnDb(db, "2026-07-31").alertToCaptureRatioPct, null, "unknown is not 0%");
  db.close();
});

test("journal rows support counterfactual threshold replay with NO provider call", { skip }, () => {
  const db = new Database(":memory:");
  // A decision suppressed at 126s under the 120s default.
  const stale = decideNotification({
    state: "HIGH_ASYMMETRY", optionSymbol: OCC, bid: 3.55, ask: 3.65, quoteAtMs: 0,
    underlyingPrice: 198.1, spreadPct: 2.7, premiumChasePct: 5,
    openInterest: 5000, contractVolume: 900, missingEvidence: [], trigger: null, invalidation: null,
    nowMs: 126_000, entryAskAtCapture: 3.25, peakAskSinceCapture: null,
  });
  recordNotifyDecisionOnDb(db, entry({ decision: stale, decidedAtMs: 126_000, quoteAtMs: 0 }));
  const [row] = listNotifyDecisionsForOccOnDb(db, "2026-07-31", OCC);

  // Re-run the SAME gate over the SAME stored evidence at a different threshold.
  const replay = decideNotification({
    state: row.toState, optionSymbol: row.optionSymbol,
    bid: row.bid, ask: row.ask, quoteAtMs: row.quoteAtMs, underlyingPrice: row.underlyingPrice,
    spreadPct: row.spreadPct, premiumChasePct: row.premiumChasePct,
    openInterest: row.openInterest, contractVolume: row.contractVolume,
    missingEvidence: [], trigger: null, invalidation: null,
    nowMs: row.decidedAtMs, entryAskAtCapture: row.entryAskAtCapture,
    peakAskSinceCapture: row.peakAskSinceCapture,
  }, { ...DEFAULT_NOTIFICATION_STRENGTH, maxQuoteAgeAtNotifyMs: 180_000 });

  assert.equal(row.notify, false, "suppressed under the 120s default in force at the time");
  assert.equal(replay.notify, true, "would have been sent at 180s — measurable from the row alone");
  db.close();
});

test("reads on a database with no journal table return empty, never throw", { skip }, () => {
  const db = new Database(":memory:");
  assert.deepEqual(listNotifyDecisionsOnDb(db, "2026-07-31"), []);
  assert.deepEqual(listNotifyDecisionsForOccOnDb(db, "2026-07-31", OCC), []);
  assert.equal(journalRatioOnDb(db, "2026-07-31").decisions, 0);
  db.close();
});

test("a write failure is returned, never thrown into the caller", { skip }, () => {
  const broken = { prepare() { throw new Error("db is gone"); }, exec() { throw new Error("db is gone"); } };
  const r = recordNotifyDecisionOnDb(broken, entry());
  assert.equal(r.ok, false);
  assert.match(r.error, /db is gone/);
  // attach treats an unreachable/absent table as "nothing to update" rather
  // than as an error. The guarantee that matters is that it RETURNS instead of
  // throwing: a journal fault must never reach the scanner or the delivery path.
  let threw = null;
  let a = null;
  try {
    a = attachNotifyOutcomeOnDb(broken, { sessionDate: "d", fingerprint: "f", toState: "s", decidedAtMs: 1 }, { notifyOutcome: "SENT", sentAtMs: 1 });
  } catch (err) { threw = err; }
  assert.equal(threw, null, "must not throw");
  assert.equal(a.created, false, "nothing was updated");
});

test("filtering by symbol and by OCC both work", { skip }, () => {
  const db = new Database(":memory:");
  recordNotifyDecisionOnDb(db, entry());
  recordNotifyDecisionOnDb(db, entry({ symbol: "AAPL", optionSymbol: "O:AAPL260807C00200000", fingerprint: "fp-aapl" }));
  assert.equal(listNotifyDecisionsOnDb(db, "2026-07-31").length, 2);
  assert.equal(listNotifyDecisionsOnDb(db, "2026-07-31", { symbol: "NVDA" }).length, 1);
  assert.equal(listNotifyDecisionsForOccOnDb(db, "2026-07-31", OCC).length, 1);
  db.close();
});

test("journal version is stamped on every row", { skip }, () => {
  const db = new Database(":memory:");
  recordNotifyDecisionOnDb(db, entry());
  const v = db.prepare("SELECT journal_version v FROM asymmetry_notify_decisions").get().v;
  assert.equal(v, NOTIFY_JOURNAL_VERSION);
  assert.equal(v, "ASYM_NOTIFY_JOURNAL_V3");
  db.close();
});

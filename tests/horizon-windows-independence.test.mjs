/**
 * Gate B — horizon windows, mark independence, and evidence persistence.
 *
 * The defect these prevent: `dueHorizons` returns EVERY elapsed unmarked
 * horizon, so one sweep on an hour-old position sees 1/3/5/10/15/30/60 all due,
 * fetches ONE quote and writes it to all seven. Seven rows appear, the series
 * looks complete, and it is a single observation repeated — which is how 84.1%
 * of series became degenerate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  horizonWindow, allHorizonWindows, classifyHorizonMatch, evaluateIndependence,
  claimableHorizons, missedHorizons, summarizeIndependence, isIndependentMatch,
  HORIZONS_MINUTES, INDEPENDENT_RATE_GATE, HORIZON_WINDOW_VERSION,
} from "../lib/research/asymmetry/horizon-windows.ts";
import {
  recordMarkEvidenceOnDb, buildIndependenceReportOnDb, INDEPENDENT_GATE_PCT,
} from "../lib/research/asymmetry/mark-evidence-store.ts";
import { runDueAsymmetryMarks } from "../lib/research/asymmetry/mark-runner.ts";
import { ensureAsymmetrySchema, openAsymmetryCaseOnDb } from "../lib/research/asymmetry/case-store.ts";

let Database = null;
try { Database = (await import("better-sqlite3")).default; new Database(":memory:").close(); }
catch { Database = null; }
const skip = Database ? false : "better-sqlite3 unavailable";

const T0 = 1_785_770_000_000;
const M = 60_000;

// ── windows ────────────────────────────────────────────────────────────────

test("a window is centred on its horizon target", () => {
  const w = horizonWindow(T0, 5);
  assert.equal(w.targetAtMs, T0 + 5 * M);
  assert.ok(w.acceptableFromMs < w.targetAtMs);
  assert.ok(w.acceptableUntilMs > w.targetAtMs);
  assert.equal(w.version, HORIZON_WINDOW_VERSION);
});

test("WINDOWS DO NOT OVERLAP — no timestamp can independently satisfy two horizons", () => {
  const ws = allHorizonWindows(T0);
  for (let i = 0; i < ws.length - 1; i++) {
    assert.ok(ws[i].acceptableUntilMs <= ws[i + 1].acceptableFromMs,
      `${ws[i].horizonMinutes}m window ends at ${ws[i].acceptableUntilMs} but ${ws[i + 1].horizonMinutes}m starts at ${ws[i + 1].acceptableFromMs}`);
  }
});

test("one quote cannot land inside two windows at once", () => {
  const ws = allHorizonWindows(T0);
  for (const probe of [T0 + 1 * M, T0 + 3 * M, T0 + 10 * M, T0 + 30 * M, T0 + 60 * M]) {
    const inside = ws.filter((w) => probe >= w.acceptableFromMs && probe <= w.acceptableUntilMs);
    assert.ok(inside.length <= 1, `${probe} fell inside ${inside.length} windows`);
  }
});

test("freshness scales with horizon but is capped", () => {
  assert.ok(horizonWindow(T0, 1).maxQuoteAgeMs <= horizonWindow(T0, 30).maxQuoteAgeMs);
  for (const h of HORIZONS_MINUTES) {
    assert.ok(horizonWindow(T0, h).maxQuoteAgeMs <= 120_000, "no horizon may accept an arbitrarily stale quote");
    assert.ok(horizonWindow(T0, h).maxQuoteAgeMs >= 30_000);
  }
});

test("match status distinguishes on-time, acceptable, out-of-window and missed", () => {
  const w = horizonWindow(T0, 10);
  const at = (ms) => classifyHorizonMatch(w, ms, ms + 1_000).status;
  assert.equal(at(w.targetAtMs), "ON_TIME");
  assert.equal(at(w.acceptableFromMs + 1_000), "ACCEPTABLE_EARLY");
  assert.equal(at(w.acceptableUntilMs - 1_000), "ACCEPTABLE_LATE");
  assert.equal(at(w.acceptableFromMs - 60_000), "TOO_EARLY");
  assert.equal(at(w.acceptableUntilMs + 30_000), "TOO_LATE");
  assert.equal(at(w.missedAfterMs + 60_000), "MISSED");
  assert.equal(classifyHorizonMatch(w, null, null).status, "MISSED");
});

test("a quote inside the window but too stale is not accepted for it", () => {
  const w = horizonWindow(T0, 1);
  const r = classifyHorizonMatch(w, w.targetAtMs, w.targetAtMs + 10 * M);
  assert.equal(r.status, "TOO_LATE");
  assert.equal(r.quoteAgeMs, 10 * M);
});

test("only in-window statuses count as independent", () => {
  assert.equal(isIndependentMatch("ON_TIME"), true);
  assert.equal(isIndependentMatch("ACCEPTABLE_EARLY"), true);
  assert.equal(isIndependentMatch("ACCEPTABLE_LATE"), true);
  for (const s of ["TOO_EARLY", "TOO_LATE", "MISSED", "REUSED_NOT_INDEPENDENT"]) {
    assert.equal(isIndependentMatch(s), false);
  }
});

// ── independence ───────────────────────────────────────────────────────────

test("ONE PROVIDER TIMESTAMP CANNOT SATISFY MULTIPLE HORIZONS", () => {
  const used = new Set();
  const byHorizon = new Map();
  const ts = T0 + 10 * M;
  const first = evaluateIndependence({ window: horizonWindow(T0, 10), providerAtMs: ts, observedAtMs: ts + 1_000, usedProviderTimestamps: used }, byHorizon);
  assert.equal(first.independent, true);
  used.add(ts); byHorizon.set(ts, 10);
  // The SAME observation offered to another horizon.
  const second = evaluateIndependence({ window: horizonWindow(T0, 15), providerAtMs: ts, observedAtMs: ts + 1_000, usedProviderTimestamps: used }, byHorizon);
  assert.equal(second.independent, false);
  assert.equal(second.horizonMatch, "REUSED_NOT_INDEPENDENT");
  assert.equal(second.reusedFromHorizon, 10, "names the horizon it was already counted for");
});

test("SAME PRICE with a DIFFERENT provider timestamp may be independent", () => {
  // A quiet contract legitimately repeats a price; that is real evidence.
  const used = new Set([T0 + 10 * M]);
  const r = evaluateIndependence({
    window: horizonWindow(T0, 15), providerAtMs: T0 + 15 * M, observedAtMs: T0 + 15 * M + 1_000,
    usedProviderTimestamps: used,
  });
  assert.equal(r.independent, true, "independence is keyed on the observation, not the price");
});

test("an out-of-window observation is never independent", () => {
  const r = evaluateIndependence({
    window: horizonWindow(T0, 60), providerAtMs: T0 + 2 * M, observedAtMs: T0 + 2 * M + 1_000,
    usedProviderTimestamps: new Set(),
  });
  assert.equal(r.independent, false);
  assert.equal(r.horizonMatch, "TOO_EARLY");
});

test("claimable horizons collapse from seven to the current window plus its grace", () => {
  // An hour-old position: dueHorizons offers ALL SEVEN at once, which is how one
  // quote ended up written to seven rows. Windows collapse that to the horizon
  // whose window is open, plus the previous one still inside its retry grace.
  assert.deepEqual(claimableHorizons(T0, T0 + 60 * M, []), [30, 60]);
  assert.deepEqual(claimableHorizons(T0, T0 + 3 * M, []), [1, 3]);
});

test("a grace-period horizon is claimable but NOT independently satisfiable", () => {
  // This is the distinction that matters: the 30m row may still be filled at
  // +60m for continuity, but that observation is evidence about 60m, not 30m,
  // and must never be counted as an independent 30m mark.
  const now = T0 + 60 * M;
  assert.ok(claimableHorizons(T0, now, []).includes(30), "claimable for retry");
  const r = evaluateIndependence({
    window: horizonWindow(T0, 30), providerAtMs: now, observedAtMs: now + 1_000,
    usedProviderTimestamps: new Set(),
  });
  assert.equal(r.independent, false, "but not independent evidence for 30m");
  assert.equal(r.horizonMatch, "TOO_LATE");
});

test("horizons whose window closed unclaimed are MISSED, not silently reusable", () => {
  const missed = missedHorizons(T0, T0 + 60 * M, []);
  assert.ok(missed.includes(1) && missed.includes(3) && missed.includes(5));
  assert.equal(missed.includes(60), false, "the current window is not missed");
});

test("a horizon survives one budget-blocked sweep before being MISSED", () => {
  const w = horizonWindow(T0, 5);
  assert.ok(w.missedAfterMs > w.acceptableUntilMs, "a transient failure must not immediately destroy a horizon");
});

// ── summary and gate ───────────────────────────────────────────────────────

test("the independence summary reports the gate honestly", () => {
  const rows = [
    ...Array.from({ length: 6 }, () => ({ horizonMinutes: 1, independent: true, horizonMatch: "ON_TIME" })),
    ...Array.from({ length: 4 }, () => ({ horizonMinutes: 3, independent: false, horizonMatch: "REUSED_NOT_INDEPENDENT" })),
  ];
  const s = summarizeIndependence(rows);
  assert.equal(s.attempted, 10);
  assert.equal(s.independent, 6);
  assert.equal(s.reused, 4);
  assert.equal(s.independentRatePct, 60);
  assert.equal(s.meetsGate, true);
  assert.equal(INDEPENDENT_RATE_GATE, 0.5);
});

test("a degenerate series fails the gate and says why", () => {
  // The production pathology: one independent observation, six carried forward.
  const rows = [
    { horizonMinutes: 1, independent: true, horizonMatch: "ON_TIME" },
    ...Array.from({ length: 6 }, () => ({ horizonMinutes: 3, independent: false, horizonMatch: "REUSED_NOT_INDEPENDENT" })),
  ];
  const s = summarizeIndependence(rows);
  assert.equal(s.independentRatePct, 14.3);
  assert.equal(s.meetsGate, false);
  assert.match(s.note, /not defensible/);
});

test("an empty sample reports null, never 0%", () => {
  const s = summarizeIndependence([]);
  assert.equal(s.independentRatePct, null);
  assert.equal(s.meetsGate, false);
});

// ── persistence ────────────────────────────────────────────────────────────

const evidence = (over = {}) => ({
  markAttemptId: "a1", sessionDate: "2026-08-03", fingerprint: "fp", optionSymbol: "O:NVDA260807C00200000",
  underlying: "NVDA", horizonMinutes: 1,
  targetAtMs: T0 + M, acceptableFromMs: T0 + 30_000, acceptableUntilMs: T0 + 2 * M,
  sweepId: "s1", sweepStartedAtMs: T0, schedulerSelectedAtMs: T0 + 100,
  providerRequestStartedAtMs: T0 + 100, providerResponseReceivedAtMs: T0 + 300, observedAtMs: T0 + 300,
  rawProviderTimestamp: "1785770000123456789", sourceField: "last_quote.last_updated", inferredUnit: "ns",
  normalizedProviderTimestampMs: T0 + 123, providerSkewMs: -177, sweepDriftMs: 300,
  requestLatencyMs: 200, schedulerDelayMs: 100, quoteAgeMs: 177,
  bid: 3.2, ask: 3.3, sourceEndpoint: "v3/snapshot", cacheStatus: "LIVE",
  accepted: true, independent: true, reusedFromHorizon: null,
  horizonMatchStatus: "ON_TIME", markQuality: "INDEPENDENT_FRESH", rejectionReason: null,
  timestampPolicyVersion: "MARK_TS_POLICY_V1", dataQualityVersion: "DATA_QUALITY_V1", ...over,
});

test("evidence persists, is repeat-safe, and keeps the raw timestamp string-safe", { skip }, () => {
  const db = new Database(":memory:");
  ensureAsymmetrySchema(db);
  assert.equal(recordMarkEvidenceOnDb(db, evidence(), T0).created, true);
  assert.equal(recordMarkEvidenceOnDb(db, evidence(), T0).created, false, "repeat-safe by attempt id");
  const row = db.prepare("SELECT raw_provider_timestamp r, raw_digit_count d, midpoint m FROM asymmetry_mark_evidence").get();
  assert.equal(row.r, "1785770000123456789", "19 digits preserved exactly, not rounded through a Number");
  assert.equal(row.d, 19);
  assert.equal(row.m, 3.25, "midpoint is derived, never substituted for a side");
  db.close();
});

test("schema creation is repeat-safe", { skip }, () => {
  const db = new Database(":memory:");
  ensureAsymmetrySchema(db); ensureAsymmetrySchema(db); ensureAsymmetrySchema(db);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='asymmetry_mark_evidence'").get());
  db.close();
});

test("a write failure is returned, never thrown", { skip }, () => {
  const broken = { prepare() { throw new Error("gone"); }, exec() { throw new Error("gone"); } };
  const r = recordMarkEvidenceOnDb(broken, evidence(), T0);
  assert.equal(r.ok, false);
  assert.match(r.error, /gone/);
});

test("the independence report measures the gate from persisted evidence", { skip }, () => {
  const db = new Database(":memory:");
  ensureAsymmetrySchema(db);
  for (let i = 0; i < 6; i++) recordMarkEvidenceOnDb(db, evidence({ markAttemptId: `i${i}`, horizonMinutes: 1 }), T0);
  for (let i = 0; i < 4; i++) {
    recordMarkEvidenceOnDb(db, evidence({
      markAttemptId: `r${i}`, horizonMinutes: 3, independent: false,
      horizonMatchStatus: "REUSED_NOT_INDEPENDENT", markQuality: "REUSED_PRIOR_MARK", reusedFromHorizon: 1,
    }), T0);
  }
  const rep = buildIndependenceReportOnDb(db, "2026-08-03");
  assert.equal(rep.attempts, 10);
  assert.equal(rep.independent, 6);
  assert.equal(rep.reused, 4);
  assert.equal(rep.independentRatePct, 60);
  assert.equal(rep.meetsGate, true);
  assert.equal(rep.requestsPerIndependentMark, 1.67);
  assert.equal(rep.byHorizon.find((h) => h.horizonMinutes === 3).independentPct, 0);
  assert.equal(INDEPENDENT_GATE_PCT, 50);
  db.close();
});

test("a session with no evidence reports null, never a fabricated rate", { skip }, () => {
  const db = new Database(":memory:");
  ensureAsymmetrySchema(db);
  const rep = buildIndependenceReportOnDb(db, "2026-08-03");
  assert.equal(rep.independentRatePct, null);
  assert.equal(rep.meetsGate, false);
  db.close();
});

// ── end to end ─────────────────────────────────────────────────────────────

test("the runner records evidence and never lets it break marking", { skip }, async () => {
  const db = new Database(":memory:");
  ensureAsymmetrySchema(db);
  const first = T0 - 20 * M;
  openAsymmetryCaseOnDb(db, {
    sessionDate: "2026-08-03", fingerprint: "fp", symbol: "NVDA", direction: "CALL",
    optionSymbol: "O:NVDA260807C00200000", state: "CONFIRMING", firstDetectedAtMs: first,
    earlyAsk: 3.25, earlyBid: 3.2, earlySpreadPct: 1.5, setupFamily: "f", scannerVersion: "t",
    evidenceJson: "{}", missingEvidence: [], normalQualifiedAtMs: null, normalAsk: null,
  }, first);

  const res = await runDueAsymmetryMarks(db, {
    quote: async () => ({
      quote: { optionSymbol: "O:NVDA260807C00200000", bid: 3.5, ask: 3.6, quoteAtMs: T0 - 1_000 },
      providerError: null, budgetBlocked: false, observedAtMs: T0,
    }),
    nowMs: T0, sessionDate: "2026-08-03", sweepId: "sweep-1",
    env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
  });
  assert.ok(res.ran);
  const n = db.prepare("SELECT COUNT(*) n FROM asymmetry_mark_evidence").get().n;
  assert.ok(n > 0, "evidence was recorded for every attempt");
  const sweep = db.prepare("SELECT DISTINCT sweep_id s FROM asymmetry_mark_evidence").get().s;
  assert.equal(sweep, "sweep-1");
  // One quote offered to several overdue horizons must be independent for at
  // most one of them.
  const indep = db.prepare("SELECT COUNT(*) n FROM asymmetry_mark_evidence WHERE independent=1").get().n;
  assert.ok(indep <= 1, `one observation was counted independent for ${indep} horizons`);
  db.close();
});

test("evidence recording issues zero provider calls", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync("lib/research/asymmetry/mark-evidence-store.ts", "utf8");
  const code = raw.split("\n")
    .filter((l) => { const t = l.trimStart(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
    .join("\n").toLowerCase();
  for (const banned of ["fetch(", "polygon", "fetchoption", "openai", "anthropic"]) {
    assert.equal(code.includes(banned), false, `${banned} must not appear in an evidence store`);
  }
});

test("horizon-windows is pure", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync("lib/research/asymmetry/horizon-windows.ts", "utf8");
  const code = raw.split("\n")
    .filter((l) => { const t = l.trimStart(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
    .join("\n").toLowerCase();
  for (const banned of ["require(", "fetch(", "prepare(", "process.env", "openai", "anthropic"]) {
    assert.equal(code.includes(banned), false, `${banned} must not appear`);
  }
});

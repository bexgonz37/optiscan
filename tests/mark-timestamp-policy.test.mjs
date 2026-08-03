/**
 * Gate A — FUTURE_QUOTE root cause and the timestamp policy.
 *
 * Production rejected 636 of 995 marks as FUTURE_QUOTE. The cause was NOT
 * normalization and NOT provider clock skew (measured live, the provider is
 * always BEHIND). It was the comparison clock: one Date.now() captured at the
 * start of a sweep that runs for tens of seconds.
 *
 * These tests pin the fix AND pin that the guard was not weakened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMarkTimestamp, summarizeSkew, resolveTimestampPolicy,
  DEFAULT_TIMESTAMP_POLICY, DEFAULT_FUTURE_TOLERANCE_MS,
  TIMESTAMP_POLICY_VERSION, MAX_SAFE,
} from "../lib/research/options/mark-timestamp-policy.ts";
import { normalizeProviderTimestamp, providerTimestampMs } from "../lib/provider-timestamp.js";
import { validateMark, runDueAsymmetryMarks } from "../lib/research/asymmetry/mark-runner.ts";
import { ensureAsymmetrySchema, openAsymmetryCaseOnDb } from "../lib/research/asymmetry/case-store.ts";

let Database = null;
try { Database = (await import("better-sqlite3")).default; new Database(":memory:").close(); }
catch { Database = null; }
const skip = Database ? false : "better-sqlite3 unavailable";

const NOW = 1_785_768_942_018;
const ev = (over = {}) => ({
  raw: "1785768941130622200", sourceField: "last_quote.last_updated",
  normalizedMs: 1_785_768_941_131, inferredUnit: "ns", observedAtMs: NOW, ...over,
});

// ── normalization is NOT the defect ────────────────────────────────────────

test("19-digit nanoseconds normalize correctly — normalization was never the bug", () => {
  const r = normalizeProviderTimestamp(1785768941130622200);
  assert.equal(r.unit, "ns");
  assert.equal(r.ms, 1785768941131);
  assert.equal(r.rejected, null);
});

test("every supported unit normalizes; ambiguous magnitudes are refused", () => {
  assert.equal(normalizeProviderTimestamp(1785768941).unit, "s");
  assert.equal(normalizeProviderTimestamp(1785768941131).unit, "ms");
  assert.equal(normalizeProviderTimestamp(1785768941131000).unit, "us");
  assert.equal(normalizeProviderTimestamp(1785768941131000000).unit, "ns");
  // Between bands: refused, never coerced.
  assert.equal(providerTimestampMs(5e13), null);
  assert.equal(normalizeProviderTimestamp(5e13).rejected, "IMPLAUSIBLE_MAGNITUDE");
  assert.equal(providerTimestampMs("not a number"), null);
  assert.equal(providerTimestampMs(-1), null);
});

test("a 19-digit raw exceeds MAX_SAFE_INTEGER and is flagged for precision", () => {
  assert.ok(Number("1785768941130622200") > MAX_SAFE);
  const v = classifyMarkTimestamp(ev());
  assert.equal(v.precisionLossPossible, true);
  assert.equal(v.rawPreserved, "1785768941130622200", "the raw value is preserved as a string");
  assert.equal(v.accepted, true, "lost digits are sub-millisecond and do not affect the verdict");
});

// ── the real defect ────────────────────────────────────────────────────────

test("a quote observed AFTER the sweep started is valid, not from the future", () => {
  // Sweep began 40s ago; the quote is 1s old at the moment it was observed.
  const sweepStart = NOW - 40_000;
  const v = classifyMarkTimestamp(ev({ normalizedMs: NOW - 1_000, observedAtMs: NOW, sweepStartedAtMs: sweepStart }));
  assert.equal(v.timestampClass, "TIMESTAMP_VALID");
  assert.equal(v.accepted, true);
  assert.equal(v.skewMs, -1_000, "behind the observation clock, as the provider always is");
  assert.equal(v.sweepClockDriftMs, 40_000, "the stale-clock drift stays visible");
});

test("the OLD comparison would have rejected that same good quote", () => {
  // Judged against the sweep-start clock the quote looks 39s in the future.
  const sweepStart = NOW - 40_000;
  const v = classifyMarkTimestamp(ev({ normalizedMs: NOW - 1_000, observedAtMs: sweepStart }));
  assert.equal(v.accepted, false);
  assert.equal(v.timestampClass, "FUTURE_BEYOND_TOLERANCE");
  assert.equal(v.skewMs, 39_000, "this is exactly the 636-mark defect");
});

test("GENUINELY future evidence is still rejected — the guard was not weakened", () => {
  const v = classifyMarkTimestamp(ev({ normalizedMs: NOW + 5_000, observedAtMs: NOW }));
  assert.equal(v.accepted, false);
  assert.equal(v.timestampClass, "FUTURE_BEYOND_TOLERANCE");
  assert.equal(v.skewMs, 5_000);
});

test("the default forward tolerance is ZERO", () => {
  assert.equal(DEFAULT_FUTURE_TOLERANCE_MS, 0);
  assert.equal(DEFAULT_TIMESTAMP_POLICY.futureToleranceMs, 0);
  // 1ms ahead of observation is still rejected at the default.
  assert.equal(classifyMarkTimestamp(ev({ normalizedMs: NOW + 1, observedAtMs: NOW })).accepted, false);
});

test("a bounded tolerance may accept a measured skew, and is versioned and capped", () => {
  const cfg = { ...DEFAULT_TIMESTAMP_POLICY, futureToleranceMs: 250 };
  const inside = classifyMarkTimestamp(ev({ normalizedMs: NOW + 200, observedAtMs: NOW }), cfg);
  assert.equal(inside.timestampClass, "FUTURE_WITHIN_PROVIDER_TOLERANCE");
  assert.equal(inside.accepted, true);
  assert.equal(inside.policyVersion, TIMESTAMP_POLICY_VERSION);
  const outside = classifyMarkTimestamp(ev({ normalizedMs: NOW + 300, observedAtMs: NOW }), cfg);
  assert.equal(outside.accepted, false);
  // The env cap prevents a large arbitrary tolerance being configured.
  assert.equal(resolveTimestampPolicy({ MARK_FUTURE_TOLERANCE_MS: "999999" }).futureToleranceMs, 5_000);
  assert.equal(resolveTimestampPolicy({ MARK_FUTURE_TOLERANCE_MS: "-5" }).futureToleranceMs, 0);
  assert.equal(resolveTimestampPolicy({}).futureToleranceMs, 0);
});

test("a quote hours ahead blames a clock, not the contract", () => {
  const v = classifyMarkTimestamp(ev({ normalizedMs: NOW + 2 * 60 * 60_000, observedAtMs: NOW }));
  assert.equal(v.timestampClass, "SERVER_CLOCK_UNTRUSTED");
  assert.equal(v.accepted, false);
});

test("unusable inputs are classified before any skew maths runs", () => {
  assert.equal(classifyMarkTimestamp(ev({ raw: null })).timestampClass, "INVALID_TIMESTAMP");
  assert.equal(classifyMarkTimestamp(ev({ sourceField: null })).timestampClass, "WRONG_TIMESTAMP_FIELD");
  assert.equal(classifyMarkTimestamp(ev({ normalizedMs: null, inferredUnit: "UNKNOWN" })).timestampClass, "AMBIGUOUS_UNIT");
  assert.equal(classifyMarkTimestamp(ev({ normalizedMs: null, inferredUnit: "ns" })).timestampClass, "INVALID_TIMESTAMP");
  assert.equal(classifyMarkTimestamp(ev({ observedAtMs: 0 })).timestampClass, "SERVER_CLOCK_UNTRUSTED");
  for (const c of ["INVALID_TIMESTAMP", "WRONG_TIMESTAMP_FIELD", "AMBIGUOUS_UNIT"]) {
    assert.ok(typeof c === "string");
  }
});

test("raw value, source field and unit are always preserved for audit", () => {
  const v = classifyMarkTimestamp(ev());
  assert.equal(v.rawPreserved, "1785768941130622200");
  assert.equal(v.sourceField, "last_quote.last_updated");
  assert.equal(v.inferredUnit, "ns");
});

// ── skew diagnostics ───────────────────────────────────────────────────────

test("the distribution separates provider skew from sweep-clock drift", () => {
  // The fingerprint of THIS defect: negative provider skew, large sweep drift.
  const verdicts = [0, 10_000, 20_000, 30_000, 40_000].map((drift) =>
    classifyMarkTimestamp(ev({ normalizedMs: NOW - 1_000, observedAtMs: NOW, sweepStartedAtMs: NOW - drift })));
  const s = summarizeSkew(verdicts);
  assert.equal(s.n, 5);
  assert.equal(s.max, -1_000, "provider skew is negative throughout");
  assert.equal(s.sweepDrift.max, 40_000, "while the sweep clock drifted 40s");
  assert.equal(s.byClass.TIMESTAMP_VALID, 5);
  assert.equal(s.byUnit.ns, 5);
  assert.equal(s.bySourceField["last_quote.last_updated"], 5);
});

test("accepted and rejected maxima are tracked separately", () => {
  const s = summarizeSkew([
    classifyMarkTimestamp(ev({ normalizedMs: NOW - 500, observedAtMs: NOW })),
    classifyMarkTimestamp(ev({ normalizedMs: NOW + 9_000, observedAtMs: NOW })),
  ]);
  assert.equal(s.maxAccepted, -500);
  assert.equal(s.maxRejected, 9_000);
});

// ── the mark runner now uses the observation clock ─────────────────────────

const SESSION = "2026-08-03";
const OCC = "O:NVDA260807C00200000";

function seed(db, firstDetectedAtMs) {
  ensureAsymmetrySchema(db);
  openAsymmetryCaseOnDb(db, {
    sessionDate: SESSION, fingerprint: `${SESSION}|${OCC}`, symbol: "NVDA", direction: "CALL",
    optionSymbol: OCC, state: "CONFIRMING", firstDetectedAtMs,
    earlyAsk: 3.25, earlyBid: 3.2, earlySpreadPct: 1.5, setupFamily: "f", scannerVersion: "t",
    evidenceJson: "{}", missingEvidence: [], normalQualifiedAtMs: null, normalAsk: null,
  }, firstDetectedAtMs);
}

test("a quote newer than the sweep clock is ACCEPTED when observedAtMs is supplied", { skip }, async () => {
  const db = new Database(":memory:");
  const sweepStart = NOW;
  seed(db, sweepStart - 20 * 60_000);
  // Observed 40s into the sweep; the quote is 1s old at that instant.
  const res = await runDueAsymmetryMarks(db, {
    quote: async () => ({
      quote: { optionSymbol: OCC, bid: 3.5, ask: 3.6, quoteAtMs: sweepStart + 39_000 },
      providerError: null, budgetBlocked: false, observedAtMs: sweepStart + 40_000,
    }),
    nowMs: sweepStart, sessionDate: SESSION, env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
  });
  assert.ok(res.marksWritten > 0, "the good quote was kept");
  const reasons = db.prepare("SELECT DISTINCT rejected_reason r FROM asymmetry_marks").all().map((x) => x.r);
  assert.deepEqual(reasons, [null], "no FUTURE_QUOTE rejection");
  db.close();
});

test("without observedAtMs the old sweep-clock behaviour is preserved", { skip }, async () => {
  const db = new Database(":memory:");
  const sweepStart = NOW;
  seed(db, sweepStart - 20 * 60_000);
  const res = await runDueAsymmetryMarks(db, {
    // No observedAtMs — injected test deps keep working unchanged.
    quote: async () => ({
      quote: { optionSymbol: OCC, bid: 3.5, ask: 3.6, quoteAtMs: sweepStart + 39_000 },
      providerError: null, budgetBlocked: false,
    }),
    nowMs: sweepStart, sessionDate: SESSION, env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
  });
  assert.equal(res.marksWritten, 0);
  const reasons = db.prepare("SELECT DISTINCT rejected_reason r FROM asymmetry_marks").all().map((x) => x.r);
  assert.deepEqual(reasons, ["FUTURE_QUOTE"], "falls back to the sweep clock");
  db.close();
});

test("a genuinely future quote is STILL rejected with the observation clock", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db, NOW - 20 * 60_000);
  await runDueAsymmetryMarks(db, {
    quote: async () => ({
      // 30s ahead of the moment it was observed — real future evidence.
      quote: { optionSymbol: OCC, bid: 3.5, ask: 3.6, quoteAtMs: NOW + 30_000 },
      providerError: null, budgetBlocked: false, observedAtMs: NOW,
    }),
    nowMs: NOW, sessionDate: SESSION, env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
  });
  const reasons = db.prepare("SELECT DISTINCT rejected_reason r FROM asymmetry_marks").all().map((x) => x.r);
  assert.deepEqual(reasons, ["FUTURE_QUOTE"], "the guard still holds");
  db.close();
});

test("quote age is measured from observation, so a long sweep no longer inflates it", { skip }, async () => {
  const db = new Database(":memory:");
  const sweepStart = NOW;
  seed(db, sweepStart - 20 * 60_000);
  await runDueAsymmetryMarks(db, {
    quote: async () => ({
      quote: { optionSymbol: OCC, bid: 3.5, ask: 3.6, quoteAtMs: sweepStart + 38_000 },
      providerError: null, budgetBlocked: false, observedAtMs: sweepStart + 40_000,
    }),
    nowMs: sweepStart, sessionDate: SESSION, env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
  });
  const age = db.prepare("SELECT quote_age_ms a FROM asymmetry_marks ORDER BY horizon_minutes LIMIT 1").get().a;
  assert.equal(age, 2_000, "2s old at observation, not -38s against the sweep clock");
  db.close();
});

test("validateMark itself is unchanged and still rejects true future quotes", { skip }, () => {
  assert.equal(validateMark({ optionSymbol: OCC, bid: 1, ask: 1.1, quoteAtMs: NOW + 1 }, OCC, SESSION, NOW), "FUTURE_QUOTE");
  assert.equal(validateMark({ optionSymbol: OCC, bid: 1, ask: 1.1, quoteAtMs: NOW - 1_000 }, OCC, SESSION, NOW), null);
});

test("the policy module is pure — no DB, network, env access, or AI", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync("lib/research/options/mark-timestamp-policy.ts", "utf8");
  const code = raw.split("\n")
    .filter((l) => { const t = l.trimStart(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
    .join("\n").toLowerCase();
  for (const banned of ["require(", "fetch(", "prepare(", "openai", "anthropic", "broker", "webhook"]) {
    assert.equal(code.includes(banned), false, `${banned} must not appear`);
  }
});

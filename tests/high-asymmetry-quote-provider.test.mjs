/**
 * tests/high-asymmetry-quote-provider.test.mjs
 *
 * This suite exists because of a real defect: the quote adapter was first
 * written against `getOptionQuoteSnapshot`, a function that DOES NOT EXIST.
 * Every fetch would have thrown, been swallowed, and recorded as NO_QUOTE — so
 * the mark runner would have degraded to "no data" forever while looking
 * healthy. Nothing in the suite caught it, because every test injected a
 * fabricated quote function.
 *
 * These tests bind the adapter to the REAL provider interface and fail if the
 * two ever drift apart again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { liveAsymmetryQuote, observeAsymmetryCase } from "../lib/research/asymmetry/live-quote.ts";
import { validateMark, runDueAsymmetryMarks } from "../lib/research/asymmetry/mark-runner.ts";
import { ensureAsymmetrySchema, openAsymmetryCaseOnDb } from "../lib/research/asymmetry/case-store.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const OCC = "O:NVDA260807C00200000";
const SESSION = "2026-07-30";
const OBSERVED = Date.parse("2026-07-30T14:00:00.000Z");

// ── The provider function actually exists, with the signature we call ───────

test("the real provider export exists and is the one the adapter uses", async () => {
  const deps = await import("../lib/research/options/live-deps.ts");
  assert.equal(typeof deps.buildLiveGradeDeps, "function", "buildLiveGradeDeps must exist");
  const built = deps.buildLiveGradeDeps();
  assert.equal(typeof built.getQuote, "function", "getQuote must exist on the built deps");
  // Arity: (optionSymbol, underlyingSymbol)
  assert.equal(built.getQuote.length, 2, "getQuote must take the OCC AND the underlying symbol");

  // And the adapter must call THAT function, not an invented name.
  const src = readFileSync("lib/research/asymmetry/live-quote.ts", "utf8");
  assert.match(src, /buildLiveGradeDeps/, "the adapter must use the real provider builder");
  assert.equal(/getOptionQuoteSnapshot/.test(src), false, "the non-existent function must never return");
});

test("the adapter never references a function that does not exist in the repo", () => {
  const src = readFileSync("lib/research/asymmetry/live-quote.ts", "utf8");
  const called = [...src.matchAll(/const \{ (\w+) \} = require\("@\/([^"]+)"\)/g)];
  assert.ok(called.length > 0, "the adapter must require something");
  for (const [, fn, mod] of called) {
    const modSrc = readFileSync(`${mod.replace(/^lib/, "lib")}.ts`, "utf8");
    assert.ok(
      new RegExp(`export (async )?function ${fn}\\b|export const ${fn}\\b`).test(modSrc),
      `${fn} must actually be exported by ${mod}`,
    );
  }
});

// ── The returned shape satisfies what the mark runner needs ────────────────

test("the provider shape maps onto everything the mark runner requires", () => {
  // The grade-deps contract, read from source: bid, ask, quoteAgeMs, providerTimestamp.
  const src = readFileSync("lib/research/options/live-deps.ts", "utf8");
  const contract = src.slice(src.indexOf("getQuote: (optionSymbol"), src.indexOf("fetchUnderlying:"));
  for (const field of ["bid", "ask", "providerTimestamp"]) {
    assert.ok(contract.includes(field), `the provider must return ${field}`);
  }
  // The adapter maps providerTimestamp -> quoteAtMs, which is what validateMark reads.
  const adapter = readFileSync("lib/research/asymmetry/live-quote.ts", "utf8");
  assert.match(adapter, /quoteAtMs: num\(q\.providerTimestamp\)/,
    "providerTimestamp must be mapped to the field validateMark checks");
});

test("a quote from the real shape is freshness-checkable and executable", () => {
  const now = OBSERVED + 5 * 60_000;
  const fromProvider = { optionSymbol: OCC, bid: 2.0, ask: 2.1, quoteAtMs: now - 1000 };
  assert.equal(validateMark(fromProvider, OCC, SESSION, now), null, "a good provider quote must validate");
  // And the same shape is rejected when it is not executable.
  assert.equal(validateMark({ ...fromProvider, quoteAtMs: null }, OCC, SESSION, now), "NO_QUOTE");
  assert.equal(validateMark({ ...fromProvider, bid: 0 }, OCC, SESSION, now), "NO_QUOTE");
});

// ── Provider failure is distinguishable from a genuine absence ─────────────

test("a provider error is NOT recorded as NO_QUOTE", async () => {
  const db = new Database(":memory:");
  ensureAsymmetrySchema(db);
  openAsymmetryCaseOnDb(db, {
    sessionDate: SESSION, fingerprint: `${SESSION}|${OCC}`, symbol: "NVDA", direction: "CALL",
    optionSymbol: OCC, state: "EARLY_ASYMMETRY", firstDetectedAtMs: OBSERVED,
    earlyAsk: 2.0, earlyBid: 1.95, earlySpreadPct: 2.5, setupFamily: null, scannerVersion: null,
    evidenceJson: "{}", missingEvidence: [], normalQualifiedAtMs: null, normalAsk: null,
  }, OBSERVED);

  await runDueAsymmetryMarks(db, {
    quote: async () => ({ quote: null, providerError: "provider 503" }),
    nowMs: OBSERVED + 2 * 60_000, sessionDate: SESSION, env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
  });
  const reasons = db.prepare("SELECT DISTINCT rejected_reason r FROM asymmetry_marks").all().map((x) => x.r);
  assert.deepEqual(reasons, ["PROVIDER_ERROR"], "an outage must be distinguishable from a real absence of quote");

  // A genuine no-quote is recorded differently.
  const db2 = new Database(":memory:");
  ensureAsymmetrySchema(db2);
  openAsymmetryCaseOnDb(db2, {
    sessionDate: SESSION, fingerprint: `${SESSION}|${OCC}`, symbol: "NVDA", direction: "CALL",
    optionSymbol: OCC, state: "EARLY_ASYMMETRY", firstDetectedAtMs: OBSERVED,
    earlyAsk: 2.0, earlyBid: 1.95, earlySpreadPct: 2.5, setupFamily: null, scannerVersion: null,
    evidenceJson: "{}", missingEvidence: [], normalQualifiedAtMs: null, normalAsk: null,
  }, OBSERVED);
  await runDueAsymmetryMarks(db2, {
    quote: async () => ({ quote: null, providerError: null }),
    nowMs: OBSERVED + 2 * 60_000, sessionDate: SESSION, env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
  });
  assert.deepEqual(db2.prepare("SELECT DISTINCT rejected_reason r FROM asymmetry_marks").all().map((x) => x.r), ["NO_QUOTE"]);
  db.close(); db2.close();
});

test("the mark runner does NOT always degrade to NO_QUOTE with a working provider", async () => {
  const db = new Database(":memory:");
  ensureAsymmetrySchema(db);
  openAsymmetryCaseOnDb(db, {
    sessionDate: SESSION, fingerprint: `${SESSION}|${OCC}`, symbol: "NVDA", direction: "CALL",
    optionSymbol: OCC, state: "EARLY_ASYMMETRY", firstDetectedAtMs: OBSERVED,
    earlyAsk: 2.0, earlyBid: 1.95, earlySpreadPct: 2.5, setupFamily: null, scannerVersion: null,
    evidenceJson: "{}", missingEvidence: [], normalQualifiedAtMs: null, normalAsk: null,
  }, OBSERVED);
  const now = OBSERVED + 6 * 60_000;
  const res = await runDueAsymmetryMarks(db, {
    quote: async (occ, underlying) => {
      assert.equal(occ, OCC, "the exact OCC must be passed through");
      assert.equal(underlying, "NVDA", "the underlying symbol must be passed through");
      return { quote: { optionSymbol: occ, bid: 3.0, ask: 3.1, quoteAtMs: now - 500 }, providerError: null };
    },
    nowMs: now, sessionDate: SESSION, env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
  });
  assert.ok(res.marksWritten > 0, "a working provider must produce real marks");
  assert.equal(res.marksRejected, 0);
  // ask entry 2.00 -> bid 3.00 = +50%
  assert.equal(db.prepare("SELECT return_pct r FROM asymmetry_marks LIMIT 1").get().r, 50);
  db.close();
});

// ── The observe adapter used by the transition sweep ───────────────────────

test("observeAsymmetryCase never invents trigger or invalidation", async () => {
  const src = readFileSync("lib/research/asymmetry/live-quote.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function observeAsymmetryCase"));
  assert.match(fn, /triggered: false/, "a quote alone cannot prove a trigger");
  assert.match(fn, /invalidated: false/, "a quote alone cannot prove invalidation");
  assert.match(fn, /openInterest: null/, "OI is not returned by this path and must stay absent");
});

test("both adapters return null rather than throwing when the provider is unavailable", async () => {
  // No Next server/db in the test process, so the require inside will fail —
  // which is precisely the containment being asserted.
  const r = await liveAsymmetryQuote(OCC, "NVDA");
  assert.equal(typeof r, "object");
  assert.ok("quote" in r && "providerError" in r, "must always return the result envelope");
  const o = await observeAsymmetryCase({ fingerprint: "fp", optionSymbol: OCC, symbol: "NVDA" });
  assert.ok(o === null || typeof o === "object", "must never throw");
});

// ── The transition runner has a REAL scheduler caller ──────────────────────

test("the scheduler calls the transition runner on a bounded cadence", () => {
  const sched = readFileSync("lib/scheduler.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(sched, /runAsymmetryTransitions/, "the scheduler must call the transition runner");
  assert.match(sched, /observeAsymmetryCase/, "it must supply the real observation adapter");
  assert.match(sched, /jobDue\(s\.lastRun\.asymmetryTransitions, iv\.asymmetryTransitionsMs, nowMs\)/);
  assert.match(sched, /runJob\("asymmetryTransitions"/);

  const policy = readFileSync("lib/scheduler-policy.ts", "utf8");
  assert.match(policy, /asymmetryTransitionsMs: clampInt/, "the cadence must be bounded by clampInt");
});

test("the transition sweep exposes last-run status and errors for diagnostics", () => {
  const sched = readFileSync("lib/scheduler.ts", "utf8");
  assert.match(sched, /lastAsymmetryTransitions/, "sweep status must be exposed in scheduler state");
});

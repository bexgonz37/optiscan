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

// REBOUND 2026-08-02. The adapter used to read one contract by fetching its
// whole chain via buildLiveGradeDeps().getQuote, which cost up to 3 requests per
// contract and exhausted the shared daily provider budget mid-session. It now
// calls fetchOptionContractSnapshot — one request, exact contract. The tests
// keep their original purpose: the adapter must call a function that REALLY
// EXISTS, with the shape the mark runner needs.

test("the real provider export exists and is the one the adapter uses", async () => {
  const provider = await import("../lib/polygon-provider.js");
  assert.equal(typeof provider.fetchOptionContractSnapshot, "function",
    "fetchOptionContractSnapshot must exist");
  // Arity: (underlying, optionSymbol)
  assert.equal(provider.fetchOptionContractSnapshot.length, 2,
    "it must take the underlying AND the exact OCC");

  const src = readFileSync("lib/research/asymmetry/live-quote.ts", "utf8");
  assert.match(src, /fetchOptionContractSnapshot/, "the adapter must use the real single-contract fetch");
  assert.equal(/getOptionQuoteSnapshot/.test(src), false, "the non-existent function must never return");
  // The whole-chain read is what blew the budget; it must not come back here.
  // Checked against CALLS, not prose — the docstring names it deliberately so
  // the next reader knows why it was removed.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/fetchOptionChain\s*[(,}]/.test(code), false,
    "reading one contract must never fetch a whole chain again");
});

test("the adapter never references a function that does not exist in the repo", () => {
  const src = readFileSync("lib/research/asymmetry/live-quote.ts", "utf8");
  const called = [...src.matchAll(/const \{ (\w+) \} = require\("@\/([^"]+)"\)/g)];
  assert.ok(called.length > 0, "the adapter must require something");
  for (const [, fn, mod] of called) {
    // Modules are .ts or .js; resolve whichever exists rather than assuming.
    let modSrc = null;
    for (const ext of [".ts", ".js"]) {
      try { modSrc = readFileSync(`${mod}${ext}`, "utf8"); break; } catch { /* try next */ }
    }
    assert.ok(modSrc, `${mod} must resolve to a real file`);
    assert.ok(
      new RegExp(`export (async )?function ${fn}\\b|export const ${fn}\\b`).test(modSrc),
      `${fn} must actually be exported by ${mod}`,
    );
  }
});

// ── The returned shape satisfies what the mark runner needs ────────────────

test("the provider shape maps onto everything the mark runner requires", () => {
  // parseOptionsSnapshot is the single mapper for BOTH the chain and the
  // single-contract path, so the fields cannot drift between them.
  const src = readFileSync("lib/polygon-provider.js", "utf8");
  const mapper = src.slice(src.indexOf("export function parseOptionsSnapshot"), src.indexOf("const REQUEST_TIMEOUT_MS"));
  for (const field of ["bid", "ask", "providerTimestamp"]) {
    assert.ok(mapper.includes(field), `the provider mapper must produce ${field}`);
  }
  assert.match(src, /const \[contract\] = parseOptionsSnapshot/,
    "the single-contract path must reuse the chain mapper, not a parallel one");

  // The adapter maps providerTimestamp -> quoteAtMs, which is what validateMark reads.
  const adapter = readFileSync("lib/research/asymmetry/live-quote.ts", "utf8");
  assert.match(adapter, /quoteAtMs: num\(c\.providerTimestamp\)/,
    "providerTimestamp must be mapped to the field validateMark checks");
});

test("a quote from the real shape is freshness-checkable and executable", () => {
  const now = OBSERVED + 5 * 60_000;
  const fromProvider = { optionSymbol: OCC, bid: 2.0, ask: 2.1, quoteAtMs: now - 1000 };
  assert.equal(validateMark(fromProvider, OCC, SESSION, now), null, "a good provider quote must validate");
  // And the same shape is rejected when it is not executable.
  assert.equal(validateMark({ ...fromProvider, quoteAtMs: null }, OCC, SESSION, now), "NO_QUOTE");
  // A zero bid is a REAL observation about the contract, so it gets its own
  // reason rather than being pooled with quotes that never arrived.
  assert.equal(validateMark({ ...fromProvider, bid: 0 }, OCC, SESSION, now), "NO_TWO_SIDED_MARKET");
});

test("a budget refusal is reported by the provider as its own flag", async () => {
  const provider = await import("../lib/polygon-provider.js");
  // Cap of 1 with the meter already at 1 forces a refusal on the next call.
  const prevCap = process.env.POLYGON_DAILY_CALL_CAP;
  const prevKey = process.env.POLYGON_API_KEY;
  process.env.POLYGON_API_KEY = prevKey || "test-key";
  process.env.POLYGON_DAILY_CALL_CAP = "1";
  provider.__resetCallStatsForTest();
  provider.recordPolygonCall();
  const res = await provider.fetchOptionContractSnapshot("NVDA", OCC);
  assert.equal(res.quotaExceeded, true, "a refused request must say so");
  assert.equal(res.available, false);
  assert.equal(res.contract, null, "a refusal never yields a fabricated quote");
  provider.__resetCallStatsForTest();
  if (prevCap === undefined) delete process.env.POLYGON_DAILY_CALL_CAP; else process.env.POLYGON_DAILY_CALL_CAP = prevCap;
  if (prevKey === undefined) delete process.env.POLYGON_API_KEY;
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
  for (const field of ["openInterest", "contractVolume", "dte", "delta", "currentUnderlyingPrice", "underlyingQuoteAtMs"]) {
    assert.match(fn, new RegExp(`${field}: fetched\\.contractEvidence`), `${field} must reuse the exact-OCC response`);
  }
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

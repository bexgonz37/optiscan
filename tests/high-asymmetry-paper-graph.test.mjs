/**
 * tests/high-asymmetry-paper-graph.test.mjs
 *
 * RUNTIME GRAPH ACCEPTANCE for the paper lane.
 *
 * The failure this suite exists to prevent is the one that has already
 * happened twice in this system: a module that exists, type-checks, is fully
 * unit-tested, and is never called by anything that actually runs. A test
 * importing a function proves the function works. It does not prove the
 * function is reachable from a scheduler tick.
 *
 * So every assertion below is about PRODUCTION callers. A module imported only
 * by a test file, or only by the diagnostics route, fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const SCHEDULER = strip(read("lib/scheduler.ts"));
const POLICY = read("lib/scheduler-policy.ts");
const RUNNER = strip(read("lib/research/asymmetry/paper/runner.ts"));
const EOD = strip(read("lib/research/asymmetry/eod-review.ts"));
const ROUTE = strip(read("app/api/research/asymmetry/live/route.ts"));
const LOOP = strip(read("lib/research/options/loop.ts"));

// ── Node 1: the live options loop reaches capture ───────────────────────────

test("NODE live loop -> capture: the live loop calls the capture entrypoint", () => {
  assert.match(LOOP, /captureAsymmetryCandidate/, "the live options loop must call capture");
  const capture = strip(read("lib/research/asymmetry/capture.ts"));
  assert.match(capture, /openAsymmetryCaseOnDb/, "capture must write a case");
});

// ── Node 2: capture -> case store ───────────────────────────────────────────

test("NODE case store: asymmetry_cases has a runtime writer and a runtime reader", () => {
  const store = read("lib/research/asymmetry/case-store.ts");
  assert.match(store, /INSERT OR IGNORE INTO asymmetry_cases/);
  assert.match(store, /FROM asymmetry_cases/);
  // The reader is used by production code, not only by tests.
  assert.match(RUNNER, /listCasesOnDb/, "the paper runner reads cases at runtime");
  assert.match(EOD, /listCasesOnDb/, "so does the EOD review");
});

// ── Node 3: the paper runner has a REAL scheduler caller ────────────────────

test("NODE paper runner: the scheduler calls it on a bounded cadence", () => {
  assert.match(SCHEDULER, /runAsymmetryPaper/, "the scheduler must call the paper runner");
  assert.match(SCHEDULER, /jobDue\(s\.lastRun\.asymmetryPaper, iv\.asymmetryPaperMs, nowMs\)/,
    "it must be gated by the standard due check");
  assert.match(SCHEDULER, /runJob\("asymmetryPaper"/, "it must run through runJob so failures are recorded");
  assert.match(POLICY, /asymmetryPaperMs: clampInt/, "the cadence must be bounded by clampInt");
});

test("NODE paper runner: it is supplied the REAL verified quote provider", () => {
  const job = SCHEDULER.slice(SCHEDULER.indexOf("async function asymmetryPaperJob"), SCHEDULER.indexOf("async function asymmetryEodJob"));
  assert.match(job, /liveAsymmetryQuote/, "the same adapter forward marking already uses");
  assert.equal(/getOptionQuoteSnapshot/.test(job), false, "the function that never existed must not return");
});

test("NODE paper runner: its sweep status is exposed for diagnostics", () => {
  assert.match(SCHEDULER, /lastAsymmetryPaper/);
  assert.match(ROUTE, /lastAsymmetryPaper/, "and the route actually surfaces it");
});

// ── Node 4: entry decision is reached from the runner, not only from tests ──

test("NODE entry decision: the runner calls it, not just the test suite", () => {
  assert.match(RUNNER, /openAsymmetryPaperTrade/, "the runner must call the entry writer");
  const entry = strip(read("lib/research/asymmetry/paper/entry.ts"));
  assert.match(entry, /decidePaperEntry/, "which calls the pure decision");
  assert.match(entry, /openPaperPositionOnDb|recordPaperSkipOnDb/, "and persists one outcome or the other");
});

// ── Node 5: every table has BOTH a runtime writer and a runtime reader ──────

test("NODE tables: each paper table is written and read by production code", () => {
  const store = read("lib/research/asymmetry/paper/store.ts");
  const runtimeReaders = [RUNNER, EOD, ROUTE].join("\n");
  const tables = {
    asymmetry_paper_positions: { writer: /INSERT OR IGNORE INTO asymmetry_paper_positions/, reader: /listPaperPositionsOnDb|listOpenPaperPositionsOnDb/ },
    asymmetry_paper_marks: { writer: /INSERT OR IGNORE INTO asymmetry_paper_marks/, reader: /listPaperMarkRejectionsOnDb/ },
    asymmetry_paper_skips: { writer: /INSERT INTO asymmetry_paper_skips/, reader: /listPaperSkipsOnDb/ },
    asymmetry_quant_reports: { writer: /INSERT INTO asymmetry_quant_reports/, reader: /readQuantReportOnDb/ },
    asymmetry_paper_report_delivery: { writer: /INSERT INTO asymmetry_paper_report_delivery/, reader: /readReportDeliveryOnDb/ },
  };
  for (const [table, { writer, reader }] of Object.entries(tables)) {
    assert.match(store, writer, `${table} needs a writer`);
    assert.ok(reader.test(runtimeReaders), `${table} needs a RUNTIME reader (runner, EOD, or route)`);
  }
});

// ── Node 6: management and exits ────────────────────────────────────────────

test("NODE management: the runner evaluates versioned exits and applies them", () => {
  assert.match(RUNNER, /evaluatePaperManagement/);
  assert.match(RUNNER, /closePaperPositionOnDb/);
  assert.match(RUNNER, /recordUnverifiedExitOnDb/, "an unobtainable exit must have its own path");
  assert.match(RUNNER, /writePaperMarkOnDb/);
  assert.match(RUNNER, /applyPaperMarkOnDb/);
});

// ── Node 7: Quant aggregation is reached from the EOD job ───────────────────

test("NODE quant: the EOD review builds and PERSISTS the Quant report", () => {
  assert.match(EOD, /buildQuantReport/, "the EOD review must build the report");
  assert.match(EOD, /persistQuantReportOnDb/, "and persist it");
  assert.match(SCHEDULER, /runAsymmetryEodReview/, "and the scheduler must call the EOD review");
});

// ── Node 8: AI advisory is injected, budgeted, and last ─────────────────────

test("NODE ai advisory: injected by the scheduler, after persistence, budgeted", () => {
  assert.match(SCHEDULER, /explainAsymmetryReviewWithBudget/);
  const persistIdx = EOD.indexOf("out.persisted = true");
  const explainIdx = EOD.indexOf("await deps.explain(review)");
  assert.ok(persistIdx > 0 && persistIdx < explainIdx, "persistence precedes the advisory call");
});

// ── Node 9: diagnostics reads everything ────────────────────────────────────

test("NODE diagnostics: the route surfaces the whole paper chain", () => {
  for (const field of [
    "paperTrading", "openPositions", "closedPositions", "rejectionReasons",
    "markRejections", "quantCohorts", "quantProposals", "aiBudget",
    "canSendSubscriber", "automaticRealTrading",
  ]) {
    assert.match(ROUTE, new RegExp(field), `diagnostics must expose ${field}`);
  }
  assert.match(ROUTE, /webhookConfigured|recapWebhookConfigured/, "webhooks by presence only");
  assert.equal(/HIGH_ASYMMETRY_PRIVATE_WEBHOOK\s*\]/.test(ROUTE), false, "the route must never read a webhook VALUE out");
});

// ── The acceptance gate itself ──────────────────────────────────────────────

test("NO paper module is reachable only from tests or diagnostics", () => {
  // Production files that may count as a caller. The test directory and the
  // diagnostics route are deliberately excluded: neither proves a module runs.
  const productionSources = [
    "lib/scheduler.ts",
    "lib/research/asymmetry/paper/runner.ts",
    "lib/research/asymmetry/paper/entry.ts",
    "lib/research/asymmetry/paper/store.ts",
    "lib/research/asymmetry/paper/management.ts",
    "lib/research/asymmetry/paper/quant.ts",
    "lib/research/asymmetry/paper/lane.ts",
    "lib/research/asymmetry/paper/sizing.ts",
    "lib/research/asymmetry/paper/report-delivery.ts",
    "lib/research/asymmetry/eod-review.ts",
    "lib/research/asymmetry/transition-runner.ts",
    "lib/ai/asymmetry-explain.ts",
  ].map((f) => ({ file: f, src: strip(read(f)) }));

  const modules = readdirSync("lib/research/asymmetry/paper").filter((f) => f.endsWith(".ts"));
  for (const mod of modules) {
    const name = mod.replace(/\.ts$/, "");
    const callers = productionSources.filter(
      ({ file, src }) => !file.endsWith(`/paper/${mod}`) && new RegExp(`paper/${name}|\\./${name}\\.ts|"\\./${name}`).test(src),
    );
    assert.ok(callers.length > 0, `paper/${mod} has NO production caller — it is imported only by tests or diagnostics`);
  }
});

test("the runner is reached from the scheduler and nowhere test-only", () => {
  // The strongest single link in the chain: without this edge every other
  // module in the lane is dead code no matter how well it is tested.
  assert.match(SCHEDULER, /require\("@\/lib\/research\/asymmetry\/paper\/runner"\)/,
    "the scheduler must require the runner by its real path");
});

// ── Failure isolation, idempotency ──────────────────────────────────────────

test("every paper runtime entrypoint contains its own failures", () => {
  for (const [file, fn] of [
    ["lib/research/asymmetry/paper/runner.ts", "runAsymmetryPaper"],
    ["lib/research/asymmetry/paper/entry.ts", "openAsymmetryPaperTrade"],
  ]) {
    const src = read(file);
    const body = src.slice(src.indexOf(fn));
    assert.match(body, /try\s*\{/, `${fn} must wrap its work`);
    assert.match(body, /catch\s*\(/, `${fn} must catch`);
  }
  // The runner catches per-case AND per-position AND around the whole sweep.
  assert.ok((RUNNER.match(/catch\s*\(/g) ?? []).length >= 3,
    "one bad row must not abort the sweep, and the sweep must not reach the scheduler");
});

test("idempotency is structural, not conventional", () => {
  const store = read("lib/research/asymmetry/paper/store.ts");
  assert.match(store, /PRIMARY KEY \(session_date, position_fingerprint\)/, "one position per fingerprint");
  assert.match(store, /PRIMARY KEY \(session_date, position_fingerprint, marked_at_ms\)/, "one mark per instant");
  assert.match(store, /INSERT OR IGNORE INTO asymmetry_paper_positions/, "a replayed open is a no-op");
  // A close is guarded on the position still being OPEN, so a replayed close
  // cannot produce a second exit.
  assert.match(store, /position_state='OPEN'\s*\n?\s*`\)/, "closes are guarded on OPEN");
});

test("every stage is independently flag-gated and off by default", () => {
  assert.match(read("lib/research/asymmetry/paper/lane.ts"), /HIGH_ASYMMETRY_PAPER_ENABLED/);
  assert.match(RUNNER, /env\[PAPER_ENABLED_ENV\] !== "1"/, "the runner no-ops unless explicitly enabled");
  assert.match(read("lib/research/asymmetry/paper/entry.ts"), /HIGH_ASYMMETRY_PAPER_ENABLED !== "1"/,
    "and so does the entry writer, independently");
});

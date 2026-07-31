/**
 * tests/high-asymmetry-paper-activation.test.mjs
 *
 * The automatic activation gate: the thing that lets paper trading start
 * without a human, WITHOUT lowering the bar for starting it.
 *
 * The assertions that matter most are the refusals. It is easy to write a gate
 * that eventually says yes. What makes this one safe is that the environment
 * flag alone is not enough, zero cases is not enough, an ask with no later bid
 * is not enough, an OCC mismatch is a defect rather than a retry, and a second
 * scheduler tick cannot activate twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

import {
  ACTIVATION_STATES, evaluateActivationGate, resolvePaperPermission,
  ensureActivationSchema, armActivationOnDb, readActivationOnDb, activateOnDb,
  blockActivationOnDb, claimNotificationOnDb, etMinutesOfDay, isWithinGateWindow,
  isPastGateWindow, GATE_OPEN_ET_MINUTE, GATE_CLOSE_ET_MINUTE, MIN_ATTEMPTS_FOR_DEFECT,
} from "../lib/research/asymmetry/paper/activation.ts";
import { runPaperActivationGate, gatherGateEvidence, buildGateMessage } from "../lib/research/asymmetry/paper/gate-runner.ts";
import { openAsymmetryPaperTrade } from "../lib/research/asymmetry/paper/entry.ts";
import { runAsymmetryPaper } from "../lib/research/asymmetry/paper/runner.ts";
import { ensureAsymmetrySchema, openAsymmetryCaseOnDb } from "../lib/research/asymmetry/case-store.ts";
import { writeMarkOnDb } from "../lib/research/asymmetry/mark-runner.ts";
import { ensureAsymmetryPaperSchema, listPaperPositionsOnDb, listPaperSkipsOnDb } from "../lib/research/asymmetry/paper/store.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const OCC = "O:NVDA260807C00200000";
const SESSION = "2026-07-31";
// 10:00 ET on a real trading day — inside both the quote session and the gate window.
const T0 = Date.parse("2026-07-31T14:00:00.000Z");
const ON = { HIGH_ASYMMETRY_PAPER_ENABLED: "1" };

function freshDb() {
  const db = new Database(":memory:");
  ensureAsymmetrySchema(db);
  ensureAsymmetryPaperSchema(db);
  ensureActivationSchema(db);
  return db;
}

function seedCase(db, over = {}) {
  openAsymmetryCaseOnDb(db, {
    sessionDate: SESSION, fingerprint: `${SESSION}|${OCC}`, symbol: "NVDA", direction: "CALL",
    optionSymbol: OCC, state: "EARLY_ASYMMETRY", firstDetectedAtMs: T0,
    earlyAsk: 2.0, earlyBid: 1.9, earlySpreadPct: 5, setupFamily: "BREAKOUT", scannerVersion: null,
    evidenceJson: "{}", missingEvidence: [], normalQualifiedAtMs: null, normalAsk: null,
    ...over,
  }, T0);
}

/** A valid later bid mark on the exact same OCC. */
function seedAcceptedMark(db, over = {}) {
  writeMarkOnDb(db, {
    sessionDate: SESSION, fingerprint: `${SESSION}|${OCC}`, optionSymbol: OCC,
    horizonMinutes: 5, markedAtMs: T0 + 5 * 60_000, bid: 2.4, ask: 2.5,
    quoteAgeMs: 500, returnPct: 20, rejectedReason: null, ...over,
  });
}

function seedRejectedMarks(db, reason, n) {
  for (let i = 0; i < n; i += 1) {
    writeMarkOnDb(db, {
      sessionDate: SESSION, fingerprint: `${SESSION}|${OCC}`, optionSymbol: OCC,
      horizonMinutes: i + 1, markedAtMs: T0 + (i + 1) * 60_000, bid: null, ask: null,
      quoteAgeMs: null, returnPct: null, rejectedReason: reason,
    });
  }
}

const candidate = () => ({
  sessionDate: SESSION, caseFingerprint: `${SESSION}|${OCC}`, symbol: "NVDA", direction: "CALL",
  optionSymbol: OCC, setupFamily: "BREAKOUT", state: "EARLY_ASYMMETRY",
  evidenceJson: "{}", missingEvidence: [],
});
const quote = (over = {}) => ({ optionSymbol: OCC, bid: 1.9, ask: 2.0, quoteAtMs: T0 - 1000, underlyingPrice: 180, ...over });

// ── The two locks ───────────────────────────────────────────────────────────

test("THE ENVIRONMENT FLAG ALONE CANNOT OPEN A PAPER TRADE", () => {
  const db = freshDb();
  // Master authorization present. Nothing has proved the quote path.
  const res = openAsymmetryPaperTrade(db, candidate(), quote(), { nowMs: T0, env: ON });
  assert.equal(res.opened, false, "authorizing the attempt is not authorizing the trade");
  assert.equal(res.rejection, "NOT_ACTIVATED");
  assert.equal(listPaperPositionsOnDb(db, SESSION).length, 0);
  // The refusal is recorded, not silent.
  assert.equal(listPaperSkipsOnDb(db, SESSION)[0].reason, "NOT_ACTIVATED");
  db.close();
});

test("the persisted ACTIVE state is also required, and together they permit", () => {
  const db = freshDb();
  armActivationOnDb(db, SESSION, T0);
  // Still ARMED: refused.
  assert.equal(openAsymmetryPaperTrade(db, candidate(), quote(), { nowMs: T0, env: ON, activationActive: false }).opened, false);
  // ACTIVE: permitted.
  const ok = openAsymmetryPaperTrade(db, candidate(), quote(), { nowMs: T0, env: ON, activationActive: true });
  assert.equal(ok.opened, true);
  assert.equal(listPaperPositionsOnDb(db, SESSION).length, 1);
  db.close();
});

test("resolvePaperPermission reports DISABLED when the master flag is absent", () => {
  const db = freshDb();
  armActivationOnDb(db, SESSION, T0);
  activateOnDb(db, { sessionDate: SESSION, nowMs: T0, evidence: emptyEvidence() });
  // Even with the row ACTIVE, no master flag means DISABLED and no entries.
  const p = resolvePaperPermission(db, SESSION, {});
  assert.equal(p.masterPaperAuthorized, false);
  assert.equal(p.activationState, "DISABLED");
  assert.equal(p.paperEntriesAllowed, false);
  db.close();
});

test("removing the environment flag immediately disables entries", async () => {
  const db = freshDb();
  seedCase(db);
  armActivationOnDb(db, SESSION, T0);
  activateOnDb(db, { sessionDate: SESSION, nowMs: T0, evidence: emptyEvidence() });
  // Flag gone mid-session: the whole sweep no-ops.
  const res = await runAsymmetryPaper(db, {
    quote: async () => ({ quote: quote(), providerError: null }),
    nowMs: T0, sessionDate: SESSION, env: {},
  });
  assert.equal(res.ran, false);
  assert.match(res.reason, /HIGH_ASYMMETRY_PAPER_ENABLED/);
  assert.equal(listPaperPositionsOnDb(db, SESSION).length, 0);
  db.close();
});

test("a default-constructed deps object cannot accidentally activate", () => {
  const db = freshDb();
  // activationActive omitted entirely — must default to refusing.
  const res = openAsymmetryPaperTrade(db, candidate(), quote(), { nowMs: T0, env: ON });
  assert.equal(res.opened, false);
  assert.equal(res.rejection, "NOT_ACTIVATED");
  db.close();
});

// ── The gate window ─────────────────────────────────────────────────────────

test("the ET window is computed from an explicit time zone, not the process TZ", () => {
  assert.equal(etMinutesOfDay(Date.parse("2026-07-31T13:30:00Z")), 9 * 60 + 30);
  assert.equal(etMinutesOfDay(Date.parse("2026-07-31T13:40:00Z")), GATE_OPEN_ET_MINUTE);
  assert.equal(etMinutesOfDay(Date.parse("2026-07-31T15:30:00Z")), GATE_CLOSE_ET_MINUTE);
  assert.equal(isWithinGateWindow(Date.parse("2026-07-31T13:39:00Z")), false, "09:39 is too early");
  assert.equal(isWithinGateWindow(Date.parse("2026-07-31T13:40:00Z")), true);
  assert.equal(isWithinGateWindow(Date.parse("2026-07-31T15:30:00Z")), true);
  assert.equal(isWithinGateWindow(Date.parse("2026-07-31T15:31:00Z")), false, "11:31 is too late");
  assert.equal(isPastGateWindow(Date.parse("2026-07-31T15:31:00Z")), true);
});

test("the gate does not run before 09:40 ET", async () => {
  const db = freshDb();
  seedCase(db); seedAcceptedMark(db);
  const early = Date.parse("2026-07-31T13:35:00Z"); // 09:35 ET
  const res = await runPaperActivationGate(db, { nowMs: early, env: ON });
  assert.equal(res.state, "ARMED_WAITING_FOR_LIVE_PROOF");
  assert.equal(res.activated, false, "an equity premarket print must never count as options proof");
  assert.match(res.reason, /outside the gate window/);
  db.close();
});

test("past 11:30 ET without proof the session is blocked as insufficient", async () => {
  const db = freshDb();
  seedCase(db);
  const late = Date.parse("2026-07-31T16:00:00Z"); // 12:00 ET
  const res = await runPaperActivationGate(db, { nowMs: late, env: ON });
  assert.equal(res.state, "BLOCKED_INSUFFICIENT_EVIDENCE");
  assert.equal(res.blocked, true);
  assert.equal(readActivationOnDb(db, SESSION).state, "BLOCKED_INSUFFICIENT_EVIDENCE");
  db.close();
});

// ── Gate evaluation ─────────────────────────────────────────────────────────

test("no case means no activation", async () => {
  const db = freshDb();
  const res = await runPaperActivationGate(db, { nowMs: T0, env: ON });
  assert.equal(res.outcome, "INSUFFICIENT");
  assert.equal(res.activated, false);
  assert.match(res.evidence ? "ok" : "", /ok/);
  assert.equal(res.state, "ARMED_WAITING_FOR_LIVE_PROOF", "it stays armed and retries");
  db.close();
});

test("an ask WITHOUT a later bid does not activate", async () => {
  const db = freshDb();
  seedCase(db); // early_ask 2.00, no marks at all
  const res = await runPaperActivationGate(db, { nowMs: T0, env: ON });
  assert.equal(res.outcome, "INSUFFICIENT");
  assert.equal(res.activated, false);
  assert.equal(res.evidence.proof, null);
  db.close();
});

test("a bid that is NOT later than detection does not count as proof", async () => {
  const db = freshDb();
  seedCase(db);
  seedAcceptedMark(db, { markedAtMs: T0 - 60_000 }); // before detection
  const res = await runPaperActivationGate(db, { nowMs: T0, env: ON });
  assert.equal(res.activated, false, "a mark predating capture cannot prove forward tracking");
  db.close();
});

test("a mark on a DIFFERENT OCC does not count as proof", async () => {
  const db = freshDb();
  seedCase(db);
  seedAcceptedMark(db, { optionSymbol: "O:AMD260807C00100000" });
  const res = await runPaperActivationGate(db, { nowMs: T0, env: ON });
  assert.equal(res.activated, false, "exact-OCC identity must hold on BOTH sides of the join");
  db.close();
});

test("a zero or missing bid does not count as proof", async () => {
  for (const bid of [0, null]) {
    const db = freshDb();
    seedCase(db);
    seedAcceptedMark(db, { bid });
    const res = await runPaperActivationGate(db, { nowMs: T0, env: ON });
    assert.equal(res.activated, false, `bid ${bid} is not executable`);
    db.close();
  }
});

test("a case with no fresh ask cannot activate even with a good bid", async () => {
  const db = freshDb();
  seedCase(db, { earlyAsk: null });
  seedAcceptedMark(db);
  const res = await runPaperActivationGate(db, { nowMs: T0, env: ON });
  assert.equal(res.activated, false, "without an entry ask there is no simulated fill to prove");
  db.close();
});

test("a valid ask plus a LATER valid bid on the exact OCC activates", async () => {
  const db = freshDb();
  seedCase(db); seedAcceptedMark(db);
  const res = await runPaperActivationGate(db, { nowMs: T0 + 6 * 60_000, env: ON });
  assert.equal(res.outcome, "ACTIVATE");
  assert.equal(res.activated, true);
  assert.equal(res.state, "ACTIVE");

  const rec = readActivationOnDb(db, SESSION);
  assert.equal(rec.state, "ACTIVE");
  assert.equal(rec.firstAcceptedAsk, 2.0);
  assert.equal(rec.firstAcceptedBid, 2.4);
  assert.equal(rec.optionSymbol, OCC);
  assert.ok(rec.activatedAtMs > 0);
  assert.ok(rec.evidence.proof, "the evidence is persisted, not just the verdict");
  db.close();
});

// ── Defect classification ───────────────────────────────────────────────────

test("dominant WRONG_OCC is a quote-path DEFECT, not a retry", async () => {
  const db = freshDb();
  seedCase(db);
  seedRejectedMarks(db, "WRONG_OCC", MIN_ATTEMPTS_FOR_DEFECT);
  const res = await runPaperActivationGate(db, { nowMs: T0, env: ON });
  assert.equal(res.outcome, "DEFECT");
  assert.equal(res.state, "BLOCKED_QUOTE_PATH_DEFECT");
  assert.match(readActivationOnDb(db, SESSION).blockReason, /WRONG_OCC/);
  db.close();
});

test("dominant NO_QUOTE is a defect only after enough attempts", async () => {
  const thin = freshDb();
  seedCase(thin);
  seedRejectedMarks(thin, "NO_QUOTE", MIN_ATTEMPTS_FOR_DEFECT - 1);
  const a = await runPaperActivationGate(thin, { nowMs: T0, env: ON });
  assert.equal(a.outcome, "INSUFFICIENT", "declaring a defect on thin data would be a guess");
  thin.close();

  const enough = freshDb();
  seedCase(enough);
  seedRejectedMarks(enough, "NO_QUOTE", MIN_ATTEMPTS_FOR_DEFECT);
  const b = await runPaperActivationGate(enough, { nowMs: T0, env: ON });
  assert.equal(b.outcome, "DEFECT");
  enough.close();
});

test("a provider outage is INSUFFICIENT, not a code defect", async () => {
  const db = freshDb();
  seedCase(db);
  seedRejectedMarks(db, "PROVIDER_ERROR", MIN_ATTEMPTS_FOR_DEFECT + 2);
  const res = await runPaperActivationGate(db, { nowMs: T0, env: ON });
  assert.equal(res.outcome, "INSUFFICIENT", "an outage must not send anyone to change correct code");
  assert.match(res.reason ?? res.evidence.rejectionCounts ? "ok" : "", /ok/);
  assert.notEqual(res.state, "BLOCKED_QUOTE_PATH_DEFECT");
  db.close();
});

test("scheduler errors block activation regardless of quote evidence", () => {
  const decision = evaluateActivationGate({
    ...emptyEvidence(), casesCaptured: 1, schedulerHealthy: false, schedulerErrors: ["boom"],
    proof: { caseFingerprint: "f", optionSymbol: OCC, symbol: "NVDA", entryAsk: 2, markBid: 2.4, detectedAtMs: T0, markedAtMs: T0 + 1 },
  });
  assert.equal(decision.outcome, "INSUFFICIENT");
  assert.match(decision.reason, /scheduler reported errors/);
});

test("subscriber or real-trading isolation failure is an immediate DEFECT", () => {
  for (const bad of [{ canSendSubscriber: true }, { automaticRealTrading: true }]) {
    const d = evaluateActivationGate({ ...emptyEvidence(), casesCaptured: 5, ...bad });
    assert.equal(d.outcome, "DEFECT");
  }
});

// ── Idempotency and durability ──────────────────────────────────────────────

test("repeated scheduler ticks do not reactivate or duplicate", async () => {
  const db = freshDb();
  seedCase(db); seedAcceptedMark(db);
  const first = await runPaperActivationGate(db, { nowMs: T0 + 6 * 60_000, env: ON });
  assert.equal(first.activated, true);
  const activatedAt = readActivationOnDb(db, SESSION).activatedAtMs;

  for (let i = 0; i < 5; i += 1) {
    const again = await runPaperActivationGate(db, { nowMs: T0 + (7 + i) * 60_000, env: ON });
    assert.equal(again.activated, false, "a second tick must not re-activate");
    assert.equal(again.state, "ACTIVE");
  }
  assert.equal(readActivationOnDb(db, SESSION).activatedAtMs, activatedAt, "the timestamp must not move");
  db.close();
});

test("the atomic transition is guarded on ARMED, so a race produces one winner", () => {
  const db = freshDb();
  armActivationOnDb(db, SESSION, T0);
  assert.equal(activateOnDb(db, { sessionDate: SESSION, nowMs: T0, evidence: emptyEvidence() }), true);
  assert.equal(activateOnDb(db, { sessionDate: SESSION, nowMs: T0 + 1, evidence: emptyEvidence() }), false);
  // And a block cannot demote an already-ACTIVE day.
  assert.equal(blockActivationOnDb(db, {
    sessionDate: SESSION, nowMs: T0 + 2, state: "BLOCKED_QUOTE_PATH_DEFECT",
    reason: "late", evidence: emptyEvidence(),
  }), false);
  assert.equal(readActivationOnDb(db, SESSION).state, "ACTIVE");
  db.close();
});

test("arming never overwrites a state the session already reached", () => {
  const db = freshDb();
  armActivationOnDb(db, SESSION, T0);
  activateOnDb(db, { sessionDate: SESSION, nowMs: T0, evidence: emptyEvidence() });
  armActivationOnDb(db, SESSION, T0 + 60_000);
  assert.equal(readActivationOnDb(db, SESSION).state, "ACTIVE", "a redeploy must not re-arm an active day");
  db.close();
});

test("activation survives a redeploy because it lives in the database", async () => {
  const file = `${process.env.TEMP ?? "."}/asym-activation-${Date.now()}.db`;
  const first = new Database(file);
  ensureAsymmetrySchema(first); ensureAsymmetryPaperSchema(first); ensureActivationSchema(first);
  seedCase(first); seedAcceptedMark(first);
  await runPaperActivationGate(first, { nowMs: T0 + 6 * 60_000, env: ON });
  assert.equal(readActivationOnDb(first, SESSION).state, "ACTIVE");
  first.close();

  // A brand-new process/connection — the redeploy.
  const second = new Database(file);
  const permission = resolvePaperPermission(second, SESSION, ON);
  assert.equal(permission.activationState, "ACTIVE");
  assert.equal(permission.paperEntriesAllowed, true, "no re-proof and no Railway change after a redeploy");
  second.close();
  try { require("node:fs").unlinkSync(file); } catch { /* best effort */ }
});

// ── Notification ────────────────────────────────────────────────────────────

test("exactly one owner-private message per state per session", async () => {
  const db = freshDb();
  seedCase(db); seedAcceptedMark(db);
  const sent = [];
  const notify = async (content) => { sent.push(content); return { ok: true }; };
  await runPaperActivationGate(db, { nowMs: T0 + 6 * 60_000, env: ON, notify });
  await runPaperActivationGate(db, { nowMs: T0 + 7 * 60_000, env: ON, notify });
  await runPaperActivationGate(db, { nowMs: T0 + 8 * 60_000, env: ON, notify });
  assert.equal(sent.length, 1, "the gate must not re-announce every tick");
  assert.match(sent[0], /PAPER_GATE_ACTIVE/);
  assert.match(sent[0], new RegExp(OCC));
  db.close();
});

test("claiming a notification is atomic", () => {
  const db = freshDb();
  armActivationOnDb(db, SESSION, T0);
  assert.equal(claimNotificationOnDb(db, SESSION, "PAPER_GATE_ACTIVE", T0), true);
  assert.equal(claimNotificationOnDb(db, SESSION, "PAPER_GATE_ACTIVE", T0 + 1), false);
});

test("a notification failure never changes the activation state", async () => {
  const db = freshDb();
  seedCase(db); seedAcceptedMark(db);
  const res = await runPaperActivationGate(db, {
    nowMs: T0 + 6 * 60_000, env: ON,
    notify: async () => { throw new Error("discord down"); },
  });
  assert.equal(res.activated, true, "the gate decision stands regardless of delivery");
  assert.equal(readActivationOnDb(db, SESSION).state, "ACTIVE");
  assert.ok(res.errors.some((e) => /notify/.test(e)));
  db.close();
});

test("the message never claims profit and marks itself simulated", () => {
  const msg = buildGateMessage("PAPER_GATE_ACTIVE", SESSION, {
    ...emptyEvidence(), casesCaptured: 1, acceptedMarks: 1,
    proof: { caseFingerprint: "f", optionSymbol: OCC, symbol: "NVDA", entryAsk: 2, markBid: 2.4, detectedAtMs: T0, markedAtMs: T0 + 1 },
  }, "ok");
  assert.match(msg, /Simulated paper research only/);
  assert.equal(/profit|guarantee|will make/i.test(msg), false);
});

// ── Disabled behaviour ──────────────────────────────────────────────────────

test("with the master flag absent the gate does no work at all", async () => {
  const db = freshDb();
  seedCase(db); seedAcceptedMark(db);
  const sent = [];
  const res = await runPaperActivationGate(db, { nowMs: T0 + 6 * 60_000, env: {}, notify: async (c) => { sent.push(c); return { ok: true }; } });
  assert.equal(res.ran, false);
  assert.equal(res.state, "DISABLED");
  assert.equal(sent.length, 0, "a disabled gate must not notify");
  assert.equal(readActivationOnDb(db, SESSION), null, "and must not write a row");
  db.close();
});

// ── Structural safety ───────────────────────────────────────────────────────

test("no AI module is involved in the gate", () => {
  for (const f of ["activation.ts", "gate-runner.ts"]) {
    const src = readFileSync(`lib/research/asymmetry/paper/${f}`, "utf8");
    assert.equal(/from\s+["'].*\/ai\//.test(src), false, `${f} must not import lib/ai`);
    assert.equal(/require\(["'][^"']*\/ai\//.test(src), false);
    assert.equal(/anthropic|openai|runStructuredAiJob|claude-/i.test(src), false);
  }
});

test("no real broker path and no subscriber webhook is reachable from the gate", () => {
  for (const f of ["activation.ts", "gate-runner.ts"]) {
    const src = readFileSync(`lib/research/asymmetry/paper/${f}`, "utf8");
    for (const forbidden of [/\/execution\//, /\/broker\//, /\bplaceOrder\b/, /DISCORD_WEBHOOK_OPTIONS/, /DISCORD_WEBHOOK_URL\b/, /DISCORD_WEBHOOK_WATCHLIST/, /DISCORD_WEBHOOK_RECAP/]) {
      assert.equal(forbidden.test(src), false, `${f} must not reference ${forbidden}`);
    }
    assert.equal(/\bfetch\s*\(/.test(src), false, `${f} must make no network call — the sender is injected`);
  }
});

test("the gate makes no provider call of its own", () => {
  const src = readFileSync("lib/research/asymmetry/paper/gate-runner.ts", "utf8");
  assert.equal(/fetchOptionChain|buildLiveGradeDeps|liveAsymmetryQuote/.test(src), false,
    "the gate must judge the REAL production marks, not a parallel path that might succeed where production fails");
});

test("the scheduler runs the gate on a bounded cadence, before the paper sweep", () => {
  const sched = readFileSync("lib/scheduler.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(sched, /runPaperActivationGate/);
  assert.match(sched, /runJob\("asymmetryPaperGate"/);
  assert.match(sched, /jobDue\(s\.lastRun\.asymmetryPaperGate, iv\.asymmetryPaperGateMs, nowMs\)/);
  // Ordering matters: activating and then entering on the same beat removes a
  // whole tick of latency on the first position of the day.
  assert.ok(sched.indexOf('runJob("asymmetryPaperGate"') < sched.indexOf('runJob("asymmetryPaper"'),
    "the gate must run before the paper sweep");
  const policy = readFileSync("lib/scheduler-policy.ts", "utf8");
  assert.match(policy, /asymmetryPaperGateMs: clampInt/, "the cadence must be bounded by clampInt");
});

test("the gate uses ONLY the High-Asymmetry private webhook", () => {
  const sched = readFileSync("lib/scheduler.ts", "utf8");
  const job = sched.slice(sched.indexOf("async function asymmetryPaperGateJob"), sched.indexOf("async function asymmetryEodJob"));
  assert.match(job, /resolvePrivateConfig/, "it must resolve the private config");
  assert.match(job, /cfg\.refusedReason/, "and honour the subscriber-collision refusal");
  assert.equal(/DISCORD_WEBHOOK_(OPTIONS|URL|WATCHLIST|RECAP)/.test(job), false);
});

test("every activation state is represented and DISABLED is the absent-flag state", () => {
  assert.deepEqual([...ACTIVATION_STATES].sort(), [
    "ACTIVE", "ARMED_WAITING_FOR_LIVE_PROOF", "BLOCKED_INSUFFICIENT_EVIDENCE",
    "BLOCKED_QUOTE_PATH_DEFECT", "DISABLED",
  ]);
});

test("the activation migration is additive and repeat-safe", () => {
  const db = new Database(":memory:");
  for (let i = 0; i < 4; i += 1) ensureActivationSchema(db);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='asymmetry_paper_activation'").get());
  const src = readFileSync("lib/research/asymmetry/paper/activation.ts", "utf8");
  assert.equal(/DROP\s+TABLE|ALTER\s+TABLE|DELETE\s+FROM/i.test(src), false, "no destructive DDL or DML");
  db.close();
});

function emptyEvidence() {
  return {
    casesCaptured: 0, markAttempts: 0, acceptedMarks: 0, rejectionCounts: {},
    proof: null, schedulerHealthy: true, schedulerErrors: [],
    canSendSubscriber: false, automaticRealTrading: false,
  };
}

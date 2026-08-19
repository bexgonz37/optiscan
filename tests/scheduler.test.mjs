import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { schedulerIntervals, jobDue, deriveSchedulerBeatState } from "../lib/scheduler-policy.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ── pure cadence policy ──────────────────────────────────────────────────────

test("scheduler intervals have safe defaults", () => {
  const iv = schedulerIntervals({});
  assert.equal(iv.maintenanceMs, 5 * 60_000);
  assert.equal(iv.learningMs, 60 * 60_000);
  assert.equal(iv.supervisorMs, 30_000);
  assert.equal(iv.forwardLabelsMs, 60_000);
  assert.equal(iv.improvementMs, 6 * 60 * 60_000);
  assert.equal(iv.brokerReadinessMs, 60 * 60_000);
});

test("scheduler intervals are clamped against misconfiguration", () => {
  const tooFast = schedulerIntervals({ SCHED_MAINTENANCE_MS: "5", SCHED_SUPERVISOR_MS: "1", SCHED_FORWARD_LABELS_MS: "1" });
  assert.equal(tooFast.maintenanceMs, 60_000, "maintenance floored to 60s");
  assert.equal(tooFast.supervisorMs, 15_000, "supervisor floored to 15s");
  assert.equal(tooFast.forwardLabelsMs, 30_000, "forward labels floored to 30s");
  const garbage = schedulerIntervals({ SCHED_LEARNING_MS: "notanumber" });
  assert.equal(garbage.learningMs, 60 * 60_000, "falls back to default");
});

test("jobDue is true on first run and after the interval elapses", () => {
  assert.equal(jobDue(null, 1000, 5000), true);
  assert.equal(jobDue(5000, 1000, 5500), false);
  assert.equal(jobDue(5000, 1000, 6000), true);
});

// ── scheduler wiring (source-spec) ──────────────────────────────────────────

test("scheduler is single-owner (worker lease) and started from server boot", () => {
  const sch = read("lib/scheduler.ts");
  assert.ok(/acquireLease\(db\(\), LEASE_NAME/.test(sch), "acquires the scheduler lease");
  assert.ok(/heartbeatLease\(/.test(sch), "heartbeats while owner");
  // Standby still records a completed beat — a non-owner beat DID finish, and
  // health must not read that as a wedge.
  assert.ok(/if \(!owner\) \{[^}]*return; \}/.test(sch), "non-owners run no jobs");
  const boot = read("lib/server-boot.ts");
  assert.ok(/startScheduler\(\)/.test(boot), "started from server boot");
});

test("scheduler lease failure mode is explicitly documented as bounded degraded fail-open", () => {
  const sch = read("lib/scheduler.ts");
  assert.ok(/fail-open/i.test(sch), "lease failure mode is named explicitly");
  assert.ok(/DB lease is the only deterministic cross-process coordinator/.test(sch), "documents why local fallback would be unsafe");
  assert.ok(/bounded,[\s\S]*idempotent/.test(sch), "documents why degraded scheduler jobs can safely proceed");
});

test("scheduler guards against overlapping runs of the same job", () => {
  const sch = read("lib/scheduler.ts");
  assert.ok(/if \(b\.has\(name\)\) return;/.test(sch), "in-process overlap guard");
});

test("forward labels are detached from the scheduler heartbeat", () => {
  const sch = read("lib/scheduler.ts");
  assert.ok(/setImmediate\(\(\) => \{ void runJob\("forwardLabels"/.test(sch), "worker starts after the beat yields");
  assert.ok(/jobDue\(s\.lastRun\.forwardLabels, iv\.forwardLabelsMs, nowMs\)\) launchForwardLabels\(nowMs\)/.test(sch));
  assert.doesNotMatch(sch, /await runJob\("forwardLabels"/, "heartbeat never awaits the slow-path worker");
});

test("learning job uses the BOUNDED cycle (gated retrain), never a raw train call", () => {
  const sch = read("lib/scheduler.ts");
  assert.ok(/runLearningCycle\(\)/.test(sch), "delegates to the bounded learning cycle");
  // The bounded cycle owns the retrain policy; the scheduler never calls raw train.
  assert.ok(!/trainAndEvaluate\s*\(/.test(sch), "no raw training call");
});

test("supervisor job is gated behind SUPERVISOR_RUNTIME (default off)", () => {
  const sch = read("lib/scheduler.ts");
  assert.ok(/supervisorRuntimeEnabled\(\)/.test(sch));
  assert.ok(/if \(!supervisorRuntimeEnabled\(\)\) return;/.test(sch));
});

test("scheduler changes no source code / trading rules (only sync/refresh/cycle jobs)", () => {
  const sch = read("lib/scheduler.ts");
  assert.ok(!/writeFile|child_process|git |exec\(/.test(sch), "no code mutation / shell");
});

test("improvement audit is low-frequency, gated (default off), and proposal-only", () => {
  const sch = read("lib/scheduler.ts");
  assert.ok(/IMPROVEMENT_AUDIT === "1"/.test(sch), "explicit opt-in flag");
  assert.ok(/if \(!improvementAuditEnabled\(\)\) return;/.test(sch), "gated off by default");
  assert.ok(/runImprovementAudit\(\)/.test(sch), "runs the proposal-only audit");
  // Uses the low-frequency improvement cadence.
  assert.ok(/jobDue\(s\.lastRun\.improvement, iv\.improvementMs/.test(sch));
  // Never merges / edits code from the scheduler.
  assert.ok(!/auto[-_]?merge|writeFile|applyProposal/i.test(sch), "no auto-merge/apply from scheduler");
});

test("broker readiness soak job is wired and never auto-cutovers", () => {
  const sch = read("lib/scheduler.ts");
  assert.ok(/runBrokerReadinessSoakJob/.test(sch), "runs soak readiness job");
  assert.ok(/jobDue\(s\.lastRun\.brokerReadiness, iv\.brokerReadinessMs/.test(sch));
  assert.ok(/Observational soak only/.test(sch));
  assert.doesNotMatch(sch, /PAPER_BROKER_V2_READS_ENABLED\s*=\s*["']1["']/);
  const soak = read("lib/broker/soak-report.ts");
  assert.match(soak, /cutoverPerformed:\s*false/);
  assert.match(soak, /READINESS_CUTOVER_GATE_MET/);
});

// ── liveness: a hung job must not kill the beat (2026-08-19 outage) ─────────
//
// Production froze at 2026-08-19T04:58:47Z: the beat entered, a job never
// settled, and because the next tick is only scheduled after the beat resolves,
// the scheduler stopped forever while `started`/`isOwner`/healthz all still read
// healthy. The asymmetry marks/transitions/paper-gate/EOD lanes and the
// supervisor cycle were dead for the rest of the session.

test("job and beat budgets have safe defaults and are clamped", () => {
  const iv = schedulerIntervals({});
  assert.equal(iv.jobTimeoutMs, 3 * 60_000);
  assert.equal(iv.beatTimeoutMs, 10 * 60_000);
  // The longest legitimate job bounds itself at 120s, so the budget must exceed it.
  assert.ok(iv.jobTimeoutMs > 120_000, "job budget leaves headroom over the historical miner");
  assert.ok(iv.beatTimeoutMs > iv.jobTimeoutMs, "a single job cannot exhaust the whole-beat budget");
  const tooFast = schedulerIntervals({ SCHED_JOB_TIMEOUT_MS: "1", SCHED_BEAT_TIMEOUT_MS: "1" });
  assert.equal(tooFast.jobTimeoutMs, 30_000, "job budget floored");
  assert.equal(tooFast.beatTimeoutMs, 60_000, "beat budget floored");
});

test("runJob races every job against a budget and never awaits it unbounded", () => {
  const sch = read("lib/scheduler.ts");
  assert.ok(/Promise\.race\(\[work, budget\]\)/.test(sch), "runJob races the job against its budget");
  assert.ok(/jobTimeouts\[name\] \+= 1/.test(sch), "a budget overrun is counted, not swallowed");
  assert.ok(
    /if \(b\.has\(name\)\) return; \/\/ already running/.test(sch),
    "the overlap guard keeps an abandoned job from being started twice",
  );
});

test("the loop schedules the next tick even when a beat hangs", () => {
  const sch = read("lib/scheduler.ts");
  const loop = sch.slice(sch.indexOf("const loop = async () =>"));
  assert.ok(/Promise\.race\(\[\s*beat\(\)/.test(loop), "the whole beat is raced against a backstop budget");
  assert.ok(/beatTimeouts \+= 1/.test(loop), "an abandoned beat is counted");
  // The reschedule must be unconditional — this is the line whose absence caused the outage.
  assert.ok(
    /setTimeout\(loop, BASE_TICK_MS\)/.test(loop) && !/if \([^)]*\)\s*g\.__optiscanSchedulerTimer = setTimeout\(loop/.test(loop),
    "the next tick is scheduled unconditionally",
  );
});

test("beat completion is recorded separately from beat start", () => {
  const sch = read("lib/scheduler.ts");
  assert.ok(/s\.lastBeatAtMs = nowMs/.test(sch), "beat start is recorded");
  assert.ok(/s\.lastBeatCompletedAtMs = Date\.now\(\)/.test(sch), "beat completion is recorded");
});

test("beat state is derived from beat COMPLETION, not from started/isOwner", () => {
  const base = { baseTickMs: 15_000, beatTimeoutMs: 10 * 60_000 };
  const frozenAt = 1_787_115_527_627; // 2026-08-19T04:58:47Z — the real freeze instant

  // The outage shape: started, owner, lease held, healthz ok — and dead for 9h22m.
  const wedged = deriveSchedulerBeatState({
    started: true, isOwner: true, lastBeatCompletedAtMs: frozenAt,
    nowMs: frozenAt + 9 * 60 * 60_000 + 22 * 60_000, ...base,
  });
  assert.equal(wedged.state, "WEDGED", "a 9h22m gap in completed beats must not read as healthy");
  assert.match(wedged.reason, /no beat has completed/);

  const healthy = deriveSchedulerBeatState({
    started: true, isOwner: true, lastBeatCompletedAtMs: frozenAt, nowMs: frozenAt + 5_000, ...base,
  });
  assert.equal(healthy.state, "HEALTHY");

  const stale = deriveSchedulerBeatState({
    started: true, isOwner: true, lastBeatCompletedAtMs: frozenAt, nowMs: frozenAt + 3 * 60_000, ...base,
  });
  assert.equal(stale.state, "STALE", "slow but not yet wedged");

  // A standby process is not wedged just because it runs no jobs.
  assert.equal(deriveSchedulerBeatState({
    started: true, isOwner: false, lastBeatCompletedAtMs: null, nowMs: frozenAt, ...base,
  }).state, "STANDBY");
  assert.equal(deriveSchedulerBeatState({
    started: false, isOwner: false, lastBeatCompletedAtMs: null, nowMs: frozenAt, ...base,
  }).state, "NOT_STARTED");
});

test("runtime status exposes scheduler health so a wedge is visible", () => {
  const rs = read("lib/runtime-status.ts");
  assert.ok(/schedulerHealth\(nowMs\)/.test(rs), "runtime status asks for derived health");
  assert.ok(/health: schedHealth/.test(rs), "and reports it on the scheduler worker block");
});

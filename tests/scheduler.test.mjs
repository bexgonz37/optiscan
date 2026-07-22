import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { schedulerIntervals, jobDue } from "../lib/scheduler-policy.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ── pure cadence policy ──────────────────────────────────────────────────────

test("scheduler intervals have safe defaults", () => {
  const iv = schedulerIntervals({});
  assert.equal(iv.maintenanceMs, 5 * 60_000);
  assert.equal(iv.learningMs, 60 * 60_000);
  assert.equal(iv.supervisorMs, 30_000);
  assert.equal(iv.improvementMs, 6 * 60 * 60_000);
});

test("scheduler intervals are clamped against misconfiguration", () => {
  const tooFast = schedulerIntervals({ SCHED_MAINTENANCE_MS: "5", SCHED_SUPERVISOR_MS: "1" });
  assert.equal(tooFast.maintenanceMs, 60_000, "maintenance floored to 60s");
  assert.equal(tooFast.supervisorMs, 15_000, "supervisor floored to 15s");
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
  assert.ok(/if \(!owner\) return;/.test(sch), "non-owners run no jobs");
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

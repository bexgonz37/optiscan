/**
 * boot-guard-idempotency.test.mjs — the background runtime must start exactly once
 * per process, no matter how many callers race for it.
 *
 * Three independent paths can trigger boot in production:
 *   1. instrumentation.register() at process start
 *   2. /api/healthz — the Railway liveness probe, every 60s
 *   3. /api/health and 34 API routes via deferServerBoot()
 *
 * and webpack inlines server-boot into more than one server chunk, so the module
 * body itself can be evaluated twice in one process. If the guard were module-scoped
 * this would start the scanner, scheduler, paper engine and graders twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOT_STATE_KEY,
  bootState,
  claimBootStart,
  claimBootSchedule,
  bootHasStarted,
} from "../lib/boot-guard.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const scope = () => ({});

test("only the first caller may run the real boot", () => {
  const s = scope();
  assert.equal(claimBootStart(s), true, "first caller boots");
  for (let i = 0; i < 25; i++) {
    assert.equal(claimBootStart(s), false, "every later caller is a no-op");
  }
  assert.equal(bootHasStarted(s), true);
});

test("a Railway probe every 60s cannot restart the runtime", () => {
  const s = scope();
  claimBootStart(s); // instrumentation boots at process start
  let extraBoots = 0;
  for (let probe = 0; probe < 100; probe++) {
    if (claimBootStart(s)) extraBoots++;
  }
  assert.equal(extraBoots, 0, "healthz probes must never start a second runtime");
});

test("two copies of the module share one state object through the global registry", () => {
  // Simulates webpack inlining server-boot into two chunks: both resolve the same
  // Symbol.for key on the same scope, so they see the same object.
  const shared = scope();
  const copyA = bootState(shared);
  const copyB = bootState(shared);
  assert.equal(copyA, copyB, "same object identity, not a copy");
  copyA.started = true;
  assert.equal(copyB.started, true, "state written by one copy is visible to the other");
  assert.equal(Symbol.for("optiscan.serverBoot"), BOOT_STATE_KEY, "key comes from the cross-realm registry");
});

test("scheduling collapses to one, and a scheduled boot blocks further scheduling", () => {
  const s = scope();
  assert.equal(claimBootSchedule(s), true, "first request schedules");
  for (let i = 0; i < 10; i++) {
    assert.equal(claimBootSchedule(s), false, "concurrent requests do not pile up boots");
  }
  // The scheduled callback then runs the real boot exactly once.
  assert.equal(claimBootStart(s), true);
  assert.equal(claimBootStart(s), false);
});

test("once boot has run, nothing schedules another one", () => {
  const s = scope();
  claimBootStart(s);
  assert.equal(claimBootSchedule(s), false, "a started runtime is never re-scheduled");
});

test("healthz kickstarts boot but never blocks or fails the liveness probe", () => {
  const route = read("app/api/healthz/route.ts");
  assert.match(route, /ensureServerBoot/, "healthz is the safety net if instrumentation ever fails again");
  assert.match(route, /setImmediate\(/, "boot must be deferred so it runs after the response");
  assert.match(route, /status:\s*200/, "liveness must stay 200");
  // The boot call must be inside a try/catch so a boot failure cannot 500 the probe.
  assert.match(route, /try\s*\{[^]*ensureServerBoot[^]*\}\s*catch/, "boot failure must not break liveness");
});

test("server-boot delegates to the shared guard rather than module-scoped flags", () => {
  const src = read("lib/server-boot.ts");
  assert.match(src, /claimBootStart\(\)/, "ensureServerBoot must claim through the shared guard");
  assert.match(src, /claimBootSchedule\(\)/, "deferServerBoot must claim through the shared guard");
  assert.doesNotMatch(src, /^let started\b/m, "no module-scoped boot flag may come back");
  assert.doesNotMatch(src, /^let bootScheduled\b/m, "no module-scoped schedule flag may come back");
});

test("instrumentation still imports server-boot by a traceable literal specifier", () => {
  // Guards the runtime-artifact fix: a runtime path here is untraceable and the
  // module silently never reaches the standalone image.
  const src = read("instrumentation.ts");
  assert.match(src, /await import\(\s*["']@\/lib\/server-boot["']\s*\)/);
  assert.doesNotMatch(src, /pathToFileURL|process\.cwd\(\)/);
});

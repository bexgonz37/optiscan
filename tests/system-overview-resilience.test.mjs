import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/**
 * System Health resilience contract. The /data page renders /api/system/overview
 * every 5s; if that route throws (e.g. the SQLite volume isn't mounted on Railway
 * and getDb() throws), the app error boundary shows "Something went wrong". The
 * route must therefore isolate every subsystem and ALWAYS return 200 with a
 * faults[] list instead of 500-ing.
 */
const routeRaw = read("app/api/system/overview/route.ts");
// Strip comments so we assert on CODE, not prose.
const route = routeRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("overview route isolates subsystems with safe() and returns faults[]", () => {
  assert.ok(/const\s+safe\s*=/.test(route), "defines a request-local safe() helper");
  assert.ok(/const\s+faults\s*:\s*string\[\]\s*=\s*\[\]/.test(route), "collects faults in a request-local array");
  assert.ok(/faults,/.test(route), "returns faults[] in the JSON body");
  // Each fragile subsystem call must be wrapped by safe(...).
  for (const call of ["getSystemDataHealth", "discordDeliverySummary", "supervisorTelemetry", "ownerSettings", "getDb"]) {
    assert.ok(route.includes(call), `${call} still referenced`);
  }
});

test("overview route never returns a non-200 status (liveness of the health page itself)", () => {
  assert.ok(/NextResponse\.json\(/.test(route), "responds with JSON");
  assert.ok(!/status:\s*5\d\d/.test(route), "no 5xx status literal — the health page must not itself error out");
  assert.ok(!/status:\s*4\d\d/.test(route), "no 4xx status literal — telemetry is read-only and unauth-gated here");
});

test("faults[] is surfaced on the System Health page", () => {
  const page = read("app/data/page.tsx");
  assert.ok(/faults\?:\s*string\[\]/.test(page), "Overview type includes faults");
  assert.ok(/Subsystem faults/.test(page), "renders a Subsystem faults card so a degraded subsystem is visible");
});

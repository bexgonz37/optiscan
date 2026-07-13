import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  supervisorDiscordDeliveryEnabled, legacyOptionsSuppressed, calloutCanonicalPath,
} from "../lib/callouts/routing.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }

// 1. Production start command exists (standalone server, boots the runtime).
test("Dockerfile runs the standalone server (node server.js) + entrypoint", () => {
  const df = read("Dockerfile");
  assert.ok(/CMD \["node", "server\.js"\]/.test(df), "standalone server CMD");
  assert.ok(/ENTRYPOINT \["\/app\/docker-entrypoint\.sh"\]/.test(df), "volume-safe entrypoint");
  assert.ok(/output: "standalone"/.test(read("next.config.mjs")), "standalone output configured");
});

// 2. Railway configuration parses.
test("railway.json parses and uses the Dockerfile builder, one replica", () => {
  const cfg = JSON.parse(read("railway.json"));
  assert.equal(cfg.build.builder, "DOCKERFILE");
  assert.equal(cfg.deploy.numReplicas, 1);
  assert.equal(cfg.deploy.healthcheckPath, "/api/healthz");
  assert.equal(cfg.deploy.restartPolicyType, "ON_FAILURE");
});

// 3. PORT is respected (not hard-coded at runtime).
test("PORT is respected — no hard-coded runtime port for the server", () => {
  const df = read("Dockerfile");
  // The standalone server reads process.env.PORT; the healthcheck reads it too.
  assert.ok(/process\.env\.PORT\|\|8780/.test(df), "healthcheck uses injected PORT");
  assert.ok(!/next start -p \d+/.test(df), "no next-start with a fixed port");
  const cfg = JSON.parse(read("railway.json"));
  assert.ok(!cfg.deploy.startCommand || !/-p\s+\d+/.test(cfg.deploy.startCommand), "no fixed port in start command");
});

// 4. Database path points to the configured persistent location.
test("database path uses ALERT_DB_DIR and the example points it at the volume", () => {
  assert.ok(/process\.env\.ALERT_DB_DIR/.test(read("lib/db.ts")), "db.ts reads ALERT_DB_DIR");
  assert.ok(/ALERT_DB_DIR=\/app\/data/.test(read(".env.railway.example")), "example sets /app/data");
  assert.ok(/VOLUME \["\/app\/data"\]/.test(read("Dockerfile")), "volume declared at /app/data");
});

// 5–7. Healthcheck never exposes secrets and never fails for market/model state.
test("healthz exposes no secrets and 503s only on a DB failure", () => {
  const raw = read("app/api/healthz/route.ts");
  // Strip block + line comments so we check the CODE, not the doc prose.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/WEBHOOK|SCAN_API_TOKEN|API_KEY|process\.env\.[A-Z]/i.test(code), "no secret/env values in output");
  // 503 is tied to dbOk only — not to session/model/discord.
  assert.ok(/status: dbOk \? 200 : 503/.test(code));
  assert.ok(!/session|closed|loopState|marketSession|modelStatus|discordConfigured/.test(code), "no market/model/discord gating");
});

// 8. Runtime status remains detailed.
test("runtime status remains detailed (worker/scheduler/learning/model/improvement)", () => {
  const rs = read("lib/runtime-status.ts");
  for (const s of ["worker", "scheduler", "learning", "model", "improvement", "supervisor", "callouts"]) {
    assert.ok(rs.includes(s), `runtime-status missing section: ${s}`);
  }
});

// 9. Stage A does not send Supervisor Discord callouts.
test("Stage A: supervisor Discord delivery is OFF", () => {
  const stageA = { SUPERVISOR_RUNTIME: "0", CALLOUT_CANONICAL_PATH: "legacy", AGENT_CALLOUT_DISCORD: "0" };
  assert.equal(supervisorDiscordDeliveryEnabled(stageA), false);
  assert.equal(legacyOptionsSuppressed(stageA), false);
});

// 10. Stage B does not send Supervisor Discord callouts.
test("Stage B: supervisor runs but Discord delivery stays OFF", () => {
  const stageB = { SUPERVISOR_RUNTIME: "1", CALLOUT_CANONICAL_PATH: "legacy", AGENT_CALLOUT_DISCORD: "0" };
  assert.equal(supervisorDiscordDeliveryEnabled(stageB), false);
  assert.equal(legacyOptionsSuppressed(stageB), false, "legacy options still active in Stage B");
});

// 11. Stage C selects exactly one options callout sender.
test("Stage C: supervisor becomes the sole options sender (legacy stands down)", () => {
  const stageC = { SUPERVISOR_RUNTIME: "1", CALLOUT_CANONICAL_PATH: "supervisor", AGENT_CALLOUT_DISCORD: "1" };
  assert.equal(supervisorDiscordDeliveryEnabled(stageC), true, "supervisor sends");
  assert.equal(legacyOptionsSuppressed(stageC), true, "legacy options suppressed → no double-send");
  assert.equal(calloutCanonicalPath(stageC), "supervisor");
});

// 12. SQLite configuration expects one replica (documented + enforced).
test("one-replica expectation is documented", () => {
  assert.equal(JSON.parse(read("railway.json")).deploy.numReplicas, 1);
  assert.ok(/one replica|single service|PostgreSQL/i.test(read("docs/RAILWAY_DEPLOYMENT.md")));
});

// 13. Repeat startup remains migration safe.
test("SCHEMA is repeat-safe (applied twice, no error)", { skip: !Database }, () => {
  const schema = read("lib/db.ts").match(/const SCHEMA = `([\s\S]*?)`;/)[1];
  const db = new Database(":memory:");
  db.exec(schema);
  db.exec(schema); // must not throw
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('callout_state','worker_leases')").all();
  assert.equal(t.length, 2);
});

// 14. .env.railway.example contains no real credentials.
test(".env.railway.example has placeholders only (no real secrets)", () => {
  const ex = read(".env.railway.example");
  assert.ok(!/discord\.com\/api\/webhooks\/\d{6,}\/[A-Za-z0-9_-]{20,}/.test(ex), "no real discord webhook");
  assert.ok(!/\bsk-[A-Za-z0-9]{20,}\b/.test(ex), "no openai-style key");
  assert.ok(!/\b[a-f0-9]{40,}\b/.test(ex), "no long hex secret");
  assert.ok(/your_polygon_or_massive_key_here|generate_a_random_hex_token/.test(ex), "uses placeholders");
});

// 15. Deployment docs match actual variable parsing.
test("core deployment variables in the example are actually read by the code", () => {
  const codeBlob = ["lib/db.ts","lib/callouts/routing.ts","lib/scheduler.ts","lib/scheduler-policy.ts",
    "lib/supervisor-cycle.ts","lib/auth.ts","lib/polygon-provider.js","lib/notifications.ts","lib/scanner-loop.ts"]
    .map(read).join("\n");
  for (const v of ["ALERT_DB_DIR","POLYGON_API_KEY","SCAN_API_TOKEN","SUPERVISOR_RUNTIME",
    "CALLOUT_CANONICAL_PATH","AGENT_CALLOUT_DISCORD","SUPERVISOR_MAX_TICKERS","SCHEDULER_DISABLED"]) {
    assert.ok(codeBlob.includes(v), `documented var not read by code: ${v}`);
    assert.ok(read(".env.railway.example").includes(v), `var missing from example: ${v}`);
  }
});

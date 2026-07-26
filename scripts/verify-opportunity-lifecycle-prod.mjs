#!/usr/bin/env node
/**
 * End-to-end production verification for Opportunity Case lifecycle.
 *
 * Checks (in order):
 *   1) /api/healthz commit matches EXPECTED_COMMIT (or origin/main tip if provided)
 *   2) healthz.lifecycle.{enabled,schemaReady,active} are true
 *   3) authenticated pipeline-health reports lifecycle.active
 *   4) optional lifecycle_smoke (requires OPTIONS_LIFECYCLE_SMOKE=1 on deploy)
 *
 * Usage:
 *   BASE_URL=https://optiscan-production.up.railway.app \
 *   SCAN_API_TOKEN=... \
 *   EXPECTED_COMMIT=36c8843... \
 *   RUN_LIFECYCLE_SMOKE=1 \
 *   node scripts/verify-opportunity-lifecycle-prod.mjs
 */
const BASE = String(process.env.BASE_URL || "https://optiscan-production.up.railway.app").replace(/\/$/, "");
const TOKEN = String(process.env.SCAN_API_TOKEN || "");
const EXPECTED = String(process.env.EXPECTED_COMMIT || "").trim();
const SYMBOL = String(process.env.SYMBOL || "NVDA").toUpperCase();
const RUN_SMOKE = process.env.RUN_LIFECYCLE_SMOKE !== "0";

const headers = {
  accept: "application/json",
  "content-type": "application/json",
  ...(TOKEN ? { "x-scan-token": TOKEN } : {}),
};

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep */ }
  return { status: res.status, json, text };
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep */ }
  return { status: res.status, json, text };
}

function fail(step, msg, detail) {
  console.error(JSON.stringify({ ok: false, step, error: msg, detail }, null, 2));
  process.exit(1);
}

const report = { ok: false, base: BASE, steps: {} };

const health = await get("/api/healthz");
report.steps.healthz = { status: health.status, body: health.json };
if (health.status !== 200 || !health.json?.ok) fail("healthz", "healthz not ok", health);
if (EXPECTED) {
  const c = String(health.json.commit || "");
  if (!c.startsWith(EXPECTED) && !EXPECTED.startsWith(c.slice(0, 7))) {
    fail("commit", `deployed commit ${c} does not match EXPECTED_COMMIT ${EXPECTED}`, health.json);
  }
}
const hzLife = health.json.lifecycle;
if (!hzLife) fail("healthz.lifecycle", "lifecycle block missing from healthz — old build still deployed", health.json);
if (!hzLife.enabled) fail("flag", "OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED is off in production", hzLife);
if (!hzLife.schemaReady) fail("migration", "lifecycle schema not ready on deployed DB", hzLife);
if (!hzLife.active) fail("lifecycle.active", "lifecycle.active is false on healthz", hzLife);
report.steps.healthzLifecycle = hzLife;

if (!TOKEN) fail("auth", "SCAN_API_TOKEN is required for pipeline-health + smoke");

const pipe = await get(`/api/research/options/pipeline-health?symbol=${encodeURIComponent(SYMBOL)}`);
report.steps.pipelineHealth = { status: pipe.status, lifecycle: pipe.json?.diagnostic?.lifecycle ?? null };
if (pipe.status !== 200 || !pipe.json?.ok) fail("pipeline-health", "pipeline-health not ok", pipe);
const life = pipe.json?.diagnostic?.lifecycle;
if (!life?.enabled || !life?.schemaReady || !life?.active) {
  fail("pipeline-health.lifecycle", "pipeline-health lifecycle not active", life);
}

let lifecycleSmoke = null;
if (RUN_SMOKE) {
  const smoke = await post("/api/research/options", { action: "lifecycle_smoke" });
  lifecycleSmoke = smoke.json?.result ?? smoke.json;
  report.steps.lifecycleSmoke = { status: smoke.status, result: lifecycleSmoke };
  if (smoke.status === 409 || !smoke.json?.ok) {
    fail("lifecycle_smoke", "smoke failed — set OPTIONS_LIFECYCLE_SMOKE=1 on Railway, redeploy, retry", smoke);
  }
  const r = lifecycleSmoke;
  for (const [k, pred] of [
    ["openingSent", (v) => v === true],
    ["duplicateSuppressed", (v) => v === true],
    ["evidenceAttached", (v) => Number(v) >= 1],
    ["milestoneSent", (v) => v === true],
    ["milestoneRepliedToOpening", (v) => v === true],
    ["closed", (v) => v === true],
    ["closeSent", (v) => v === true],
    ["closeRepliedToOpening", (v) => v === true],
  ]) {
    if (!pred(r?.[k])) fail(`smoke.${k}`, `assertion failed for ${k}`, r);
  }
}

report.ok = true;
report.commit = health.json.commit;
report.commitShort = health.json.commitShort;
report.branch = health.json.branch;
report.lifecycle = life;
report.lifecycleSmoke = lifecycleSmoke;
console.log(JSON.stringify(report, null, 2));

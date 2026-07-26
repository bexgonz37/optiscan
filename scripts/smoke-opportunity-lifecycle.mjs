#!/usr/bin/env node
/**
 * Production smoke checks for Opportunity Case lifecycle.
 *
 * Usage:
 *   BASE_URL=https://YOUR-APP.up.railway.app \
 *   SCAN_API_TOKEN=... \
 *   node scripts/smoke-opportunity-lifecycle.mjs
 *
 * For Discord open/suppress/milestone path, the deployed service must have:
 *   OPTIONS_LIFECYCLE_SMOKE=1
 * then this script posts action=lifecycle_smoke.
 *
 * Optional:
 *   SYMBOL=NVDA
 *   RUN_LIFECYCLE_SMOKE=1   (default 1)
 */
const BASE = String(process.env.BASE_URL || "").replace(/\/$/, "");
const TOKEN = String(process.env.SCAN_API_TOKEN || "");
const SYMBOL = String(process.env.SYMBOL || "NVDA").toUpperCase();
const RUN_SMOKE = process.env.RUN_LIFECYCLE_SMOKE !== "0";

if (!BASE) {
  console.error("BASE_URL is required");
  process.exit(2);
}

const headers = {
  accept: "application/json",
  "content-type": "application/json",
  ...(TOKEN ? { "x-scan-token": TOKEN } : {}),
};

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, json, text };
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, json, text };
}

function fail(msg, detail) {
  console.error("FAIL:", msg);
  if (detail) console.error(JSON.stringify(detail, null, 2));
  process.exit(1);
}

const health = await get("/api/healthz");
if (health.status !== 200 || !health.json?.ok) fail("healthz not ok", health);
if (health.json?.lifecycle) {
  if (!health.json.lifecycle.enabled) fail("healthz lifecycle.enabled is not true", health.json.lifecycle);
  if (!health.json.lifecycle.schemaReady) fail("healthz lifecycle.schemaReady is not true — migration missing", health.json.lifecycle);
  if (!health.json.lifecycle.active) fail("healthz lifecycle.active is not true", health.json.lifecycle);
}

const pipe = await get(`/api/research/options/pipeline-health?symbol=${encodeURIComponent(SYMBOL)}`);
if (pipe.status !== 200 || !pipe.json?.ok) fail("pipeline-health not ok", pipe);
const life = pipe.json?.diagnostic?.lifecycle;
if (!life?.enabled) fail("lifecycle.enabled is not true", life);
if (!life?.schemaReady) fail("lifecycle.schemaReady is not true — migration missing on deployed DB", life);
if (!life?.active) fail("lifecycle.active is not true", life);

let lifecycleSmoke = null;
if (RUN_SMOKE) {
  const smoke = await post("/api/research/options", { action: "lifecycle_smoke" });
  lifecycleSmoke = smoke.json?.result ?? smoke.json;
  if (smoke.status === 409 || !smoke.json?.ok) {
    fail("lifecycle_smoke failed — ensure OPTIONS_LIFECYCLE_SMOKE=1 on the deployed service", smoke);
  }
  const r = lifecycleSmoke;
  if (!r?.openingSent) fail("smoke: opening alert not sent", r);
  if (!r?.duplicateSuppressed) fail("smoke: duplicate not suppressed", r);
  if (!(r?.evidenceAttached >= 1)) fail("smoke: evidence not attached", r);
  if (!r?.milestoneSent) fail("smoke: milestone not sent", r);
  if (!r?.milestoneRepliedToOpening) fail("smoke: milestone did not reference original alert", r);
  if (!r?.closed) fail("smoke: opportunity not closed", r);
  if (!r?.closeSent) fail("smoke: closed opportunity Discord not sent", r);
  if (!r?.closeRepliedToOpening) fail("smoke: close Discord did not reference original alert", r);
}

console.log(JSON.stringify({
  ok: true,
  commit: health.json?.commit ?? health.json?.commitShort ?? null,
  branch: health.json?.branch ?? null,
  lifecycle: life,
  lifecycleSmoke,
}, null, 2));

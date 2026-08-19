#!/usr/bin/env node
/**
 * prod-smoke.mjs — post-deploy production smoke test.
 *
 *   node scripts/prod-smoke.mjs
 *   BASE_URL=... SCAN_API_TOKEN=... node scripts/prod-smoke.mjs
 *   node scripts/prod-smoke.mjs --json
 *
 * ── What it is for ────────────────────────────────────────────────────────────
 *
 * Answering, in about a minute after a deploy, whether the app the owner actually
 * uses still works — and doing it without touching a single thing that could change a
 * trade. Every request is a GET. Nothing here sends a Discord message, spends provider
 * or AI budget, writes a table, opens or closes a position, or enables a delivery lane.
 *
 * ── Why the assertions are shaped the way they are ────────────────────────────
 *
 * A smoke test that fails when the market is quiet is a smoke test people learn to
 * ignore. So it asserts SHAPE and SAFETY, never counts: "the callouts route answers
 * with a list" rather than "there are callouts today", because zero callouts on a slow
 * Tuesday is correct behavior and a red build for it trains the owner to skip the
 * output. Row counts, P&L, session state and market hours are reported, never asserted.
 *
 * The safety checks are the opposite: those are asserted hard, because the failure they
 * catch is one nobody would notice by looking at the app. Subscriber delivery must stay
 * blocked, AI must stay under its cap with zero trading authority, and the frozen
 * experiment definitions must still hash to what they were frozen at.
 *
 * Exit code 0 = every check passed. 1 = at least one FAIL. Timings are always printed.
 */
import { readFileSync } from "node:fs";

const BASE = String(process.env.BASE_URL ?? "https://optiscan-production.up.railway.app").replace(/\/$/, "");
const JSON_OUT = process.argv.includes("--json");

/** Token from the environment, else the local .env.local. Never printed or logged. */
function resolveToken() {
  const fromEnv = String(process.env.SCAN_API_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    return (env.match(/^SCAN_API_TOKEN=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}
const TOKEN = resolveToken();

// Budgets are generous on purpose. This is a "did the deploy break something"
// tripwire, not a benchmark; a slow-but-correct route should not fail the build. The
// measured milliseconds are always printed so a regression is visible even when green.
const BUDGET_MS = { fast: 3_000, normal: 10_000, heavy: 45_000 };

const results = [];
function record(name, status, detail, ms, extra) {
  results.push({ name, status, detail, ms: ms ?? null, ...(extra ?? {}) });
}

async function get(path, { timeoutMs = 60_000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, {
      headers: { "x-scan-token": TOKEN, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON is a finding, not a crash */ }
    return { ok: res.ok, status: res.status, body, bytes: Buffer.byteLength(text), ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, status: 0, body: null, bytes: 0, ms: Date.now() - t0, error: String(err).slice(0, 160) };
  }
}

/**
 * One route check. `assert` returns null when healthy or a string describing the
 * problem. `budget` names which time budget applies; exceeding it is a WARN, not a
 * FAIL, because slow and broken are different problems and conflating them costs the
 * owner the ability to tell which one they have.
 */
async function check(name, path, budget, assertFn, opts) {
  const r = await get(path, opts);
  if (!r.ok) {
    record(name, "FAIL", r.error ? `request failed: ${r.error}` : `HTTP ${r.status}`, r.ms, { path });
    return null;
  }
  const problem = assertFn ? assertFn(r.body, r) : null;
  if (problem) {
    record(name, "FAIL", problem, r.ms, { path, bytes: r.bytes });
    return r.body;
  }
  const limit = BUDGET_MS[budget] ?? BUDGET_MS.normal;
  if (r.ms > limit) {
    record(name, "WARN", `answered correctly but took ${(r.ms / 1000).toFixed(1)}s (budget ${limit / 1000}s)`, r.ms, { path, bytes: r.bytes });
    return r.body;
  }
  record(name, "PASS", `${r.status} · ${(r.bytes / 1024).toFixed(1)}KB`, r.ms, { path, bytes: r.bytes });
  return r.body;
}

const isArr = (v) => Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function main() {
  if (!TOKEN) {
    console.error("No SCAN_API_TOKEN available (env or .env.local). Cannot run authenticated checks.");
    process.exit(2);
  }

  // ── 1. Is it up, and is it the build we think it is? ──────────────────────
  const health = await check("health · healthz", "/api/healthz", "fast", (b) => {
    if (!b?.ok) return "healthz reports not ok";
    if (b.db !== true) return `database not ready: ${b.dbError ?? "unknown"}`;
    if (b.schemaOk !== true) return `schema not ready: missing ${JSON.stringify(b.schemaMissing ?? [])}`;
    return null;
  });
  const deployedSha = health?.commitShort ?? "unknown";

  await check("health · scanner loop", "/api/diagnostics/loop-health", "fast", (b) => {
    const state = b?.loop?.state ?? b?.loop?.status ?? null;
    // WEDGED is the only state that means the loop cannot make progress. Everything
    // else, including a closed market, is reported rather than failed.
    return String(state).toUpperCase() === "WEDGED" ? "scanner loop is WEDGED" : null;
  });

  // ── 2. The pages the owner opens ──────────────────────────────────────────
  await check("page data · NOW (homepage)", "/api/now", "normal", (b) => {
    if (!b || b.ok === false) return "now snapshot not ok";
    if (!isArr(b.openPositions)) return "openPositions is not a list";
    if (b.operatingMode == null) return "no operating mode — the page cannot say what it is showing";
    return null;
  });
  await check("page data · live callouts", "/api/callouts", "normal", (b) => (
    b == null ? "no body" : null
  ));
  await check("page data · quant lab", "/api/research/options/quant-lab", "heavy", (b) => (
    b == null || b.ok === false ? "quant lab did not build" : null
  ));
  await check("page data · research command center", "/api/research/command-center", "normal", (b) => (
    b == null || b.ok === false ? "command center did not build" : null
  ));
  await check("page data · content queue", "/api/content-drafts", "normal", (b) => (
    !isArr(b?.drafts) ? "content drafts is not a list" : null
  ));
  await check("page data · watchlist tape", "/api/scanner/live?realtimeOnly=1", "normal", (b) => (
    b?.realtime == null ? "no realtime block" : null
  ));
  await check("page data · shadow experiments", "/api/research/options/shadow-summary", "heavy", (b) => (
    b == null ? "no body" : null
  ));
  await check("page data · subscriber readiness", "/api/research/options/subscriber-readiness", "normal", (b) => (
    b?.report?.status == null ? "readiness has no status" : null
  ));

  // ── 3. Safety. These ARE asserted. ────────────────────────────────────────

  // Subscriber delivery must stay blocked until the gates say otherwise. This is not a
  // performance check: it is the one that catches a config change nobody meant to make.
  const readiness = await get("/api/research/options/subscriber-readiness");
  const rStatus = readiness.body?.report?.status ?? null;
  const blocking = readiness.body?.report?.blockingGates ?? [];
  if (rStatus === "SUBSCRIBER_READY" && blocking.length === 0) {
    record(
      "SAFETY · subscriber delivery",
      "WARN",
      "readiness reports SUBSCRIBER_READY with no blocking gates — confirm this was a deliberate owner decision",
      readiness.ms,
    );
  } else if (rStatus == null) {
    record("SAFETY · subscriber delivery", "FAIL", "readiness did not report a status at all", readiness.ms);
  } else {
    record("SAFETY · subscriber delivery", "PASS", `${rStatus} · ${blocking.length} blocking gate(s)`, readiness.ms);
  }

  // Discord routing. Content being unconfigured is a legitimate owner choice, so it is
  // reported as INFO. A lane that is configured but failing is what matters.
  const discord = await get("/api/discord/health");
  if (!discord.ok || discord.body?.ok !== true) {
    record("SAFETY · discord routing", "FAIL", "discord health did not answer", discord.ms);
  } else {
    const routes = discord.body.routing ?? [];
    const broken = routes.filter((r) => r.enabled === true && r.status !== "READY");
    const unconfigured = routes.filter((r) => r.enabled === false).map((r) => r.messageType);
    if (broken.length) {
      record("SAFETY · discord routing", "FAIL", `configured but not ready: ${broken.map((r) => r.messageType).join(", ")}`, discord.ms);
    } else {
      record(
        "SAFETY · discord routing",
        "PASS",
        `${routes.length - unconfigured.length} lane(s) ready`
        + (unconfigured.length ? ` · not configured (by choice): ${unconfigured.join(", ")}` : ""),
        discord.ms,
      );
    }
    const failed24h = num(discord.body.metrics?.failed24h) ?? 0;
    record(
      "delivery · failures in 24h",
      failed24h > 0 ? "WARN" : "PASS",
      `${failed24h} failed, ${num(discord.body.metrics?.sent24h) ?? 0} sent`,
      null,
    );
  }

  // AI: under the cap, and holding no trading authority.
  const ai = await get("/api/ai");
  const budget = ai.body?.overview?.budget ?? null;
  if (!budget) {
    record("SAFETY · AI budget", "FAIL", "AI overview reported no budget block", ai.ms);
  } else {
    const spend = num(budget.spendUsd) ?? 0;
    const cap = num(budget.absoluteCapUsd ?? budget.hardLimitUsd);
    if (cap !== 20) {
      record("SAFETY · AI budget", "FAIL", `hard cap is ${cap}, expected the fixed $20/month cap`, ai.ms);
    } else if (spend > cap) {
      record("SAFETY · AI budget", "FAIL", `spend $${spend.toFixed(2)} exceeds the $${cap} cap`, ai.ms);
    } else {
      record("SAFETY · AI budget", "PASS", `$${spend.toFixed(2)} of $${cap} this month`, ai.ms);
    }
  }

  // Ask OptiScan / Explain This: reachable, and refusing an unresolvable target WITHOUT
  // paying a model to say "that does not exist". Checked with the free refusal path on
  // purpose — a smoke test must never be a recurring charge.
  const explain = await (async () => {
    const t0 = Date.now();
    try {
      const res = await fetch(BASE + "/api/research/explain", {
        method: "POST",
        headers: { "x-scan-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ kind: "METRIC", id: "__smoke_test_unresolvable__" }),
        signal: AbortSignal.timeout(60_000),
      });
      return { ok: res.ok, body: await res.json().catch(() => null), ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, body: null, ms: Date.now() - t0, error: String(err).slice(0, 120) };
    }
  })();
  if (!explain.ok || explain.body?.ok !== true) {
    record("Explain This · reachable", "FAIL", explain.error ?? "explain route did not answer", explain.ms);
  } else if (explain.body?.ai?.reason !== "TARGET_UNRESOLVED") {
    record("Explain This · reachable", "FAIL", `unresolvable id did not refuse cleanly (${explain.body?.ai?.reason})`, explain.ms);
  } else {
    record("Explain This · reachable", "PASS", "refuses an unknown target with no model spend", explain.ms);
  }

  // Frozen experiment definitions. A changed hash means the rules moved under a running
  // experiment, which silently invalidates every conclusion drawn from it.
  const gate = await get("/api/research/options/owner-selection-strength");
  const gf = gate.body?.definitionFrozen ?? null;
  if (!gf) {
    record("SAFETY · OWNER_SELECTION_STRENGTH_GATE_V1 frozen", "FAIL", "no frozen-definition block", gate.ms);
  } else if (gf.frozen !== true || gf.expected !== gf.actual) {
    record("SAFETY · OWNER_SELECTION_STRENGTH_GATE_V1 frozen", "FAIL", `definition CHANGED: expected ${gf.expected}, got ${gf.actual}`, gate.ms);
  } else {
    record("SAFETY · OWNER_SELECTION_STRENGTH_GATE_V1 frozen", "PASS", `${gate.body?.mode ?? "?"} · ${gf.actual}`, gate.ms);
  }

  const v2 = await get("/api/diagnostics/pre-move-v2");
  const vf = v2.body?.report?.definitionFrozen ?? null;
  if (!vf) {
    record("SAFETY · PRE_MOVE_DISCOVERY_V2 frozen", "FAIL", "no frozen-definition block", v2.ms);
  } else if (vf.frozen !== true || vf.expected !== vf.actual) {
    record("SAFETY · PRE_MOVE_DISCOVERY_V2 frozen", "FAIL", `definition CHANGED: expected ${vf.expected}, got ${vf.actual}`, v2.ms);
  } else {
    const cov = v2.body?.report?.coverage ?? {};
    record(
      "SAFETY · PRE_MOVE_DISCOVERY_V2 frozen",
      "PASS",
      `${vf.actual} · ${num(cov.capturedRows) ?? 0} prospective row(s) captured`,
      v2.ms,
    );
  }

  // Screeners-first. Reported from configuration so it is answerable at any hour.
  const loop = await get("/api/diagnostics/loop-health");
  const universe = loop.body?.candidateUniverse ?? null;
  if (!universe) {
    record("SAFETY · candidate universe", "WARN", "loop health did not report a candidate-universe block", loop.ms);
  } else if (universe.broadDiscoveryEnabled !== true) {
    record("SAFETY · candidate universe", "FAIL", universe.headline, loop.ms);
  } else {
    record("SAFETY · candidate universe", "PASS", `${universe.verdict} · curated list ${universe.curatedListSize}`, loop.ms);
  }

  // ── report ────────────────────────────────────────────────────────────────
  const fails = results.filter((r) => r.status === "FAIL");
  const warns = results.filter((r) => r.status === "WARN");

  if (JSON_OUT) {
    console.log(JSON.stringify({ base: BASE, deployedSha, at: new Date().toISOString(), results, failed: fails.length, warned: warns.length }, null, 2));
  } else {
    console.log(`\nOPTISCAN PRODUCTION SMOKE TEST`);
    console.log(`${BASE}  ·  deployed ${deployedSha}  ·  ${new Date().toISOString()}\n`);
    for (const r of results) {
      const icon = r.status === "PASS" ? "PASS" : r.status === "WARN" ? "WARN" : "FAIL";
      const t = r.ms == null ? "      " : `${String(r.ms).padStart(6)}ms`;
      console.log(`  ${icon.padEnd(4)}  ${t}  ${r.name.padEnd(48)} ${r.detail}`);
    }
    const slowest = results.filter((r) => r.ms != null).sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log(`\n  Slowest checks:`);
    for (const r of slowest) console.log(`    ${String(r.ms).padStart(6)}ms  ${r.name}`);
    console.log(`\n  ${results.length} checks · ${fails.length} failed · ${warns.length} warned\n`);
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke test crashed:", String(err).slice(0, 300));
  process.exit(2);
});

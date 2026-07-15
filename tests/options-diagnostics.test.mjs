import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeOptionsDiagnostics, optionsDiagnosticsForDay } from "../lib/options-diagnostics.ts";
import { optionsDeliveryGateReason } from "../lib/callouts/routing.ts";
import { buildNightlySummary } from "../lib/ai/nightly-summary.ts";
import { deployInfo } from "../lib/build-info.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }

// One options_diagnostics row with sane defaults; override the fields a case needs.
function row(over = {}) {
  return {
    id: 1, cycleAtMs: 1_700_000_000_000, tradingDay: "2026-07-15", session: "regular",
    tickersConsidered: 12, chainsOk: 12, chainsFailed: 0, tickersWithCanonical: 0, canonical: 0,
    portfolioSuppressed: 0, dedupSuppressed: 0, emitted: 0, delivered: 0,
    notActionableNow: 0, contractIncomplete: 0, contractMismatch: 0,
    discordAutoSend: false, deliveryGateReason: null, topReason: null, durationMs: 800,
    strategyVersion: "supervisor-options-v1", createdAtMs: 1_700_000_000_000,
    ...over,
  };
}

// ── summarizeOptionsDiagnostics (PURE) ────────────────────────────────────────
test("empty funnel → zeros and a null diagnosis (never fabricated)", () => {
  const s = summarizeOptionsDiagnostics([]);
  assert.equal(s.cycles, 0);
  assert.equal(s.emitted, 0);
  assert.equal(s.delivered, 0);
  assert.equal(s.configBlockedCycles, 0);
  assert.equal(s.diagnosis, null);
  assert.equal(s.topDeliveryGateReason, null);
});

test("emitted-but-undelivered with auto-send OFF ⇒ config-blocked diagnosis (the 'no alerts' cause)", () => {
  const rows = [
    row({ tickersWithCanonical: 3, canonical: 3, emitted: 2, delivered: 0, discordAutoSend: false, deliveryGateReason: "AGENT_CALLOUT_DISCORD != 1 (supervisor Discord master switch is off)" }),
    row({ tickersWithCanonical: 2, canonical: 2, emitted: 1, delivered: 0, discordAutoSend: false, deliveryGateReason: "AGENT_CALLOUT_DISCORD != 1 (supervisor Discord master switch is off)" }),
  ];
  const s = summarizeOptionsDiagnostics(rows);
  assert.equal(s.emitted, 3);
  assert.equal(s.delivered, 0);
  assert.equal(s.emittedButUndelivered, 3);
  assert.equal(s.configBlockedCycles, 2);
  assert.match(s.topDeliveryGateReason, /AGENT_CALLOUT_DISCORD/);
  assert.match(s.diagnosis, /disabled by config/i);
});

test("chains fetched but no canonical ⇒ agent/selector-stage diagnosis", () => {
  const rows = [row({ chainsOk: 12, tickersWithCanonical: 0, canonical: 0, emitted: 0, delivered: 0 })];
  const s = summarizeOptionsDiagnostics(rows);
  assert.equal(s.canonical, 0);
  assert.equal(s.gateRejections.agentStageNoCanonical, 12);
  assert.match(s.diagnosis, /agent\/selector\/entry-window/i);
});

test("delivered callouts ⇒ no config-blocked count", () => {
  const rows = [row({ tickersWithCanonical: 2, canonical: 2, emitted: 2, delivered: 2, discordAutoSend: true })];
  const s = summarizeOptionsDiagnostics(rows);
  assert.equal(s.delivered, 2);
  assert.equal(s.configBlockedCycles, 0);
  assert.equal(s.emittedButUndelivered, 0);
});

// ── optionsDeliveryGateReason (PURE) ──────────────────────────────────────────
test("gate reason is null only when supervisor path + master switch + webhook are all on", () => {
  assert.equal(optionsDeliveryGateReason({ CALLOUT_CANONICAL_PATH: "supervisor", AGENT_CALLOUT_DISCORD: "1" }, true), null);
});
test("legacy canonical path is the first-reported blocker", () => {
  assert.match(optionsDeliveryGateReason({ CALLOUT_CANONICAL_PATH: "legacy", AGENT_CALLOUT_DISCORD: "1" }, true), /CALLOUT_CANONICAL_PATH != supervisor/);
});
test("master switch off is reported when path is supervisor", () => {
  assert.match(optionsDeliveryGateReason({ CALLOUT_CANONICAL_PATH: "supervisor", AGENT_CALLOUT_DISCORD: "0" }, true), /AGENT_CALLOUT_DISCORD != 1/);
});
test("missing webhook is reported once path + switch are on", () => {
  assert.match(optionsDeliveryGateReason({ CALLOUT_CANONICAL_PATH: "supervisor", AGENT_CALLOUT_DISCORD: "1" }, false), /DISCORD_WEBHOOK_OPTIONS/);
});

// ── nightly integration ───────────────────────────────────────────────────────
function nightlyInput(over = {}) {
  return { tradingDay: "2026-07-15", periodStartMs: null, periodEndMs: 1_700_000_000_000, outcomes: [], candidates: [], live: null, momentum: null, options: null, ...over };
}

test("options config-blocked outranks every downstream issue in the nightly summary", () => {
  const options = { cycles: 2, setupsQualified: 5, chainsFetched: 24, canonical: 5, emitted: 3, delivered: 0, emittedButUndelivered: 3, configBlockedCycles: 2, topDeliveryGateReason: "AGENT_CALLOUT_DISCORD != 1", diagnosis: "3 options callout(s) became emittable but NONE were delivered." };
  const s = buildNightlySummary(nightlyInput({ options }));
  assert.equal(s.prioritizedIssue, "options_delivery_disabled");
  assert.ok(s.options && s.options.configBlockedCycles === 2);
  assert.ok(s.patterns.some((p) => /DISABLED by config/i.test(p)));
});

test("momentum digest surfaces near-miss + rescue patterns", () => {
  const momentum = { total: 6, sent: 0, rescued: 1, nearMisses: 4, rejected: 1, extendedRejections: 2, staleRejected: 1, avgLatencyMs: 1200 };
  const s = buildNightlySummary(nightlyInput({ momentum }));
  assert.ok(s.momentum && s.momentum.nearMisses === 4);
  assert.ok(s.patterns.some((p) => /rescued by the crossing latch/i.test(p)));
  assert.ok(s.patterns.some((p) => /near-miss/i.test(p)));
  assert.equal(s.prioritizedIssue, "momentum_misses"); // sent==0 && nearMisses>=3
});

test("no diagnostics ⇒ explicit data-gap notes (never silent)", () => {
  const s = buildNightlySummary(nightlyInput());
  assert.ok(s.dataGaps.some((g) => /no options-funnel diagnostics/i.test(g)));
  assert.ok(s.dataGaps.some((g) => /no momentum-stock diagnostics/i.test(g)));
});

// ── persistence round-trip (real better-sqlite3 against the real SCHEMA) ───────
test("options_diagnostics round-trips through the real schema", { skip: !Database }, () => {
  const schema = read("lib/db.ts").match(/const SCHEMA = `([\s\S]*?)`;/)[1];
  const db = new Database(":memory:");
  db.exec(schema);
  db.exec(schema); // idempotent
  db.prepare(
    `INSERT INTO options_diagnostics
     (cycle_at_ms, trading_day, session, tickers_considered, chains_ok, chains_failed,
      tickers_with_canonical, canonical, portfolio_suppressed, dedup_suppressed,
      emitted, delivered, not_actionable_now, contract_incomplete, contract_mismatch,
      discord_auto_send, delivery_gate_reason, top_reason, duration_ms, strategy_version, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(1_700_000_000_000, "2026-07-15", "regular", 12, 12, 0, 3, 3, 0, 0, 2, 0, 0, 0, 0, 0,
    "AGENT_CALLOUT_DISCORD != 1", "delivery blocked by config", 800, "supervisor-options-v1", 1_700_000_000_000);

  const rows = optionsDiagnosticsForDay("2026-07-15", db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].emitted, 2);
  assert.equal(rows[0].discordAutoSend, false);
  const s = summarizeOptionsDiagnostics(rows);
  assert.equal(s.configBlockedCycles, 1);
  assert.match(s.diagnosis, /disabled by config/i);
  assert.equal(optionsDiagnosticsForDay("2026-07-14", db).length, 0); // day filter works
  db.close();
});

// ── deployed-commit exposure (build-info) ─────────────────────────────────────
test("deployInfo maps Railway env to a short commit; empty env ⇒ nulls", () => {
  const d = deployInfo({ RAILWAY_GIT_COMMIT_SHA: "abc123def456789", RAILWAY_GIT_BRANCH: "main" });
  assert.equal(d.commit, "abc123def456789");
  assert.equal(d.commitShort, "abc123d");
  assert.equal(d.branch, "main");
  const empty = deployInfo({});
  assert.equal(empty.commit, null);
  assert.equal(empty.commitShort, null);
  assert.equal(empty.branch, null);
});

// ── scanning model: bulk snapshot, not sequential per-symbol fetch ─────────────
test("scanner evaluates ONE bulk snapshot per tick (not sequential per-symbol quote fetches)", () => {
  const code = read("lib/scanner-loop.ts");
  assert.ok(/fetchBulkQuotes\(realtimeUniverse\(/.test(code), "one bulk snapshot over the realtime universe");
  // The per-symbol eval loop iterates the snapshot result in memory — it must not
  // issue a quote fetch per symbol inside the loop.
  assert.ok(/for \(const q of quotes\)/.test(code), "in-memory per-symbol eval over the snapshot");
  assert.ok(!/for \(const q of quotes\)[\s\S]{0,4000}await fetchBulkQuotes/.test(code), "no bulk refetch inside the symbol loop");
});

test("freshly-promoted ring seeding is bounded and env-tunable (early-detection knob)", () => {
  const code = read("lib/scanner-loop.ts");
  assert.ok(/SCANNER_SEED_TOP_N/.test(code), "seed count is env-tunable");
  assert.ok(/Math\.min\(12,\s*Number\(process\.env\.SCANNER_SEED_TOP_N\s*\?\?\s*6\)\)/.test(code), "bounded, default 6");
});

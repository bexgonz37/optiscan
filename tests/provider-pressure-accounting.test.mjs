/**
 * tests/provider-pressure-accounting.test.mjs
 *
 * "49 provider quota losses" and "~780" were both true and neither said its unit.
 * 49 was refusals in a 15-MINUTE ROLLING WINDOW, 780 was refusals across the FULL
 * SESSION, and 617 was the DISTINCT SYMBOLS behind those 780. Retry inflation is only
 * 1.26x, so re-evaluation never explained the gap — the time range did.
 *
 * Pinned here: attempts, distinct symbols, retry ratio and the window are reported
 * together, so no unit can be quoted as another.
 *
 * These are read-only measurements. Nothing in this file raises a cap, changes a retry
 * cadence, or alters provider allocation.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  ensureContractFunnelSchema,
  providerPressureAccountingOnDb,
} from "../lib/research/options/contract-funnel-store.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const DAY = "2026-08-07";
const BASE = Date.parse(`${DAY}T13:30:00.000Z`);

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  ensureContractFunnelSchema(d);
  return d;
}

/** One contract-selection attempt that ended in `reason`. */
function attempt(d, { symbol, reason, atMs }) {
  d.prepare(
    `INSERT INTO contract_funnel_evidence
      (session_date, at_ms, symbol, requested_side, strategy_key,
       discovery_version, selection_version, terminal_reason)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(DAY, atMs, symbol, "call", "momentum_acceleration", "v1", "v1", reason);
}

test("attempts and distinct symbols are reported as different units", () => {
  const d = db();
  // One symbol refused five times, another refused once: 6 attempts, 2 symbols.
  for (let i = 0; i < 5; i++) attempt(d, { symbol: "SPY", reason: "PROVIDER_QUOTA_EXCEEDED", atMs: BASE + i * 60_000 });
  attempt(d, { symbol: "QQQ", reason: "PROVIDER_QUOTA_EXCEEDED", atMs: BASE });

  const a = providerPressureAccountingOnDb(d, DAY);
  const quota = a.byReason.find((r) => r.reason === "PROVIDER_QUOTA_EXCEEDED");
  assert.equal(quota.attempts, 6);
  assert.equal(quota.distinctSymbols, 2);
  assert.equal(quota.retryRatio, 3);
  assert.equal(a.totals.quotaAttempts, 6);
  assert.equal(a.totals.quotaDistinctSymbols, 2);
  assert.match(a.semantics.warning, /DIFFERENT UNITS/);
});

test("THE RECONCILIATION: retry inflation does not explain the 49-vs-780 gap", () => {
  const d = db();
  // The real shape: 780 attempts over 617 distinct symbols across a full session.
  let n = 0;
  for (let s = 0; s < 617; s++) {
    const repeats = s < 163 ? 2 : 1; // 163*2 + 454 = 780
    for (let r = 0; r < repeats; r++) {
      attempt(d, { symbol: `SYM${s}`, reason: "PROVIDER_QUOTA_EXCEEDED", atMs: BASE + (n++) * 30_000 });
    }
  }

  const session = providerPressureAccountingOnDb(d, DAY);
  const quota = session.byReason.find((r) => r.reason === "PROVIDER_QUOTA_EXCEEDED");
  assert.equal(quota.attempts, 780);
  assert.equal(quota.distinctSymbols, 617);
  assert.ok(
    quota.retryRatio < 1.3,
    `retry inflation is only ${quota.retryRatio}x — far too small to turn 49 into 780`,
  );
  assert.equal(session.window.unit, "FULL_SESSION");
});

test("a rolling window is labelled as one and never as a session total", () => {
  const d = db();
  for (let i = 0; i < 40; i++) attempt(d, { symbol: `S${i}`, reason: "PROVIDER_QUOTA_EXCEEDED", atMs: BASE + i * 60_000 });
  // Later attempts, outside a 15-minute window ending at the last one.
  const lastMs = BASE + 39 * 60_000;
  const windowMs = 15 * 60_000;

  const rolling = providerPressureAccountingOnDb(d, DAY, { sinceMs: lastMs - windowMs, windowMs });
  const session = providerPressureAccountingOnDb(d, DAY);

  assert.equal(rolling.window.unit, "ROLLING_WINDOW");
  assert.equal(rolling.window.windowMs, windowMs);
  assert.equal(session.window.unit, "FULL_SESSION");
  assert.ok(
    rolling.totals.quotaAttempts < session.totals.quotaAttempts,
    "the window must be a strict subset — this is the whole 49-vs-780 story",
  );
});

test("nothing refused reports a null ratio, never 1", () => {
  const d = db();
  attempt(d, { symbol: "SPY", reason: "CONTRACT_SELECTED", atMs: BASE });
  const a = providerPressureAccountingOnDb(d, DAY);
  assert.equal(a.totals.quotaAttempts, 0);
  assert.equal(a.totals.quotaDistinctSymbols, 0);
  assert.equal(a.byReason.find((r) => r.reason === "PROVIDER_QUOTA_EXCEEDED"), undefined);
});

test("every reason carries both units, not just the refusals", () => {
  const d = db();
  attempt(d, { symbol: "SPY", reason: "CONTRACT_SELECTED", atMs: BASE });
  attempt(d, { symbol: "SPY", reason: "CONTRACT_SELECTED", atMs: BASE + 1000 });
  attempt(d, { symbol: "QQQ", reason: "NO_CONTRACTS_RETURNED", atMs: BASE });

  const a = providerPressureAccountingOnDb(d, DAY);
  for (const r of a.byReason) {
    assert.ok(Number.isFinite(r.attempts), `${r.reason} must report attempts`);
    assert.ok(Number.isFinite(r.distinctSymbols), `${r.reason} must report distinct symbols`);
  }
  const selected = a.byReason.find((r) => r.reason === "CONTRACT_SELECTED");
  assert.equal(selected.attempts, 2);
  assert.equal(selected.distinctSymbols, 1, "two attempts on one symbol is one symbol");
});

test("an absent funnel table reports empty totals rather than throwing", () => {
  const d = new Database(":memory:");
  const a = providerPressureAccountingOnDb(d, DAY);
  assert.equal(a.totals.attempts, 0);
  assert.deepEqual(a.byReason, []);
});

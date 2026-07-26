import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateEntryQuality, entryQualityFromDelivery } from "../lib/entry-quality-gate.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const forensic = JSON.parse(readFileSync(join(root, "scripts/tmp-forensic-week-audit-output.json"), "utf8"));

const enforceEnv = { ENTRY_QUALITY_GATE: "enforce", OPTIONS_0DTE_DELIVERY_CUTOFF_MINUTES: "60" };

test("PUT subscriber action is SHADOW_ONLY", () => {
  const mon = Date.parse("2026-07-20T14:00:00-04:00");
  const r = evaluateEntryQuality(
    { side: "put", dte: 1, nowMs: mon, underlyingNow: 100, optionNow: 1.5, minutesToSessionClose: 300, quoteAgeMs: 500, spreadPct: 4 },
    enforceEnv,
  );
  assert.equal(r.subscriberAction, "SHADOW_ONLY");
});

test("stale quote blocks with QUOTE_STALE", () => {
  const r = evaluateEntryQuality(
    {
      side: "call",
      dte: 0,
      nowMs: Date.now(),
      underlyingNow: 100,
      optionNow: 2,
      quoteAgeMs: 60_000,
    },
    enforceEnv,
  );
  assert.equal(r.verdict, "QUOTE_STALE");
  assert.equal(r.subscriberAction, "BLOCK");
});

test("wide spread blocks with SPREAD_TOO_WIDE", () => {
  const r = evaluateEntryQuality(
    {
      side: "call",
      dte: 1,
      nowMs: Date.now(),
      underlyingNow: 100,
      optionNow: 2,
      spreadPct: 25,
      quoteAgeMs: 1000,
    },
    enforceEnv,
  );
  assert.equal(r.verdict, "SPREAD_TOO_WIDE");
});

test("0DTE late session blocks with SESSION_TOO_LATE", () => {
  const closeMs = Date.parse("2026-07-24T16:00:00-04:00");
  const lateMs = closeMs - 30 * 60_000;
  const r = evaluateEntryQuality(
    {
      side: "call",
      dte: 0,
      nowMs: lateMs,
      underlyingNow: 100,
      optionNow: 2,
      quoteAgeMs: 1000,
      spreadPct: 5,
      minutesToSessionClose: 30,
    },
    enforceEnv,
  );
  assert.equal(r.verdict, "SESSION_TOO_LATE");
});

test("forensic chased NVDA Mon sample is blocked under enforce", () => {
  const chased = forensic.alerts.find((a) => a.symbol === "NVDA" && a.earliness_class === "Chased");
  if (!chased) return;
  const nowMs = Date.parse(chased.sent_at_utc);
  const r = evaluateEntryQuality(
    {
      side: "call",
      dte: 0,
      nowMs,
      underlyingNow: chased.underlying_at_delivery,
      optionNow: chased.frozen_option_entry,
      underlyingMove60m: chased.pre_move_underlying_60m_pct,
      optionMove30m: chased.pre_move_option_30m_pct,
      quoteAgeMs: 1000,
      spreadPct: 5,
      minutesToSessionClose: 360,
    },
    enforceEnv,
  );
  assert.equal(r.dimensions.entryEarliness.verdict, "FAIL");
  assert.notEqual(r.composite.primaryVerdict, "ALLOW");
});

test("entryQualityFromDelivery maps delivery fields", () => {
  const input = entryQualityFromDelivery(
    {
      side: "call",
      dte: 0,
      underlyingNow: 100,
      optionNow: 2,
      observedUnderlyingPrice: 99,
      contract: { spreadPct: 4, quoteAgeMs: 500 },
      entry: { mid: 2, t1: 110, t2: 115, stop: 95, methodology: "test" },
      firstDetectedAtMs: Date.now() - 60_000,
      underlyingAtFirstDetection: 99,
      optionAtFirstDetection: 1.8,
      featureSnapshot: { underlying: { vwapDistPct: 0.1, aboveVwap: true } },
    },
    Date.now(),
    enforceEnv,
  );
  assert.equal(input.side, "call");
  assert.equal(input.aboveVwap, true);
  assert.ok(evaluateEntryQuality(input, enforceEnv).dimensions);
});

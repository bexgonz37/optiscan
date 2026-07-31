/**
 * tests/high-asymmetry-live-intake.test.mjs — the radar's admission contract.
 *
 * The central property: the radar must admit EARLIER and with FEWER hard gates
 * than the subscriber pipeline, because its job is to observe a contract before
 * premium expands. Incomplete evidence must be LABELLED, not rejected — but
 * evidence that cannot be trusted must still be blocked outright.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideLiveIntake,
  computeLeadTime,
  MAX_SPREAD_PCT,
} from "../lib/research/asymmetry/live-intake.ts";

// 10:00 ET on a regular session.
const OBSERVED = Date.parse("2026-07-30T14:00:00.000Z");
const OCC = "O:NVDA260807C00200000";

const input = (over = {}) => ({
  symbol: "NVDA", direction: "CALL",
  optionSymbol: OCC, underlying: "NVDA", expiration: "2026-08-07", strike: 200, right: "C",
  observedAtMs: OBSERVED, sessionDate: "2026-07-30", fingerprint: "fp_1",
  bid: 2.00, ask: 2.10, quoteAtMs: OBSERVED - 1000, quoteAgeMs: 1000,
  optionVolume: 500, openInterest: 4000,
  impliedVolatility: 0.42, delta: 0.35, gamma: 0.02,
  underlyingPrice: 198.5, vwap: 197.0, stockVolume: 1_000_000,
  relativeVolume: 1.8, volumeAcceleration: 1.2, priorMovePct: 1.1,
  compressionState: "COMPRESSED", distanceToTriggerPct: 0.7, roomToNextLevelPct: 2.4,
  marketAlignment: "ALIGNED", sectorAlignment: "ALIGNED",
  catalyst: { label: "Confirmed product launch", source: "company release" },
  setupFamily: "breakout_continuation", scannerVersion: "test",
  hasActiveCase: false, invalidated: false, nowMs: OBSERVED + 5000,
  ...over,
});

// ── Fewer hard gates than the subscriber pipeline ───────────────────────────

test("a fully-evidenced candidate is admitted with no labels", () => {
  const d = decideLiveIntake(input());
  assert.equal(d.admitted, true);
  assert.deepEqual(d.blockedBy, []);
  assert.deepEqual(d.labels, []);
  assert.equal(d.optionSymbol, OCC);
  assert.equal(d.subscriberSendCreated, false);
});

test("missing optional evidence is LABELLED, never blocking", () => {
  // Everything optional stripped at once — the subscriber pipeline would reject
  // most of this; the radar must still admit and record what was absent.
  const d = decideLiveIntake(input({
    impliedVolatility: null, delta: null, gamma: null,
    relativeVolume: null, volumeAcceleration: null, priorMovePct: null,
    compressionState: null, distanceToTriggerPct: null, roomToNextLevelPct: null,
    marketAlignment: null, sectorAlignment: null, catalyst: null,
    underlyingPrice: null, vwap: null,
  }));
  assert.equal(d.admitted, true, "incomplete evidence must not block an early observation");
  assert.deepEqual(d.blockedBy, []);
  for (const label of [
    "NO_CATALYST", "NO_MARKET_ALIGNMENT", "NO_SECTOR_ALIGNMENT", "NO_IMPLIED_VOLATILITY",
    "NO_GREEKS", "NO_RELATIVE_VOLUME", "NO_VOLUME_ACCELERATION", "NO_COMPRESSION_STATE",
    "NO_LEVEL_DISTANCE", "NO_PRIOR_MOVE", "NO_VWAP_RELATIONSHIP",
  ]) assert.ok(d.labels.includes(label), `absence of ${label} must be recorded`);
});

test("an unsourced catalyst is labelled absent, not accepted as a catalyst", () => {
  const named = decideLiveIntake(input({ catalyst: { label: "Rumoured buyout", source: "" } }));
  assert.ok(named.labels.includes("NO_CATALYST"), "a catalyst with no source is not a catalyst");
  assert.equal(named.admitted, true, "but it still does not block the observation");
});

// ── Hard blockers ───────────────────────────────────────────────────────────

test("an unidentifiable contract is blocked", () => {
  assert.ok(decideLiveIntake(input({ optionSymbol: null })).blockedBy.includes("NO_EXACT_OCC"));
  assert.ok(decideLiveIntake(input({ optionSymbol: "   " })).blockedBy.includes("NO_EXACT_OCC"));
  // OCC that disagrees with the separately supplied identity
  const mismatch = decideLiveIntake(input({ strike: 205 }));
  assert.ok(mismatch.blockedBy.includes("CONTRACT_IDENTITY_MISMATCH"));
  assert.equal(mismatch.admitted, false);
  assert.equal(mismatch.optionSymbol, null, "an unverified identity is not echoed back");
});

test("future, stale, and wrong-session evidence is blocked", () => {
  const future = decideLiveIntake(input({ quoteAtMs: OBSERVED + 60_000 }));
  assert.ok(future.blockedBy.includes("EVIDENCE_FROM_FUTURE"), "a quote from the future is never usable");

  const stale = decideLiveIntake(input({ quoteAtMs: OBSERVED - 10 * 60_000 }));
  assert.ok(stale.blockedBy.includes("STALE_QUOTE"));

  // 03:00 ET — outside the options session entirely.
  const offSession = Date.parse("2026-07-30T07:00:00.000Z");
  const wrong = decideLiveIntake(input({ observedAtMs: offSession, quoteAtMs: offSession - 1000, nowMs: offSession + 1000 }));
  assert.ok(wrong.blockedBy.some((b) => b === "WRONG_SESSION" || b === "NO_EXECUTABLE_QUOTE"));
});

test("a missing or crossed quote is blocked", () => {
  assert.ok(decideLiveIntake(input({ bid: null, ask: null })).blockedBy.includes("NO_EXECUTABLE_QUOTE"));
  assert.ok(decideLiveIntake(input({ bid: 3.0, ask: 2.0 })).blockedBy.includes("NO_EXECUTABLE_QUOTE"), "ask below bid is not executable");
});

test("an unusable spread or zero open interest is blocked", () => {
  const wide = decideLiveIntake(input({ bid: 1.0, ask: 3.0 })); // 100% of mid
  assert.ok(wide.spreadPct > MAX_SPREAD_PCT);
  assert.ok(wide.blockedBy.includes("UNUSABLE_SPREAD"));
  assert.ok(decideLiveIntake(input({ openInterest: 0 })).blockedBy.includes("UNUSABLE_LIQUIDITY"));
});

test("a duplicate active case and an explicit invalidation are blocked", () => {
  assert.ok(decideLiveIntake(input({ hasActiveCase: true })).blockedBy.includes("DUPLICATE_ACTIVE_CASE"));
  assert.ok(decideLiveIntake(input({ invalidated: true })).blockedBy.includes("EXPLICITLY_INVALIDATED"));
});

// ── Missing never becomes zero ──────────────────────────────────────────────

test("undefined derived values stay null and are never zero", () => {
  const d = decideLiveIntake(input({ openInterest: null, optionVolume: null, underlyingPrice: null, vwap: null }));
  assert.equal(d.volumeOiRatio, null, "an undefined ratio is null, not 0");
  assert.equal(d.vwapRelationship, null);
  assert.ok(d.labels.includes("NO_OPEN_INTEREST"));
  assert.ok(d.labels.includes("NO_OPTION_VOLUME"));

  // A real zero open interest is a real fact and must NOT read as missing.
  const zeroOi = decideLiveIntake(input({ openInterest: 0 }));
  assert.equal(zeroOi.labels.includes("NO_OPEN_INTEREST"), false, "an observed 0 is data, not absence");
});

test("derived values are computed only from an executable quote", () => {
  const good = decideLiveIntake(input());
  assert.equal(good.mid, 2.05);
  assert.ok(good.spreadPct > 0 && good.spreadPct < 10);
  assert.equal(good.vwapRelationship, "ABOVE");
  assert.equal(decideLiveIntake(input({ bid: null, ask: null })).mid, null);
});

// ── Determinism ─────────────────────────────────────────────────────────────

test("the decision is deterministic and does not mutate its input", () => {
  const original = input();
  const snapshot = structuredClone(original);
  const a = decideLiveIntake(original);
  const b = decideLiveIntake(original);
  assert.deepEqual(a, b);
  assert.deepEqual(original, snapshot, "intake must not mutate the candidate");
});

// ── Lead time and premium avoided ───────────────────────────────────────────

test("lead time and premium avoided are deterministic, and unknown when unmeasurable", () => {
  const measured = computeLeadTime({
    radarObservedAtMs: OBSERVED, subscriberAlertAtMs: OBSERVED + 180_000,
    radarAsk: 2.00, subscriberAsk: 2.60,
  });
  assert.equal(measured.leadMs, 180_000);
  assert.equal(measured.premiumAvoidedPct, 30);

  // A subscriber alert that never happened makes this UNKNOWN, not zero.
  const noAlert = computeLeadTime({ radarObservedAtMs: OBSERVED, subscriberAlertAtMs: null, radarAsk: 2.0, subscriberAsk: null });
  assert.equal(noAlert.leadMs, null, "an alert that never fired is not a zero lead");
  assert.equal(noAlert.premiumAvoidedPct, null);
});

// ── Authority boundary ──────────────────────────────────────────────────────

test("intake has no delivery authority and imports nothing that could send", () => {
  const src = readFileSync("lib/research/asymmetry/live-intake.ts", "utf8");
  const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["./evidence.ts"], "intake may import only the evidence model");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const forbidden of ["fetch(", "sendTrackedDiscord", "deliverOptionsCallout", "webhook", "placeOrder"]) {
    assert.equal(code.includes(forbidden), false, `intake must not reference ${forbidden}`);
  }
  assert.equal(decideLiveIntake(input()).subscriberSendCreated, false);
});

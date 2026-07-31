/**
 * Field lineage and the proven capability matrix.
 *
 * The rule these tests defend: a field may not buy its way up the source
 * priority by being nice to look at. "Do not add provider calls merely to
 * improve Discord appearance" is only real if it is executable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIELD_LINEAGE, SOURCE_PRIORITY, resolutionPlan, freeWins, derivationGaps,
} from "../lib/research/asymmetry/field-lineage.ts";
import {
  MASSIVE_CAPABILITY_MATRIX, capabilitySummary, blockers, isProven,
  CAPABILITY_MATRIX_VERSION, PROBED_AT,
} from "../lib/research/asymmetry/historical/capability-matrix.ts";
import { MISSING_SOURCE_PROFILES } from "../lib/research/asymmetry/source-priority.ts";
import { replayCapabilities } from "../lib/research/replay-provider.ts";

// ── field lineage ───────────────────────────────────────────────────────────

test("the source priority order is the documented one", () => {
  assert.equal(SOURCE_PRIORITY.LIVE_SCANNER_PAYLOAD, 1);
  assert.equal(SOURCE_PRIORITY.FETCHED_OPTION_CHAIN, 2);
  assert.equal(SOURCE_PRIORITY.PERSISTED_EVIDENCE, 3);
  assert.equal(SOURCE_PRIORITY.LOCAL_TABLE, 4);
  assert.equal(SOURCE_PRIORITY.CACHE, 5);
  assert.equal(SOURCE_PRIORITY.PROVIDER_REQUEST, 6);
  assert.equal(SOURCE_PRIORITY.NOT_OBTAINABLE, 7);
});

test("every audited field is covered exactly once", () => {
  const required = [
    "trigger", "invalidation", "catalyst", "marketAlignment", "sectorAlignment",
    "impliedVolatility", "delta", "gamma", "optionVolume", "openInterest",
    "relativeVolume", "volumeAcceleration", "bid", "ask", "quoteTimestamp",
  ];
  const present = FIELD_LINEAGE.map((f) => f.field);
  for (const r of required) {
    assert.equal(present.filter((p) => p === r).length, 1, `${r} must appear exactly once`);
  }
});

test("every lineage row cites the file that proves it", () => {
  for (const f of FIELD_LINEAGE) {
    assert.ok(f.evidence && f.evidence.length > 40, `${f.field} needs real evidence, not a stub`);
  }
});

test("no provider call is ever justified for a presentation-only field", () => {
  const plan = resolutionPlan();
  for (const step of plan) {
    const row = FIELD_LINEAGE.find((f) => f.field === step.field);
    if (row.presentationOnly) {
      assert.equal(step.providerCallJustified, false,
        `${step.field} is presentation-only and must never justify a provider call`);
    }
  }
});

test("no provider call is proposed for a field no provider can supply", () => {
  for (const step of resolutionPlan()) {
    if (step.resolveFrom === "NOT_OBTAINABLE") {
      assert.equal(step.providerCallJustified, false, `${step.field} needs derivation, not budget`);
    }
  }
});

test("free mapping fixes are ordered ahead of anything requiring a request", () => {
  const plan = resolutionPlan();
  const lastFree = plan.map((s) => s.freeToFix).lastIndexOf(true);
  const firstPaid = plan.findIndex((s) => s.providerCallJustified);
  if (lastFree >= 0 && firstPaid >= 0) {
    assert.ok(lastFree < firstPaid,
      "a zero-cost mapping fix is strictly better than a request and must rank first");
  }
});

test("fields fetched and then dropped are reported as free wins", () => {
  const wins = freeWins();
  for (const f of ["impliedVolatility", "delta", "gamma", "optionVolume", "marketAlignment"]) {
    assert.ok(wins.includes(f), `${f} is already in hand and must be listed as free to fix`);
  }
});

test("trigger and invalidation are derivation gaps, not budget gaps", () => {
  const gaps = derivationGaps();
  assert.ok(gaps.includes("trigger"));
  assert.ok(gaps.includes("invalidation"));
  for (const g of gaps) {
    const row = FIELD_LINEAGE.find((f) => f.field === g);
    assert.equal(row.additionalProviderCallRequired, false,
      `${g} cannot be bought — no provider sells it`);
  }
});

test("quote-critical fields suppress the notification when absent", () => {
  for (const f of ["bid", "ask", "quoteTimestamp", "underlyingPrice"]) {
    const row = FIELD_LINEAGE.find((x) => x.field === f);
    assert.equal(row.missingBehavior, "SUPPRESSES_NOTIFICATION",
      `${f} absent must silence the message, not print a blank`);
  }
});

test("optionVolume is recorded as fetched-then-dropped, which makes the volume gate inert", () => {
  const row = FIELD_LINEAGE.find((f) => f.field === "optionVolume");
  assert.equal(row.droppedDuringMapping, true);
  assert.equal(row.additionalProviderCallRequired, false, "already in the chain payload");
  assert.equal(row.missingBehavior, "GATE_TREATS_AS_UNKNOWN",
    "a null can never fail a minimum-volume check, so the check cannot fire today");
});

test("resolution plan is deterministic", () => {
  assert.deepEqual(resolutionPlan().map((s) => s.field), resolutionPlan().map((s) => s.field));
});

// ── capability matrix ───────────────────────────────────────────────────────

test("every capability row carries probe evidence", () => {
  for (const r of MASSIVE_CAPABILITY_MATRIX) {
    assert.ok(r.evidence && r.evidence.length > 30, `${r.dataType} needs probe evidence`);
    assert.ok(r.endpoint, `${r.dataType} needs an endpoint`);
  }
});

test("historical exact-OCC NBBO is proven available with bid/ask", () => {
  const row = MASSIVE_CAPABILITY_MATRIX.find((r) => r.endpoint.includes("/v3/quotes/{optionsTicker}"));
  assert.equal(row.availability, "AVAILABLE_PROVEN");
  assert.equal(row.bidAskAvailable, true);
  assert.equal(row.blocker, null);
  assert.match(row.historicalDepth, /2023/);
});

test("historical open interest stays a hard gap — it is not reconstructible", () => {
  const row = MASSIVE_CAPABILITY_MATRIX.find((r) => r.dataType === "Open interest");
  assert.match(row.historicalDepth, /^none/, "there is no historical OI series at any depth");
  assert.ok(row.blocker.includes("NOT reconstructible"),
    "cohort rows for past sessions must leave OI missing rather than borrow today's value");
});

test("an unproven capability is never reported as available", () => {
  const row = MASSIVE_CAPABILITY_MATRIX.find((r) => r.dataType.startsWith("Historical option chain snapshot"));
  assert.equal(row.availability, "UNPROVEN");
  assert.equal(isProven(row.dataType), false, "unproven must never satisfy isProven");
});

test("option aggregates are flagged as unusable for executable price", () => {
  const row = MASSIVE_CAPABILITY_MATRIX.find((r) => r.dataType.startsWith("Historical exact-OCC aggregates"));
  assert.equal(row.bidAskAvailable, false);
  assert.match(row.blocker, /TRADE-derived/);
});

test("the summary counts match the matrix", () => {
  const s = capabilitySummary();
  assert.equal(s.version, CAPABILITY_MATRIX_VERSION);
  assert.equal(s.probedAt, PROBED_AT);
  assert.equal(s.proven, MASSIVE_CAPABILITY_MATRIX.filter((r) => r.availability === "AVAILABLE_PROVEN").length);
  assert.equal(s.unproven, MASSIVE_CAPABILITY_MATRIX.filter((r) => r.availability === "UNPROVEN").length);
  assert.equal(blockers().length, MASSIVE_CAPABILITY_MATRIX.filter((r) => r.blocker != null).length);
});

test("the corrected source-priority row no longer claims historical quotes are unavailable", () => {
  const row = MISSING_SOURCE_PROFILES.find((p) => p.field === "historicalOptionQuotes");
  assert.equal(row.providerSupport, "AVAILABLE_ENTITLED",
    "the old NOT_AVAILABLE was wrong and is why no historical cohort was ever attempted");
  assert.match(row.providerEvidence, /PROBED 2026-07-31/);
});

test("historical open interest is separately recorded as genuinely unavailable", () => {
  const row = MISSING_SOURCE_PROFILES.find((p) => p.field === "historicalOpenInterest");
  assert.equal(row.providerSupport, "NOT_AVAILABLE", "correcting one row must not overcorrect the other");
});

test("the replay lane still reports option replay inactive, for the right reason", () => {
  const opt = replayCapabilities({ POLYGON_API_KEY: "k" }).find((c) => c.assetClass === "option");
  assert.equal(opt.status, "INACTIVE_MISSING_PROVIDER",
    "this lane is genuinely not wired to the historical client");
  assert.match(opt.reason, /NBBO IS entitled/,
    "the reason must no longer claim the entitlement is missing");
  assert.ok(opt.missingFields.includes("historical_open_interest"));
  assert.ok(opt.missingFields.includes("historical_gamma"));
});

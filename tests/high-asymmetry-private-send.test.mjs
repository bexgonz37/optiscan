/**
 * tests/high-asymmetry-private-send.test.mjs
 *
 * Regression suite for a REAL DEFECT found while wiring the paper lane.
 *
 * `notifyPrivateAsymmetry` accepts an OPTIONAL injected `send`. The scheduler
 * never injected one. So with capture enabled, private notifications enabled,
 * and a webhook configured — the exact production state — every notification
 * returned NOT_CONFIGURED ("no sender injected") and no owner-private message
 * could ever have been delivered. Diagnostics reported `enabled: true,
 * webhookConfigured: true` throughout, so the radar looked healthy.
 *
 * These tests bind the scheduler to a real sender and fail if that wiring is
 * ever removed again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sendAsymmetryWebhook } from "../lib/notifications/asymmetry-private-send.ts";
import { notifyPrivateAsymmetry, createPrivateCaseMemory } from "../lib/research/asymmetry/private-notify.ts";

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const SCHEDULER = strip(readFileSync("lib/scheduler.ts", "utf8"));

test("the scheduler injects a real sender into the transition sweep", () => {
  const job = SCHEDULER.slice(
    SCHEDULER.indexOf("async function asymmetryTransitionsJob"),
    SCHEDULER.indexOf("async function asymmetryMarksJob"),
  );
  assert.match(job, /sendAsymmetryWebhook/, "without this, every private notification is NOT_CONFIGURED");
  assert.match(job, /send:\s*sendAsymmetryWebhook/, "it must be passed as the `send` dep specifically");
});

test("without an injected sender the notifier really does go silent", async () => {
  // The defect, reproduced. This is what production was doing.
  const res = await notifyPrivateAsymmetry(candidate(), {
    memory: createPrivateCaseMemory(),
    env: { HIGH_ASYMMETRY_PRIVATE_ENABLED: "1", HIGH_ASYMMETRY_PRIVATE_WEBHOOK: "https://discord.com/api/webhooks/1/tok" },
  });
  assert.equal(res.outcome, "NOT_CONFIGURED");
  assert.match(res.reason, /no sender injected/);
  assert.ok(res.content, "the message was even built — it simply had nowhere to go");
});

test("with the sender injected the message is delivered to the private webhook", async () => {
  let seen = null;
  const res = await notifyPrivateAsymmetry(candidate(), {
    memory: createPrivateCaseMemory(),
    env: { HIGH_ASYMMETRY_PRIVATE_ENABLED: "1", HIGH_ASYMMETRY_PRIVATE_WEBHOOK: "https://discord.com/api/webhooks/1/tok" },
    send: async (webhook, content) => { seen = { webhook, content }; return { ok: true }; },
  });
  assert.equal(res.outcome, "SENT");
  assert.equal(seen.webhook, "https://discord.com/api/webhooks/1/tok");
  assert.match(seen.content, /HIGH ASYMMETRY/);
});

test("the sender refuses anything that is not a Discord webhook URL", async () => {
  for (const bad of ["", "http://evil.test/hook", "https://example.com/api/webhooks/1/x", "not a url"]) {
    const res = await sendAsymmetryWebhook(bad, "hello");
    assert.equal(res.ok, false, `${bad || "(empty)"} must be refused`);
    assert.match(res.reason, /not a Discord webhook URL/);
  }
});

test("the sender never leaks the webhook value in an error", async () => {
  // A well-formed URL that cannot resolve: the failure must not echo the token.
  const res = await sendAsymmetryWebhook("https://discord.com/api/webhooks/000/SECRET-TOKEN-VALUE", "hi");
  assert.equal(res.ok, false);
  assert.equal(/SECRET-TOKEN-VALUE/.test(String(res.reason)), false, "the token must never appear in a reason string");
});

test("the sender suppresses mentions — research must never ping anyone", () => {
  const src = readFileSync("lib/notifications/asymmetry-private-send.ts", "utf8");
  assert.match(src, /allowed_mentions:\s*\{\s*parse:\s*\[\]\s*\}/);
});

test("the sender is bounded by a timeout and never throws", async () => {
  const src = readFileSync("lib/notifications/asymmetry-private-send.ts", "utf8");
  assert.match(src, /AbortController/);
  assert.match(src, /SEND_TIMEOUT_MS/);
  const res = await sendAsymmetryWebhook(null, null);
  assert.equal(res.ok, false, "a null argument returns a result rather than throwing");
});

function candidate() {
  return {
    fingerprint: "fp-1", sessionDate: "2026-07-30", symbol: "NVDA", direction: "CALL",
    optionSymbol: "O:NVDA260807C00200000", state: "HIGH_ASYMMETRY", observedAtMs: Date.parse("2026-07-30T14:00:00Z"),
    whyEarly: "test", premiumChasePct: 2, bid: 1.9, ask: 2.0, spreadPct: 5,
    openInterest: 1000, contractVolume: 500, trigger: null, invalidation: null,
    missingEvidence: [], setupFamilyLabel: null,
  };
}

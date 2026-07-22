import test from "node:test";
import assert from "node:assert/strict";
import { buildSubscriberDiscordReadiness } from "../lib/discord-readiness.ts";

const cleanMetrics = {
  total24h: 3,
  sent24h: 3,
  failed24h: 0,
  retrying24h: 0,
  suppressed24h: 0,
  notConfigured24h: 0,
  stuckInFlight: 0,
  lastSentAt: "2026-07-22T18:00:00.000Z",
  lastFailureAt: null,
};

test("subscriber Discord readiness is ready when required channels are configured and deliveries are clean", () => {
  const r = buildSubscriberDiscordReadiness({
    webhooks: { options: true, stocks: false, recap: false },
    metrics: cleanMetrics,
    optionsRequired: true,
    stocksRequired: false,
  });
  assert.equal(r.subscriberSurface, "discord_only");
  assert.equal(r.status, "READY");
  assert.equal(r.channels.recap.subscriberDelivery, false);
  assert.equal(r.blockers.length, 0);
});

test("missing required Discord webhook blocks paid beta", () => {
  const r = buildSubscriberDiscordReadiness({
    webhooks: { options: false, stocks: false, recap: true },
    metrics: cleanMetrics,
    optionsRequired: true,
  });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.blockers.some((b) => /options webhook missing/.test(b)));
  assert.match(r.betaVerdict, /Do not sell subscriber access/);
});

test("recent failed Discord deliveries require review without changing production behavior", () => {
  const r = buildSubscriberDiscordReadiness({
    webhooks: { options: true, stocks: true, recap: false },
    metrics: { ...cleanMetrics, failed24h: 1, sent24h: 2 },
    optionsRequired: true,
    stocksRequired: true,
  });
  assert.equal(r.status, "NEEDS_REVIEW");
  assert.ok(r.reviewItems.some((x) => /failed\/retrying/.test(x)));
});

test("stuck in-flight Discord sends block paid beta readiness", () => {
  const r = buildSubscriberDiscordReadiness({
    webhooks: { options: true, stocks: false, recap: false },
    metrics: { ...cleanMetrics, stuckInFlight: 2 },
    optionsRequired: true,
  });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.blockers.some((x) => /stuck in flight/.test(x)));
});

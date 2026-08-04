/**
 * recap-health.test.mjs
 *
 * Pins the production configuration measured on 2026-08-03, which the previous
 * diagnosis got backwards:
 *
 *   DISCORD_WEBHOOK_RECAP  = SET (121 chars)   <- the webhook existed
 *   DISCORD_RECAP_ENABLED  = "0"               <- and delivery was switched off
 *
 * `/api/discord/health` reported `recap: false`, which was read as "the owner
 * never set the webhook". These tests make the two causes impossible to confuse
 * while keeping the delivery GATE byte-identical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { recapDeliveryDiagnosis } from "../lib/notifications/recap-health.ts";
import { recapDeliveryEnabled } from "../lib/notifications/recap-delivery-guard.ts";

const WEBHOOK = `https://discord.com/api/webhooks/${"1".repeat(19)}/${"a".repeat(68)}`;

test("the exact production state: webhook present, kill-switch engaged", () => {
  const d = recapDeliveryDiagnosis({ DISCORD_WEBHOOK_RECAP: WEBHOOK, DISCORD_RECAP_ENABLED: "0" });
  assert.equal(d.state, "DISABLED_BY_KILL_SWITCH");
  assert.equal(d.webhookPresent, true);
  assert.equal(d.killSwitchEngaged, true);
  assert.equal(d.canDeliver, false);
  // The skip reason must not accuse a missing webhook when one is configured.
  assert.equal(d.skipReason, "SKIPPED_RECAP_DISABLED");
  assert.match(d.ownerAction, /DISCORD_RECAP_ENABLED=1/);
  assert.match(d.ownerAction, /Do NOT add another webhook/);
});

test("a genuinely missing webhook still reports missing configuration", () => {
  const d = recapDeliveryDiagnosis({});
  assert.equal(d.state, "MISSING_CONFIGURATION");
  assert.equal(d.webhookPresent, false);
  assert.equal(d.skipReason, "SKIPPED_NO_WEBHOOK");
  assert.match(d.ownerAction, /Set DISCORD_WEBHOOK_RECAP/);
});

test("the healthy state asks the owner for nothing", () => {
  const d = recapDeliveryDiagnosis({ DISCORD_WEBHOOK_RECAP: WEBHOOK });
  assert.equal(d.state, "CONFIGURED_AND_ENABLED");
  assert.equal(d.canDeliver, true);
  assert.equal(d.ownerAction, null);
  assert.equal(d.skipReason, "DELIVERED");
});

test("explicitly enabled is the same as unset", () => {
  const d = recapDeliveryDiagnosis({ DISCORD_WEBHOOK_RECAP: WEBHOOK, DISCORD_RECAP_ENABLED: "1" });
  assert.equal(d.state, "CONFIGURED_AND_ENABLED");
  assert.equal(d.canDeliver, true);
});

test("both missing is distinguishable from either alone", () => {
  const d = recapDeliveryDiagnosis({ DISCORD_RECAP_ENABLED: "0" });
  assert.equal(d.state, "MISSING_AND_DISABLED");
  assert.equal(d.canDeliver, false);
  assert.match(d.ownerAction, /DISCORD_WEBHOOK_RECAP/);
  assert.match(d.ownerAction, /DISCORD_RECAP_ENABLED=1/);
});

test("every distinct configuration yields a distinct state", () => {
  const states = new Set([
    recapDeliveryDiagnosis({ DISCORD_WEBHOOK_RECAP: WEBHOOK }).state,
    recapDeliveryDiagnosis({ DISCORD_WEBHOOK_RECAP: WEBHOOK, DISCORD_RECAP_ENABLED: "0" }).state,
    recapDeliveryDiagnosis({}).state,
    recapDeliveryDiagnosis({ DISCORD_RECAP_ENABLED: "0" }).state,
  ]);
  assert.equal(states.size, 4, "four configurations collapsed into fewer states");
});

test("canDeliver never disagrees with the pre-existing delivery gate", () => {
  // The gate must not change: nothing may start delivering because the
  // diagnosis got more descriptive.
  const cases = [
    { DISCORD_WEBHOOK_RECAP: WEBHOOK },
    { DISCORD_WEBHOOK_RECAP: WEBHOOK, DISCORD_RECAP_ENABLED: "0" },
    { DISCORD_WEBHOOK_RECAP: WEBHOOK, DISCORD_RECAP_ENABLED: "1" },
    {},
    { DISCORD_RECAP_ENABLED: "0" },
  ];
  for (const env of cases) {
    const legacyGate = recapDeliveryEnabled(env)
      && Boolean(String(env.DISCORD_WEBHOOK_RECAP ?? "").trim());
    assert.equal(
      recapDeliveryDiagnosis(env).canDeliver,
      legacyGate,
      `gate drifted for ${JSON.stringify(Object.keys(env))}`,
    );
  }
});

test("no diagnosis ever exposes the webhook value", () => {
  const d = recapDeliveryDiagnosis({ DISCORD_WEBHOOK_RECAP: WEBHOOK, DISCORD_RECAP_ENABLED: "0" });
  const serialized = JSON.stringify(d);
  assert.ok(!serialized.includes(WEBHOOK), "the webhook URL leaked into the diagnosis");
  assert.ok(!serialized.includes("a".repeat(68)), "the webhook token leaked into the diagnosis");
});

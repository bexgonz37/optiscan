import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSubscriberConfig,
  shouldBlockIndependentDelivery,
  subscriberConfigStrict,
} from "../lib/subscriber-config-validator.ts";

const independentBase = {
  SUBSCRIBER_OPTIONS_DISCORD_OWNER: "independent",
  AGENT_CALLOUT_DISCORD: "0",
  INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
  EARLY_OPTIONS_CALLOUTS_ENABLED: "1",
  OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",
};

test("independent owner passes when required flags are set and supervisor Discord is off", () => {
  const r = validateSubscriberConfig(independentBase);
  assert.equal(r.ok, true);
  assert.equal(r.fatal.length, 0);
  assert.equal(r.ownership.independentOwns, true);
});

test("AGENT_CALLOUT_DISCORD=1 conflicts with independent owner", () => {
  const r = validateSubscriberConfig({ ...independentBase, AGENT_CALLOUT_DISCORD: "1" });
  assert.equal(r.ok, false);
  assert.ok(r.fatal.some((f) => f.includes("AGENT_CALLOUT_DISCORD")));
});

test("missing portfolio delivery is fatal for independent owner", () => {
  const r = validateSubscriberConfig({ ...independentBase, OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "0" });
  assert.equal(r.ok, false);
  assert.ok(r.fatal.some((f) => f.includes("OPTIONS_PORTFOLIO_DELIVERY_ENABLED")));
});

test("shouldBlockIndependentDelivery respects SUBSCRIBER_CONFIG_STRICT", () => {
  const bad = validateSubscriberConfig({ ...independentBase, AGENT_CALLOUT_DISCORD: "1" });
  assert.equal(shouldBlockIndependentDelivery(bad, { ...independentBase, SUBSCRIBER_CONFIG_STRICT: "1" }), true);
  assert.equal(shouldBlockIndependentDelivery(bad, { ...independentBase, SUBSCRIBER_CONFIG_STRICT: "0" }), false);
});

test("subscriberConfigStrict defaults to on unless explicitly disabled", () => {
  assert.equal(subscriberConfigStrict({}), true);
  assert.equal(subscriberConfigStrict({ SUBSCRIBER_CONFIG_STRICT: "0" }), false);
});

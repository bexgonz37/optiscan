import test from "node:test";
import assert from "node:assert/strict";
import {
  calloutWebhook,
  calloutCanonicalPath,
  supervisorDiscordDeliveryEnabled,
  legacyOptionsSuppressed,
} from "../lib/callouts/routing.ts";

test("option call horizons route to the options webhook", () => {
  assert.equal(calloutWebhook({ horizon: "0DTE", contract: {} }), "options");
  assert.equal(calloutWebhook({ horizon: "1–5 DTE", contract: {} }), "options");
  assert.equal(calloutWebhook({ horizon: "36–90 DTE", contract: {} }), "options");
});

test("put research horizons also route to the options webhook (labeled RESEARCH ONLY in payload)", () => {
  // Put callouts share the horizon labels; direction is bearish but channel is options.
  assert.equal(calloutWebhook({ horizon: "0DTE", contract: { side: "put" } }), "options");
});

test("momentum-stock callouts route to the stocks webhook", () => {
  assert.equal(calloutWebhook({ horizon: "stock", contract: {} }), "stocks");
});

test("canonical path defaults to legacy; supervisor only when explicit", () => {
  assert.equal(calloutCanonicalPath({}), "legacy");
  assert.equal(calloutCanonicalPath({ CALLOUT_CANONICAL_PATH: "supervisor" }), "supervisor");
  assert.equal(calloutCanonicalPath({ CALLOUT_CANONICAL_PATH: "true" }), "legacy");
});

test("supervisor Discord delivery requires BOTH the canonical path and the master switch", () => {
  assert.equal(supervisorDiscordDeliveryEnabled({}), false);
  assert.equal(supervisorDiscordDeliveryEnabled({ CALLOUT_CANONICAL_PATH: "supervisor" }), false);
  assert.equal(supervisorDiscordDeliveryEnabled({ AGENT_CALLOUT_DISCORD: "1" }), false);
  assert.equal(supervisorDiscordDeliveryEnabled({ CALLOUT_CANONICAL_PATH: "supervisor", AGENT_CALLOUT_DISCORD: "1" }), true);
});

test("legacy options sender stands down exactly when supervisor is canonical", () => {
  assert.equal(legacyOptionsSuppressed({}), false);
  assert.equal(legacyOptionsSuppressed({ CALLOUT_CANONICAL_PATH: "supervisor" }), true);
});

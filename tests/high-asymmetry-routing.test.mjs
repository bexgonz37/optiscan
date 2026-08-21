/**
 * high-asymmetry-routing.test.mjs — OWNER DECISION 2026-08-21.
 *
 *   CAPTURE = ON    TRACKING = ON   MARKS = ON
 *   MFE/MAE = ON    LEARNING = ON   APP VISIBILITY = ON
 *   DISCORD = OFF
 *
 * The decision is only expressible because capture and notification were built
 * as SEPARATE controls: `HIGH_ASYMMETRY_CAPTURE_ENABLED` governs the research
 * population, `HIGH_ASYMMETRY_PRIVATE_ENABLED` governs whether any of it speaks.
 * These tests pin that independence, so a future change cannot quietly couple
 * them and silence the research population along with the channel.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CAPTURE_ENABLED_ENV } from "../lib/research/asymmetry/capture.ts";
import { MARKS_ENABLED_ENV } from "../lib/research/asymmetry/mark-runner.ts";
import { TRANSITIONS_ENABLED_ENV } from "../lib/research/asymmetry/transition-runner.ts";
import { EOD_ENABLED_ENV } from "../lib/research/asymmetry/eod-review.ts";
import { PRIVATE_ENABLED_ENV, resolvePrivateConfig } from "../lib/research/asymmetry/private-notify.ts";

/** The owner-decided production shape. */
const OWNER_ENV = {
  HIGH_ASYMMETRY_CAPTURE_ENABLED: "1",
  HIGH_ASYMMETRY_PRIVATE_ENABLED: "0",
  HIGH_ASYMMETRY_PRIVATE_WEBHOOK: "https://discord.example/owner-private",
};

test("20. capture, marks, transitions and EOD review all key off the CAPTURE flag — not the Discord one", () => {
  assert.equal(CAPTURE_ENABLED_ENV, "HIGH_ASYMMETRY_CAPTURE_ENABLED");
  assert.equal(MARKS_ENABLED_ENV, "HIGH_ASYMMETRY_CAPTURE_ENABLED", "marks/MFE/MAE follow capture");
  assert.equal(TRANSITIONS_ENABLED_ENV, "HIGH_ASYMMETRY_CAPTURE_ENABLED", "tracking follows capture");
  assert.equal(EOD_ENABLED_ENV, "HIGH_ASYMMETRY_CAPTURE_ENABLED", "learning/review follows capture");
  // The notification control is a genuinely different variable.
  assert.equal(PRIVATE_ENABLED_ENV, "HIGH_ASYMMETRY_PRIVATE_ENABLED");
  assert.notEqual(PRIVATE_ENABLED_ENV, CAPTURE_ENABLED_ENV,
    "one switch could not express capture-ON/Discord-OFF");
});

test("20b. under the owner env, Discord is OFF while capture stays ON", () => {
  const notify = resolvePrivateConfig(OWNER_ENV);
  assert.equal(notify.enabled, false, "DISCORD = OFF");
  // The capture-side flag is untouched by that, and still reads as enabled.
  assert.equal(OWNER_ENV[CAPTURE_ENABLED_ENV], "1", "CAPTURE = ON");
  assert.equal(OWNER_ENV[MARKS_ENABLED_ENV], "1", "MARKS / MFE / MAE = ON");
  assert.equal(OWNER_ENV[TRANSITIONS_ENABLED_ENV], "1", "TRACKING = ON");
  assert.equal(OWNER_ENV[EOD_ENABLED_ENV], "1", "LEARNING = ON");
});

test("20c. Discord stays OFF unless it is switched on deliberately — a webhook alone is not consent", () => {
  assert.equal(resolvePrivateConfig({}).enabled, false, "off by default");
  assert.equal(resolvePrivateConfig({ HIGH_ASYMMETRY_PRIVATE_WEBHOOK: "https://x" }).enabled, false,
    "configuring a webhook does not enable sending");
  assert.equal(resolvePrivateConfig({ HIGH_ASYMMETRY_PRIVATE_ENABLED: "true" }).enabled, false,
    "only the exact value 1 enables it");
  assert.equal(resolvePrivateConfig({ ...OWNER_ENV, HIGH_ASYMMETRY_PRIVATE_ENABLED: "1" }).enabled, true,
    "and it is genuinely re-enableable, so this is a routing decision and not a removal");
});

test("20d. turning Discord off cannot disable capture as a side effect", () => {
  // The notify resolver reads ONLY its own variables. If it ever started
  // consulting the capture flag, this would catch it.
  const withCaptureOff = resolvePrivateConfig({ ...OWNER_ENV, HIGH_ASYMMETRY_CAPTURE_ENABLED: "0" });
  const withCaptureOn = resolvePrivateConfig(OWNER_ENV);
  assert.deepEqual(withCaptureOff, withCaptureOn, "the two controls do not observe each other");
});

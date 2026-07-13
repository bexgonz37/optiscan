import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { legacyWatchDiscordEnabled } from "../lib/callouts/routing.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ── the pure gate: WATCH Discord is OFF by default ────────────────────────────
test("WATCH Discord is disabled by default (no opt-in, legacy path)", () => {
  assert.equal(legacyWatchDiscordEnabled({}), false);
  assert.equal(legacyWatchDiscordEnabled({ CALLOUT_CANONICAL_PATH: "legacy" }), false);
});

test("WATCH Discord requires the explicit DISCORD_WATCH_ALERTS=1 opt-in", () => {
  assert.equal(legacyWatchDiscordEnabled({ DISCORD_WATCH_ALERTS: "1" }), true);
  assert.equal(legacyWatchDiscordEnabled({ DISCORD_WATCH_ALERTS: "0" }), false);
  assert.equal(legacyWatchDiscordEnabled({ DISCORD_WATCH_ALERTS: "true" }), false);
});

test("WATCH Discord ALWAYS stands down under the supervisor canonical path", () => {
  // Even with the opt-in explicitly on, supervisor ownership wins → no WATCH send.
  assert.equal(legacyWatchDiscordEnabled({ CALLOUT_CANONICAL_PATH: "supervisor" }), false);
  assert.equal(
    legacyWatchDiscordEnabled({ CALLOUT_CANONICAL_PATH: "supervisor", DISCORD_WATCH_ALERTS: "1" }),
    false,
    "supervisor path never narrates WATCH to Discord",
  );
});

// ── the wiring: notifyWatchAlert honors the gate and records a skip ───────────
test("notifyWatchAlert is gated by legacyWatchDiscordEnabled and records a skip (no post)", () => {
  const src = read("lib/notifications.ts");
  assert.ok(/import \{[^}]*legacyWatchDiscordEnabled[^}]*\} from "@\/lib\/callouts\/routing"/.test(src),
    "notifications imports the WATCH gate");
  // The gate is checked inside notifyWatchAlert BEFORE any postToDiscord. Slice the
  // function body = from its declaration to the start of the next top-level export.
  const start = src.indexOf("export async function notifyWatchAlert");
  const next = src.indexOf("\nexport ", start + 1);
  const body = src.slice(start, next === -1 ? src.length : next);
  assert.ok(/if \(!legacyWatchDiscordEnabled\(\)\)/.test(body), "checks the gate");
  const gateIdx = body.indexOf("legacyWatchDiscordEnabled()");
  const postIdx = body.indexOf("postToDiscord");
  assert.ok(gateIdx > -1 && postIdx > -1 && gateIdx < postIdx, "gate is evaluated before any Discord post");
  assert.ok(/status: "skipped"/.test(body), "records a skipped notification event for observability");
});

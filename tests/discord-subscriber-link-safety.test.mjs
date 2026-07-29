import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  internalLinksAllowed,
  sanitizeDiscordPayloadForAudience,
  stripInternalSubscriberReferences,
} from "../lib/notifications/subscriber-content.ts";
import { formatMarketOpenConfirm } from "../lib/notifications/owner-research-notify.ts";

test("unknown and subscriber audiences fail closed on internal links and identifiers", () => {
  const content = [
    "RESEARCH",
    "View details: https://optiscan-production.up.railway.app/intelligence/oc_secret",
    "Opportunity case ID: oc_secret",
    "Educational purposes only.",
  ].join("\n");
  assert.equal(internalLinksAllowed({}), false);
  assert.equal(internalLinksAllowed({ audience: "subscriber", includeInternalLink: true }), false);
  assert.equal(internalLinksAllowed({ audience: "owner_admin", includeInternalLink: true }), true);
  const cleaned = stripInternalSubscriberReferences(content);
  assert.equal(cleaned, "RESEARCH\nEducational purposes only.");
  const payload = sanitizeDiscordPayloadForAudience({ content }, { audience: "unknown" });
  assert.doesNotMatch(String(payload.content), /railway|intelligence|oc_secret|Opportunity case/i);
});

test("subscriber watchlist formatter contains no internal route or URL", () => {
  const content = formatMarketOpenConfirm({
    tradingDay: "2026-07-29",
    builtAtMs: Date.now(),
    planVersion: "wl_test",
    marketContext: { spyNote: "SPY mixed", qqqNote: "QQQ mixed", newsNote: null },
    recommendations: [],
  });
  assert.doesNotMatch(content, /https?:\/\/|\/intelligence|\/alerts|opportunity case|alert id/i);
  assert.match(content, /Not executable/i);
});

test("private owner payload is preserved only with explicit owner-admin authority", () => {
  const payload = { content: "View details: https://private.example/intelligence/oc_123" };
  const kept = sanitizeDiscordPayloadForAudience(payload, {
    audience: "owner_admin",
    includeInternalLink: true,
  });
  assert.equal(kept.content, payload.content);
});

test("backend opportunity and alert linkage remains stored after copy is sanitized", () => {
  const delivery = readFileSync(new URL("../lib/research/options/delivery.ts", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
  assert.match(delivery, /opportunityCaseId/);
  assert.match(delivery, /discordMessageId/);
  assert.match(schema, /opportunity_case_id/);
  assert.match(schema, /discord_message_id/);
});

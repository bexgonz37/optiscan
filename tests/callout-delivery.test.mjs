import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("callout delivery reuses the tracked sender + ledger idempotency (no new raw webhook)", () => {
  const src = read("lib/notifications.ts");
  // Reuses the shared tracked sender, not a second unrelated raw sender.
  assert.ok(/export async function deliverCalloutDiscord/.test(src));
  assert.ok(/sendTrackedDiscord\(/.test(src), "delegates to the shared tracked sender");
  // Idempotency guard: never re-post a state already SENT.
  assert.ok(/getDiscordDeliveryByIdempotencyKey/.test(src));
  assert.ok(/existing\.status === "SENT"/.test(src), "skips when already sent (retry-safe)");
  // No second raw webhook fetch invented for callouts.
  assert.ok(!/fetch\(`?https?:\/\/discord/i.test(src) || /postToDiscord/.test(src));
});

test("legacy options Discord stands down when supervisor is the canonical path", () => {
  const src = read("lib/notifications.ts");
  assert.ok(/legacyOptionsSuppressed\(\)/.test(src));
  assert.ok(/superseded by supervisor canonical callout path/.test(src));
});

test("runtime delivers ONE tracked message per EMITTED canonical bundle (not per agent)", () => {
  const src = read("lib/callouts/runtime.ts");
  // Delivery only for emitted bundles, gated on canonical-path enablement.
  assert.ok(/if \(!b\.decision\.emit \|\| !b\.discord\) continue;/.test(src));
  assert.ok(/opts\.deliver && autoSend/.test(src));
  assert.ok(/deliverCalloutDiscord\(/.test(src));
  assert.ok(/calloutWebhook\(b\.callout\)/.test(src));
  // The supervised.canonical set is already deduped to one per ticker/dir/horizon.
  assert.ok(/supervised\.canonical/.test(src));
});

test("delivery records the delivery id/status back into persistent callout state", () => {
  const src = read("lib/callouts/runtime.ts");
  assert.ok(/deliveryId: b\.deliveryId, deliveryStatus: b\.deliveryStatus/.test(src));
});

/**
 * discord-smoke.mjs — local DRY-RUN preview of the Discord smoke-test callouts.
 *
 * Prints the TEST/DRY-RUN payloads (formatting + channel routing) for every callout
 * kind WITHOUT sending anything and WITHOUT any provider/paper/model side effect.
 * It imports only the PURE fixtures, so it needs no server and no webhook.
 *
 * Run:
 *   node --experimental-strip-types scripts/discord-smoke.mjs
 *
 * To actually SEND through the tracked ledger (after configuring the webhook env
 * vars), hit the protected endpoint on a running server instead:
 *   curl -H "x-scan-token: $SCAN_API_TOKEN" \
 *        "http://localhost:8780/api/dev/discord-smoke?send=1"
 *   (requires DISCORD_SMOKE_TEST=1 and DISCORD_WEBHOOK_OPTIONS / DISCORD_WEBHOOK_STOCKS)
 */
import { buildSmokeCallouts } from "../lib/callouts/smoke-fixtures.ts";

const items = buildSmokeCallouts();
console.log(`OptiScan Discord smoke test — DRY RUN (${items.length} scenarios, nothing sent)\n`);
for (const it of items) {
  console.log(`── ${it.name}  →  #${it.webhook}`);
  console.log(`   content: ${it.payload.content.replace(/\n/g, "\n            ")}`);
  console.log(`   title:   ${it.payload.embed.title}`);
  const modelField = it.payload.embed.fields.find((f) => f.name === "Model");
  if (modelField) console.log(`   model:   ${modelField.value}`);
  console.log("");
}
console.log("No webhook requests were made. See the header comment to send for real.");

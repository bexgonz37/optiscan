import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatExplanationDiscord, buildOptionsBuyEmbed, DISCORD_COLORS } from "../lib/alert-format.js";
import { buildTradeExplanation } from "../lib/trade-explanation.ts";
import { containsBannedPublicLanguage } from "../lib/language-modes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const okCall = () => ({
  ok: true, profile: "zero_dte_momentum",
  contract: { optionSymbol: "O:NVDA_C130", side: "call", strike: 130, expiration: "2026-07-11", dte: 0, bid: 1.18, ask: 1.22, mid: 1.2, spreadPct: 3, delta: 0.45, iv: 0.42, openInterest: 4500, volume: 1240 },
  score: 78, reasons: [], actionable: true, researchOnly: false, notes: [],
  marketData: { spot: 130, mid: 1.2, spreadPct: 3, delta: 0.45, openInterest: 4500, volume: 1240, iv: 0.42, breakevenPct: 0.92, distFromSpotPct: 0, chainAsOfMs: 1, contractAsOfMs: 1 },
});

function callExp(over = {}) {
  return buildTradeExplanation({
    ticker: "NVDA", direction: "bullish", side: "call", selection: okCall(),
    contract: okCall().contract, movePct: 1.4, relVol: 2.1, vwapRelationship: "above VWAP",
    riskScore: 40, riskLabel: "Medium Risk", midpointLabel: "Estimated midpoint", ...over,
  });
}

test("standalone combined alert: plain body first, then advanced + status fields", () => {
  const { payload, safe } = formatExplanationDiscord(callExp());
  const embed = payload.embeds[0];
  assert.ok(embed.description.startsWith("**Why now:**"), "why-now leads the body");
  assert.ok(embed.description.includes("**Contract:**"), "contract in body");
  assert.ok(embed.description.includes("**Risk:**"), "risk in body");
  assert.ok(embed.description.includes("**Improves if:**"));
  assert.ok(embed.description.includes("**Invalidated if:**"));
  assert.ok(embed.fields.some((f) => f.name === "Advanced" && f.value.includes("Delta 0.45")), "compact advanced line last");
  assert.ok(embed.fields.some((f) => f.name === "Status"));
  assert.equal(safe, true);
  assert.equal(containsBannedPublicLanguage(JSON.stringify(payload)), false);
});

test("merge preserves the base embed (color/author/footer) and overrides the body", () => {
  const base = buildOptionsBuyEmbed({ ticker: "NVDA", optionSide: "call", strike: 130, dte: 0, optionMid: 1.2, spreadPct: 3, delta: 0.45, price: 130, direction: "bullish", setupScore: 88, riskScore: 40, liquidityScore: 80, captureAction: "TRADE" }).payload;
  const { payload } = formatExplanationDiscord(callExp(), { base });
  const embed = payload.embeds[0];
  assert.equal(embed.color, DISCORD_COLORS.call, "base color preserved");
  assert.equal(embed.author.name, "OPTISCAN · options", "base author preserved");
  assert.ok(embed.footer?.text?.includes("not financial advice"), "base footer preserved");
  assert.ok(embed.description.startsWith("**Why now:**"), "explanation is now the body");
  assert.ok(embed.fields.some((f) => f.name === "Entry (mid)"), "base metric fields kept");
  assert.ok(embed.fields.some((f) => f.name === "Status"), "status added");
  assert.ok(payload.content && payload.content.includes("$NVDA"), "base role/push content preserved");
});

test("no-contract explanation renders the rejection block, not a fake contract", () => {
  const exp = buildTradeExplanation({
    ticker: "NVDA", direction: "bullish", side: "call",
    selection: { ok: false, profile: "zero_dte_momentum", rejectionCode: "SPREAD_TOO_WIDE", reason: "spread too wide", evaluated: 3, blockedByGate: { spread: 3 } },
  });
  const { payload } = formatExplanationDiscord(exp);
  assert.ok(payload.embeds[0].description.includes("**No contract:**"), "shows the block");
  assert.ok(!payload.embeds[0].description.includes("**Contract:**"), "no fabricated contract line");
});

test("a put alert is never presented as a live instruction", () => {
  const putExp = buildTradeExplanation({
    ticker: "NVDA", direction: "bearish", side: "put",
    contract: { side: "put", strike: 120, expiration: "2026-07-11", dte: 0, mid: 1.1, spreadPct: 3, delta: -0.45 },
  });
  const { payload } = formatExplanationDiscord(putExp);
  const status = payload.embeds[0].fields.find((f) => f.name === "Status");
  assert.ok(status.value.includes("not a live trade instruction"), "put is not actionable");
  assert.ok(!status.value.startsWith("Actionable"));
});

// ── single-send / dedup guarantees (source-spec) ────────────────────────────

test("notify path merges into ONE payload — no second send is introduced", () => {
  const src = read("lib/notifications.ts");
  // Explanation enrichment mutates the SINGLE payload, it does not call a second send.
  assert.ok(/formatExplanationDiscord/.test(src), "combined formatter wired");
  assert.ok(/ONE combined alert/.test(src), "documents single-message intent");
  // Exactly one tracked BUY send remains in notifyNewAlert (sendTrackedDiscord).
  const notifyBody = src.slice(src.indexOf("export async function notifyNewAlert"), src.indexOf("export async function confirmAndSendPending"));
  const sends = (notifyBody.match(/sendTrackedDiscord\(/g) ?? []).length;
  assert.equal(sends, 1, "exactly one send in notifyNewAlert");
});

test("dedup + idempotency still gate the send unchanged", () => {
  const store = read("lib/alert-store.ts");
  assert.ok(/alertRecentDuplicate/.test(store), "duplicate-window guard preserved");
  const src = read("lib/notifications.ts");
  assert.ok(/idempotencyKey: `\$\{alertId\}:\$\{webhook\}:buy`/.test(src), "idempotency key preserved");
});

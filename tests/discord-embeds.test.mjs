import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOptionsBuyEmbed,
  buildStockBuyEmbed,
  buildWatchEmbed,
  buildScoreboardEmbed,
  patchDiscordResultEmbed,
  formatResultField5m,
  formatResultFieldFinal,
  DISCORD_COLORS,
} from "../lib/alert-format.js";
import { containsBannedPublicLanguage } from "../lib/language-modes.js";

const BUY_ALERT = {
  ticker: "TSLA",
  optionSide: "put",
  strike: 400,
  dte: 0,
  optionMid: 2.52,
  spreadPct: 1.2,
  delta: -0.48,
  shortRate: -0.3,
  volumeSurge: 4.4,
  price: 401,
  direction: "bearish",
  setupScore: 93,
  riskScore: 30,
  liquidityScore: 80,
  captureAction: "TRADE",
};

test("buildOptionsBuyEmbed matches spec shape and colors", () => {
  const { payload, safe } = buildOptionsBuyEmbed(BUY_ALERT);
  assert.equal(safe, true);
  assert.ok(payload.content.includes("BUY — TSLA"));
  assert.equal(payload.embeds[0].color, DISCORD_COLORS.put);
  assert.equal(payload.embeds[0].author.name, "OPTISCAN · options");
  assert.ok(payload.embeds[0].fields.some((f) => f.name === "Entry (mid)"));
  assert.ok(payload.embeds[0].footer.text.includes("not financial advice"));
  assert.equal(containsBannedPublicLanguage(payload.embeds[0].description ?? ""), false);
});

test("buildStockBuyEmbed uses LONG green / SHORT coral", () => {
  const long = buildStockBuyEmbed({ ticker: "RIVN", session: "premarket", direction: "bullish", price: 16.98, shortRate: 0.48, volumeSurge: 3.1, movePct: 6.4, stockReason: "Gap hold" });
  assert.equal(long.payload.embeds[0].color, DISCORD_COLORS.call);
  const short = buildStockBuyEmbed({ ticker: "RIVN", session: "regular", direction: "bearish", price: 16.98, stockHeadline: "SHORT RIVN" });
  assert.equal(short.payload.embeds[0].color, DISCORD_COLORS.put);
});

test("buildWatchEmbed is quiet — no content mention", () => {
  const { payload } = buildWatchEmbed({ ticker: "NVDA", optionSide: "call", strike: 189, spreadPct: 2.1, delta: 0.44, shortRate: 0.14 });
  assert.equal(payload.content, undefined);
  assert.equal(payload.embeds[0].color, DISCORD_COLORS.neutral);
});

test("result edit payloads append 5m and Result fields", () => {
  const base = buildOptionsBuyEmbed(BUY_ALERT).payload;
  const at5 = patchDiscordResultEmbed(base, {
    fieldName: "5 min",
    fieldValue: formatResultField5m({ mid: 2.94, returnPct: 17 }),
  });
  assert.ok(at5.embeds[0].fields.some((f) => f.name === "5 min"));
  const final = patchDiscordResultEmbed(at5, {
    fieldName: "Result",
    fieldValue: formatResultFieldFinal({ returnPct: 31, paid: true, paidInMin: 6 }),
    final: true,
    paid: true,
  });
  assert.ok(final.embeds[0].fields.some((f) => f.name === "Result"));
});

test("scoreboard embed includes dashboard path footer", () => {
  const { payload, safe } = buildScoreboardEmbed(
    { optionWins: 5, optionLosses: 2, optionWinRate: 0.71, earlyHitRate: 0.62 },
    [{ emoji: "🟢", label: "TSLA $400P", value: "+31% · paid in 6 min" }],
    { dashboardUrl: "https://example.com/alerts" },
  );
  assert.equal(safe, true);
  assert.ok(payload.embeds[0].footer.text.includes("example.com/alerts"));
});

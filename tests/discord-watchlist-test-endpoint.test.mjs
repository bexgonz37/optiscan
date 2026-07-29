import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sendWatchlistTestMessage,
  WATCHLIST_TEST_CONTENT,
} from "../lib/notifications/watchlist-test.ts";
import { checkApiToken, unauthorized } from "../lib/auth.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("watchlist test message sends to Watchlist only", async () => {
  const calls = [];
  const result = await sendWatchlistTestMessage({
    env: { DISCORD_WEBHOOK_WATCHLIST: "https://discord.test/watchlist" },
    post: async (payload, opts) => {
      calls.push({ payload, opts });
      return { messageId: "msg_watchlist_test", httpStatus: 200, responseBodySafe: "{}" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.messageId, "msg_watchlist_test");
  assert.equal(result.httpStatus, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.webhook, "watchlist");
  assert.equal(calls[0].opts.skipPublicCheck, true);
  assert.match(String(calls[0].payload.content), /TEST · WATCHLIST/);
  assert.match(String(calls[0].payload.content), /NOT EXECUTABLE/);
  assert.match(String(calls[0].payload.content), /VERIFY CONTRACT AFTER OPTIONS OPEN/);
  assert.doesNotMatch(String(calls[0].payload.content), /TRADE NOW|BEARISH TRADE CANDIDATE|VERIFIED OPTIONS ALERT/i);
});

test("watchlist test message fails closed when Watchlist webhook is missing", async () => {
  let called = false;
  const result = await sendWatchlistTestMessage({
    env: {},
    post: async () => {
      called = true;
      return { messageId: "bad", httpStatus: 200 };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.messageId, null);
  assert.equal(result.httpStatus, null);
  assert.match(result.error ?? "", /DISCORD_WEBHOOK_WATCHLIST not configured/);
  assert.equal(called, false);
});

test("watchlist test route is authenticated and returns 401 through the shared token gate", () => {
  const prior = process.env.SCAN_API_TOKEN;
  process.env.SCAN_API_TOKEN = "secret-token";
  try {
    const req = new Request("https://optiscan.test/api/discord/test-watchlist", { method: "POST" });
    assert.equal(checkApiToken(req), false);
    const res = unauthorized();
    assert.equal(res.status, 401);
  } finally {
    if (prior == null) delete process.env.SCAN_API_TOKEN;
    else process.env.SCAN_API_TOKEN = prior;
  }
});

test("watchlist test endpoint has no trading or persistence side effects", () => {
  const route = read("app/api/discord/test-watchlist/route.ts");
  const helper = read("lib/notifications/watchlist-test.ts");
  const combined = `${route}\n${helper}`;
  assert.match(route, /checkApiToken/);
  assert.match(route, /unauthorized/);
  assert.match(route, /sendWatchlistTestMessage/);
  assert.match(route, /stateChanged:\s*false/);
  assert.match(helper, /webhook:\s*"watchlist"/);
  assert.doesNotMatch(combined, /sendTrackedDiscord|createDiscordDelivery|insertNotificationEvent/);
  assert.doesNotMatch(combined, /insertAlert|options_paper_trades|opportunity_cases|opportunity_content_events|watchlist_versions/);
  assert.doesNotMatch(combined, /webhook:\s*"options"|webhook:\s*"recap"/);
});

test("watchlist test content stays non-executable", () => {
  assert.match(WATCHLIST_TEST_CONTENT, /TEST · WATCHLIST/);
  assert.match(WATCHLIST_TEST_CONTENT, /NOT EXECUTABLE/);
  assert.match(WATCHLIST_TEST_CONTENT, /VERIFY CONTRACT AFTER OPTIONS OPEN/);
  assert.doesNotMatch(WATCHLIST_TEST_CONTENT, /TRADE NOW|live entry/i);
});

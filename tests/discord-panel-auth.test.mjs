/**
 * tests/discord-panel-auth.test.mjs — regression cover for the /discord page
 * showing every webhook as "NOT CONFIGURED".
 *
 * Measured defect: both GETs in DiscordDeliveryPanel omitted the API token, so
 * /api/discord/health returned 401, `r.json()` parsed the ERROR body into
 * `health`, `health.webhooks` was undefined, and the render fell through
 * `?? false` to "NOT CONFIGURED" for all three. Production simultaneously
 * reported {options:true, watchlist:true, recap:false}. The same bug emptied
 * the delivery ledger while 3 real sends existed in the window.
 *
 * These tests pin the render contract and the auth/error handling.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync("components/DiscordDeliveryPanel.tsx", "utf8");
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** The exact render rule the component uses for each webhook badge. */
const badge = (health, kind) => ((health?.webhooks?.[kind] ?? false) ? "Configured" : "NOT CONFIGURED");

// ── The three states, against the real production payload shape ─────────────

test("the production payload renders Options and Watchlist configured, Recap not", () => {
  const health = { webhooks: { options: true, watchlist: true, recap: false } };
  assert.equal(badge(health, "options"), "Configured");
  assert.equal(badge(health, "watchlist"), "Configured");
  assert.equal(badge(health, "recap"), "NOT CONFIGURED");
});

test("each webhook renders independently", () => {
  assert.equal(badge({ webhooks: { options: false, watchlist: true, recap: false } }, "options"), "NOT CONFIGURED");
  assert.equal(badge({ webhooks: { options: true, watchlist: false, recap: false } }, "watchlist"), "NOT CONFIGURED");
  assert.equal(badge({ webhooks: { options: true, watchlist: true, recap: true } }, "recap"), "Configured");
});

test("the badge keys match the API keys exactly", () => {
  // A rename on either side would silently reintroduce the bug.
  assert.match(code, /\["options",\s*"Alerts"\]/);
  assert.match(code, /\["watchlist",\s*"Watchlist"\]/);
  assert.match(code, /\["recap",\s*"Recaps"\]/);
});

// ── The defect itself ───────────────────────────────────────────────────────

test("a parsed 401 body must never be treated as health data", () => {
  // This is what the old code produced: the 401 JSON became `health`.
  const parsed401 = { ok: false, error: "unauthorized" };
  assert.equal(badge(parsed401, "options"), "NOT CONFIGURED");
  assert.equal(badge(parsed401, "watchlist"), "NOT CONFIGURED");
  // ...which is why a non-2xx response must throw instead of being parsed.
  assert.match(code, /if \(!res\.ok\)/, "a non-2xx response must be rejected");
  assert.match(code, /throw new Error/, "rejection must throw, not return data");
});

test("null health renders NOT CONFIGURED, so an unauthenticated load must error not silently render", () => {
  assert.equal(badge(null, "options"), "NOT CONFIGURED");
  assert.equal(badge(undefined, "watchlist"), "NOT CONFIGURED");
  // Because null is indistinguishable from "unconfigured" on screen, a failed
  // load must surface an error AND clear health rather than leave it stale.
  assert.match(code, /setHealth\(null\)/, "a failed load must clear health");
  assert.match(code, /setError\(/, "a failed load must surface an error");
});

// ── Auth wiring ─────────────────────────────────────────────────────────────

test("both read endpoints send the API token", () => {
  assert.match(code, /scanHeaders/, "the panel must import and use scanHeaders");
  const helper = code.slice(code.indexOf("async function fetchJson"), code.indexOf("export"));
  assert.match(helper, /headers:\s*scanHeaders\(\)/, "the JSON helper must attach auth");
  for (const url of ["/api/discord/deliveries?limit=100", "/api/discord/health"]) {
    assert.ok(code.includes(`fetchJson("${url}")`), `${url} must go through the authenticated helper`);
  }
  // Neither read may still use a bare unauthenticated fetch.
  assert.equal(
    /fetch\("\/api\/discord\/(deliveries|health)[^"]*",\s*\{\s*cache: "no-store"\s*\}\)/.test(code),
    false,
    "no bare unauthenticated GET may remain",
  );
});

test("the fix does not arm the test-send or retry buttons", () => {
  // Those POSTs are deliberately left as-is. Adding auth there would turn a
  // currently-failing "Test alerts" button into one that sends a real Discord
  // message, which is out of scope and explicitly unwanted.
  const testPost = code.slice(code.indexOf('fetch("/api/discord/test"'), code.indexOf('fetch("/api/discord/test"') + 220);
  assert.equal(/scanHeaders/.test(testPost), false, "the test-send POST must not gain auth in this change");
});

test("no webhook URL, token, or secret is rendered", () => {
  assert.equal(/DISCORD_WEBHOOK_[A-Z]+\s*[:=]\s*["'`]http/.test(code), false);
  assert.equal(/discord\.com\/api\/webhooks/.test(code), false, "no raw webhook URL in the client");
  assert.match(SRC, /never render in the browser|without exposing raw URLs or tokens/i);
});

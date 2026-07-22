import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const stripStrings = (s) => s.replace(/`(?:\\.|[^`])*`/g, "\"\"").replace(/"(?:\\.|[^"])*"/g, "\"\"").replace(/'(?:\\.|[^'])*'/g, "\"\"");

test("runtime status reports worker ownership, cycles, learning, model, improvement", () => {
  const src = read("lib/runtime-status.ts");
  for (const field of [
    "scannerLockHolder", "leaseHolder", "loopState", "supervisorTelemetry",
    "calloutStateSummary", "discordDeliverySummary", "learningStatus",
    "modelStatus", "improvementStatus", "nextEligibleLearningMs",
    "moreForValidated", "moreForExperimental",
  ]) {
    assert.ok(src.includes(field), `missing runtime-status field/source: ${field}`);
  }
});

test("runtime status never exposes secrets or webhook URLs", () => {
  const src = read("lib/runtime-status.ts");
  const code = stripStrings(src);
  assert.ok(!/DISCORD_WEBHOOK|webhookUrl|process\.env\.[A-Z_]*KEY|apiKey|token/i.test(code), "no secret/webhook exposure");
  // Only aggregate delivery COUNTS are surfaced (by status), never payloads.
  assert.ok(/discordDeliverySummary\(\)/.test(src));
  assert.ok(!/payload_json|response_body/.test(src), "no payloads/response bodies");
});

test("runtime status exposes non-secret alert and paper config visibility", () => {
  const src = read("lib/runtime-status.ts");
  for (const key of [
    "SUPERVISOR_RUNTIME", "CALLOUT_CANONICAL_PATH", "AGENT_CALLOUT_DISCORD",
    "INDEPENDENT_OPTIONS_DISCOVERY_ENABLED", "OPTIONS_PORTFOLIO_DELIVERY_ENABLED",
    "STOCK_CALLOUTS", "PAPER_TRADING_ENABLED", "PAPER_AUTO_ENTRY",
    "PAPER_ALLOW_ZERO_DTE", "PAPER_KILL_SWITCH", "EARLY_ALERTS_ENABLED",
    "BEARISH_ACTIONABLE", "OPTIONS_PUTS_ENABLED", "STOCK_MOMENTUM_MIN_PRICE",
    "STOCK_MOMENTUM_MAX_PRICE", "STOCK_MOMENTUM_MIN_DAY_VOLUME",
    "STOCK_MOMENTUM_MIN_GAIN_FROM_PREV_CLOSE_PCT", "PAPER_CHALLENGE_MAX_POSITION_PCT",
    "PAPER_CHALLENGE_MAX_TOTAL_EXPOSURE_PCT", "PAPER_STOCK_DAY_STARTING_BALANCE_USD",
    "ALERT_DB_DIR",
  ]) {
    assert.ok(src.includes(key), `runtime config visibility missing ${key}`);
  }
  for (const phrase of [
    "Options Discord is enabled",
    "Independent options subscriber delivery is blocked because OPTIONS_PORTFOLIO_DELIVERY_ENABLED is not 1.",
    "Momentum stock Discord is disabled because STOCK_CALLOUTS is off",
    "Paper auto-entry is enabled",
    "0DTE paper trading is disabled",
    "Early alerts are ignored for normal Discord",
    "Bearish actionability is off",
    "Verified option puts are enabled for paper/actionable options only",
    "Stock momentum discovery policy:",
    "Paper portfolios are separated:",
    "Database is using persistent path /app/data",
  ]) {
    assert.ok(src.includes(phrase), `runtime summary missing: ${phrase}`);
  }
});

test("runtime status documents what each config gate can block", () => {
  const src = read("lib/runtime-status.ts");
  assert.ok(src.includes("options_alerts"));
  assert.ok(src.includes("stock_alerts"));
  assert.ok(src.includes("paper_trading"));
  assert.ok(src.includes("OPTIONS_PORTFOLIO_DELIVERY_ENABLED != 1 while INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1"));
});

test("runtime status is read-only (no writes)", () => {
  const src = stripStrings(read("lib/runtime-status.ts"));
  assert.ok(!/INSERT |UPDATE |DELETE |createDiscordDelivery|persist/i.test(src), "no writes");
});

test("runtime status route is auth-gated", () => {
  const route = read("app/api/runtime/status/route.ts");
  assert.ok(/checkApiToken\(req\)/.test(route));
  assert.ok(/return unauthorized\(\)/.test(route));
  assert.ok(/buildRuntimeStatus\(\)/.test(route));
});

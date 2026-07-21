import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyUniverse, filterDatedUniverse, estimateSeed } from "../lib/research/episode/universe.ts";
import { runReplaySeed } from "../lib/research/episode/seed.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ── universe fallback hierarchy ──────────────────────────────────────────────
test("provider_pit is valid only when entitled; else biased/invalid", () => {
  assert.deepEqual(classifyUniverse("provider_pit", ["A"], { providerPitAvailable: true }).validForVerdict, true);
  const no = classifyUniverse("provider_pit", ["A"], { providerPitAvailable: false });
  assert.equal(no.validForVerdict, false); assert.equal(no.survivorshipBias, true);
});

test("user_dated_file is valid when dated, biased when undated", () => {
  assert.equal(classifyUniverse("user_dated_file", ["A"], { dated: true }).validForVerdict, true);
  assert.equal(classifyUniverse("user_dated_file", ["A"], { dated: false }).validForVerdict, false);
});

test("current_symbols is ALWAYS survivorship-biased and INVALID for the verdict", () => {
  const c = classifyUniverse("current_symbols", ["A", "B"]);
  assert.equal(c.survivorshipBias, true);
  assert.equal(c.validForVerdict, false);
  assert.match(c.note, /SURVIVORSHIP-BIASED|EXPLORATORY/);
});

test("filterDatedUniverse keeps symbols active within the window (incl. later-delisted)", () => {
  const dated = [
    { symbol: "LIVE", activeFrom: "2019-01-01", activeTo: null },
    { symbol: "DELISTED", activeFrom: "2019-01-01", activeTo: "2021-06-01" },
    { symbol: "FUTURE", activeFrom: "2027-01-01", activeTo: null },
  ];
  const kept = filterDatedUniverse(dated, "2020-01-01", "2022-01-01").map((d) => d.symbol);
  assert.deepEqual(kept.sort(), ["DELISTED", "LIVE"], "delisted-in-window is kept; not-yet-listed excluded");
});

test("estimateSeed scales with symbols and span", () => {
  const e = estimateSeed(100, 365);
  assert.ok(e.estProviderCalls >= 100);
  assert.ok(e.estEpisodes > 0);
  assert.ok(e.estStorageMb >= 0);
});

// ── seed guardrails (no liveDb reached) ──────────────────────────────────────
test("kill switch halts before any work", async () => {
  const r = await runReplaySeed({ symbols: ["A"], from: "2024-01-01", to: "2024-02-01" }, { EPISODE_SEED_KILL: "1", HISTORICAL_REPLAY_ENABLED: "1", EPISODE_CAPTURE_ENABLED: "1" });
  assert.equal(r.ran, false); assert.match(r.skippedReason, /kill switch/);
});

test("flags off ⇒ hard no-op", async () => {
  const r = await runReplaySeed({ symbols: ["A"], from: "2024-01-01", to: "2024-02-01" }, {});
  assert.equal(r.ran, false); assert.match(r.skippedReason, /HISTORICAL_REPLAY_ENABLED/);
});

test("dry run returns an estimate, caps at maxSymbols, and does NOT seed", async () => {
  const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);
  const r = await runReplaySeed({ symbols, from: "2024-01-01", to: "2024-03-01", dryRun: true, maxSymbols: 5 }, { HISTORICAL_REPLAY_ENABLED: "1", EPISODE_CAPTURE_ENABLED: "1" });
  assert.equal(r.ran, false);
  assert.match(r.skippedReason, /dry_run/);
  assert.equal(r.estimate.symbols, 5, "maxSymbols cap applied");
  assert.equal(r.provenance.survivorshipBias, true, "defaults to biased until proven survivorship-free");
});

// ── admin route safety (secrets never exposed; token-gated) ──────────────────
test("entitlement route is token-gated, sends the key only in a header, prints no secret", () => {
  const src = read("app/api/research/entitlement/route.ts");
  assert.match(src, /checkApiToken/);
  assert.match(src, /Authorization: `Bearer \$\{key\}`/, "key goes in the Authorization header");
  assert.doesNotMatch(src, /apiKey=|\?token=|searchParams\.set\("apiKey"/, "key never placed in a URL/query");
  assert.doesNotMatch(src, /console\.log\([^)]*key/i, "the key is never logged");
  assert.match(src, /secretsPrinted: false/);
});

test("seed route is token-gated and defaults to dry-run (no accidental seeding)", () => {
  const src = read("app/api/research/seed/route.ts");
  assert.match(src, /checkApiToken/);
  assert.match(src, /body\.dryRun !== false/, "dry-run is the safe default");
  assert.match(src, /EXPLORATORY ONLY/, "survivorship-biased universe cannot GO");
});

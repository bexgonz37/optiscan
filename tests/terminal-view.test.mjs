import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fmtNum, fmtPct, fmtUsd, fmtVol, terminalContractLine, classificationTone, signTone,
  readinessState, heartbeatState, deriveStatusIndicators, filterMovers, sortRows, paperPortfolios,
} from "../lib/terminal-view.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ── formatting: missing data → N/A, never fabricated ─────────────────────────

test("formatters return N/A for missing data (never fabricate)", () => {
  assert.equal(fmtNum(null), "N/A");
  assert.equal(fmtPct(undefined), "N/A");
  assert.equal(fmtUsd(NaN), "N/A");
  assert.equal(fmtVol("x"), "N/A");
  assert.equal(fmtNum(1.239, 2), "1.24");
  assert.equal(fmtVol(1_200_000), "1.2M");
  assert.equal(fmtVol(500), "500");
});

// ── the EXACT one-line Discord contract format ───────────────────────────────

test("terminalContractLine matches the canonical Discord one-line", () => {
  const line = terminalContractLine({ ticker: "AAPL", strike: 322.5, side: "call", expiration: "2026-07-17", price: 1.70 });
  assert.equal(line, "$AAPL 17 JUL 26 $322.5 CALL $1.70");
});

test("terminalContractLine handles PUT and is null on missing fields", () => {
  assert.equal(terminalContractLine({ ticker: "NVDA", strike: 180, side: "put", expiration: "2026-07-18", price: 3.25 }), "$NVDA 18 JUL 26 $180 PUT $3.25");
  assert.equal(terminalContractLine({ ticker: "NVDA", strike: null, side: "call", expiration: "2026-07-18", price: 3 }), null);
  assert.equal(terminalContractLine({ ticker: "NVDA", strike: 180, side: "call", expiration: "bad", price: 3 }), null);
});

// ── color coding ─────────────────────────────────────────────────────────────

test("classification tones are color-coded distinctly", () => {
  assert.equal(classificationTone("FRESH_ACCELERATION"), "pos");
  assert.equal(classificationTone("EARLY_CONTINUATION"), "info");
  assert.equal(classificationTone("SLOW_GRINDER"), "warn");
  assert.equal(classificationTone("LATE_EXHAUSTION"), "neg");
  assert.equal(classificationTone("NOISY_ILLIQUID_SPIKE"), "muted");
  assert.equal(classificationTone(null), "muted");
});

test("sign tone is green/red/neutral", () => {
  assert.equal(signTone(1.2), "pos");
  assert.equal(signTone(-0.5), "neg");
  assert.equal(signTone(0), "muted");
  assert.equal(signTone(null), "muted");
});

// ── status bar states ────────────────────────────────────────────────────────

test("readiness + heartbeat states drive the status bar", () => {
  assert.equal(readinessState({ ready: true, blockedBy: [] }), "LIVE");
  assert.equal(readinessState({ ready: false, blockedBy: ["X"] }), "BLOCKED");
  assert.equal(readinessState(null), "OFFLINE");
  const now = 1_000_000;
  assert.equal(heartbeatState(true, now - 1000, now), "LIVE");
  assert.equal(heartbeatState(true, now - 300_000, now), "STALE");
  assert.equal(heartbeatState(false, now, now), "OFFLINE");
  assert.equal(heartbeatState(true, null, now), "STALE");
});

test("deriveStatusIndicators produces the full bar defensively (missing → OFFLINE/N/A)", () => {
  const ind = deriveStatusIndicators({});
  const labels = ind.map((i) => i.label);
  for (const l of ["SESSION", "SHA", "PROVIDER", "SCANNER", "OPTIONS", "DISCORD·STK", "DISCORD·OPT", "PAPER", "AI"]) {
    assert.ok(labels.includes(l), `missing ${l}`);
  }
  assert.equal(ind.find((i) => i.label === "SHA").value, "N/A");
  const ready = deriveStatusIndicators({ session: "regular", deploySha: "cd9d25e32", stockReady: { ready: true }, optionsReady: { ready: true }, scannerRunning: true, lastScanAtMs: Date.now(), nowMs: Date.now() });
  assert.equal(ready.find((i) => i.label === "SHA").value, "cd9d25e");
  assert.equal(ready.find((i) => i.label === "DISCORD·STK").state, "LIVE");
});

// ── movers filter + sort (pure) ──────────────────────────────────────────────

test("filterMovers by search / classification / actionable", () => {
  const rows = [
    { symbol: "AAPL", classification: "FRESH_ACCELERATION", stockPolicyOk: true },
    { symbol: "TSLA", classification: "SLOW_GRINDER", stockPolicyOk: false },
    { symbol: "AMD", classification: "FRESH_ACCELERATION", stockPolicyOk: false },
  ];
  assert.equal(filterMovers(rows, { search: "aa" }).length, 1);
  assert.equal(filterMovers(rows, { classification: "FRESH_ACCELERATION" }).length, 2);
  assert.equal(filterMovers(rows, { actionable: "actionable" }).length, 1);
  assert.equal(filterMovers(rows, { actionable: "rejected" }).length, 2);
});

test("sortRows is numeric-aware and pushes nulls last regardless of direction", () => {
  const rows = [{ v: 3 }, { v: null }, { v: 10 }, { v: 1 }];
  assert.deepEqual(sortRows(rows, "v", "desc").map((r) => r.v), [10, 3, 1, null]);
  assert.deepEqual(sortRows(rows, "v", "asc").map((r) => r.v), [1, 3, 10, null]);
});

// ── paper portfolios ─────────────────────────────────────────────────────────

test("paperPortfolios returns Primary / Challenge / Stock Day Trader tabs", () => {
  const ports = paperPortfolios({ account: { equity: 5000 }, summary: { totalPnlDollars: 120 }, challenge: { enabled: true, equity: 10500, realizedPnl: 500 } });
  assert.equal(ports.length, 3);
  assert.equal(ports[0].key, "PRIMARY");
  assert.equal(ports[0].equity, 5000);
  assert.equal(ports[1].key, "CHALLENGE");
  assert.equal(ports[1].enabled, true);
  assert.equal(ports[2].key, "STOCK_DAY_TRADER");
  assert.equal(ports[2].enabled, false);
});

// ── page-level guarantees (source assertions) ────────────────────────────────

test("terminal page reuses existing authenticated GET APIs only (no writes, no new provider polling)", () => {
  const src = read("app/terminal/page.tsx");
  // Reuses existing endpoints.
  for (const api of ["/api/scanner/live", "/api/runtime/status", "/api/diagnostics/funnel", "/api/paper/trades", "/api/alerts"]) {
    assert.ok(src.includes(api), `must reuse ${api}`);
  }
  // Auth via the shared client token helper.
  assert.match(src, /scanHeaders\(\)/, "uses the shared auth header helper");
  // No write verbs / trade / discord send from the page.
  assert.doesNotMatch(src, /method:\s*["'](POST|PUT|DELETE|PATCH)["']/i, "terminal is read-only");
  assert.doesNotMatch(src, /discord\/test|createPaperTrade|place_order|placeOrder/i, "no trade/discord actions");
  // Live options chain is loaded on explicit user action, not on the poll loop.
  assert.match(src, /loadChain/, "chain load is a discrete action");
  assert.doesNotMatch(src, /setInterval\([^)]*options\//, "options chain is not polled");
});

test("terminal page wires keyboard navigation without single-key write actions", () => {
  const src = read("app/terminal/page.tsx");
  assert.match(src, /addEventListener\("keydown"/, "keyboard handler present");
  assert.match(src, /e\.key === "\/"/, "/ focuses search");
  assert.match(src, /"Escape"/, "Escape clears");
  // Enter only drills down (loadChain), never sends a trade/Discord.
  assert.match(src, /e\.key === "Enter"[^]*loadChain/, "Enter is drill-down only");
});

test("terminal uses a scoped CSS module (no Bloomberg branding), dark theme", () => {
  const css = read("app/terminal/terminal.module.css");
  assert.doesNotMatch(css, /bloomberg/i, "no Bloomberg branding");
  assert.match(css, /--tt-bg/, "dark terminal variables");
  assert.match(css, /@media \(max-width: 900px\)/, "responsive/mobile rules");
  const page = read("app/terminal/page.tsx");
  assert.doesNotMatch(page, /bloomberg/i, "no Bloomberg branding on the page");
});

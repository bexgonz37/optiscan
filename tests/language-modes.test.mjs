import test from "node:test";
import assert from "node:assert/strict";
import {
  privateLabel,
  privateLabel0dte,
  publicLabel,
  publicLabel0dte,
  privateSideHint,
  riskLabel,
  suggestedAction,
  directionLabel,
  containsBannedPublicLanguage,
  alertKindExplanation,
  sessionGroupLabel,
  UI_DIRECTIVE_LABELS,
  uiDirectiveLabel,
  publicizeDirectiveText,
  showOrderTicket,
  PUBLIC_MODE_DISCLAIMER,
} from "../lib/language-modes.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("banned-language checker catches every unsafe phrase", () => {
  const unsafe = [
    "Buy now before it rips", "This is a STRONG BUY", "take this trade",
    "Just buy calls here", "buy puts on this", "guaranteed winner",
    "easy money setup", "copy this trade", "time to sell everything",
    "Take this call", "take this put", "take calls here", "take puts now", "sell now",
  ];
  for (const s of unsafe) assert.equal(containsBannedPublicLanguage(s), true, s);
});

test("banned checker passes safe education wording", () => {
  for (const s of [
    "Bullish Momentum Alert: SPY",
    "Bearish scanner alert — momentum setup detected",
    "0DTE Watchlist Candidate",
    "Educational market signal only. Not financial advice.",
    "buyout rumors circulating", // word boundary: 'buyout' is not 'buy'
  ]) assert.equal(containsBannedPublicLanguage(s), false, s);
});

test("SPEC: private 0DTE labels — call/put watch wording, flags override", () => {
  assert.equal(privateLabel0dte({ bias: "long_call_candidate", setupScore: 91 }), "A+ 0DTE Call Watch");
  assert.equal(privateLabel0dte({ bias: "long_call_candidate", setupScore: 78 }), "0DTE Call Watch");
  assert.equal(privateLabel0dte({ bias: "long_put_candidate", setupScore: 92 }), "A+ 0DTE Put Watch");
  assert.equal(privateLabel0dte({ bias: "wait_for_pullback", setupScore: 70 }), "Wait for Pullback");
  assert.equal(privateLabel0dte({ bias: "chase_risk", setupScore: 70 }), "Chase Risk");
  assert.equal(privateLabel0dte({ bias: "no_clean_setup", setupScore: 70 }), "Too Choppy");
  assert.equal(privateLabel0dte({ bias: "watch_only", setupScore: 70, direction: "bullish" }), "Bullish 0DTE Setup");
  assert.equal(privateLabel0dte({ bias: "watch_only", setupScore: 70, direction: "bearish" }), "Bearish 0DTE Setup");
  assert.equal(privateLabel0dte({ bias: "long_call_candidate", setupScore: 95, riskFlags: ["Spread Too Wide"] }), "Spread Too Wide");
  assert.equal(privateLabel0dte({ bias: "long_call_candidate", setupScore: 95, riskFlags: ["Premium Too Expensive"] }), "Premium Too Expensive");
});

test("SPEC: public 0DTE labels are directional but never call/put and always safe", () => {
  assert.equal(publicLabel0dte({ direction: "bullish", setupScore: 88 }), "Bullish Momentum Alert");
  assert.equal(publicLabel0dte({ direction: "bearish", setupScore: 75 }), "Bearish Momentum Alert");
  assert.equal(publicLabel0dte({ direction: "choppy", setupScore: 65 }), "0DTE Watchlist Candidate");
  assert.equal(publicLabel0dte({ direction: "bullish", setupScore: 55 }), "Momentum Setup Detected");
  assert.equal(publicLabel0dte({ direction: "bullish", setupScore: 20 }), "Educational Only");
  for (const d of ["bullish", "bearish", "choppy"]) for (const s of [95, 75, 62, 55, 20]) {
    const label = publicLabel0dte({ direction: d, setupScore: s });
    assert.equal(containsBannedPublicLanguage(label), false, label);
    assert.ok(!/call|put/i.test(label), `public label leaks side: ${label}`);
  }
});

test("legacy label bands still work for swing/manual alerts", () => {
  assert.equal(privateLabel(95), "A+ Setup");
  assert.equal(privateLabel(65), "Needs Confirmation");
  assert.equal(publicLabel(85), "High-Quality Scanner Alert");
  assert.equal(privateSideHint("call"), "Possible Call Setup");
});

test("riskLabel / suggestedAction / directionLabel", () => {
  assert.equal(riskLabel(10), "Low Risk");
  assert.equal(riskLabel(80), "Extreme Risk / Avoid");
  assert.equal(suggestedAction(85, 30), "Watch");
  assert.equal(suggestedAction(90, 80), "Skip");
  assert.equal(directionLabel("choppy"), "Volatile / Unclear");
});

test("alertKindExplanation distinguishes stock vs 0DTE by session", () => {
  assert.match(alertKindExplanation({ asset_class: "stock", session: "premarket" }), /Premarket share/i);
  assert.match(alertKindExplanation({ asset_class: "stock", session: "afterhours" }), /After-hours share/i);
  assert.match(alertKindExplanation({ asset_class: "options", session: "regular" }), /0DTE option/i);
  assert.match(alertKindExplanation({ asset_class: "options", session: "premarket" }), /before the open/i);
  for (const s of [
    alertKindExplanation({ asset_class: "stock", session: "premarket" }),
    alertKindExplanation({ asset_class: "options", session: "regular" }),
  ]) assert.equal(containsBannedPublicLanguage(s), false, s);
});

test("sessionGroupLabel for history dividers", () => {
  assert.equal(sessionGroupLabel("premarket", "stock"), "Premarket · Shares");
  assert.equal(sessionGroupLabel("afterhours", "stock"), "After hours · Shares");
  assert.equal(sessionGroupLabel("regular", "options"), "Regular hours · 0DTE options");
});


// ── UI language-mode enforcement (audit P0-4/T5) ─────────────────────────────

test("every public UI directive label passes the banned-language guard", () => {
  for (const [kind, label] of Object.entries(UI_DIRECTIVE_LABELS.public)) {
    assert.equal(containsBannedPublicLanguage(label), false, `public label for ${kind} leaked: "${label}"`);
  }
});

test("private UI labels keep the owner's directive wording", () => {
  assert.equal(uiDirectiveLabel("buy_call", "private"), "BUY CALL");
  assert.equal(uiDirectiveLabel("buy_put", "private"), "BUY PUT");
  assert.equal(uiDirectiveLabel("long", "private"), "LONG");
  assert.equal(uiDirectiveLabel("short", "private"), "SHORT");
});

test("public UI labels use the audit's replacement table", () => {
  assert.equal(uiDirectiveLabel("buy_call", "public"), "Call Momentum Watch");
  assert.equal(uiDirectiveLabel("buy_put", "public"), "Put Momentum Watch");
  assert.equal(uiDirectiveLabel("long", "public"), "Bullish Share Momentum Watch");
  assert.equal(uiDirectiveLabel("short", "public"), "Bearish Share Momentum Watch");
  assert.equal(uiDirectiveLabel("trade_tier", "public"), "High-conviction watch");
});

test("publicizeDirectiveText scrubs every known directive headline", () => {
  const samples = [
    "BUY CALL",
    "BUY PUT",
    "BUY CALL/PUT when TRADE fires",
    "Buy stock \u2191",
    "Bet stock \u2193",
    "Buy call option ripping",
    "shares-only LONG/SHORT hero",
  ];
  for (const s of samples) {
    const out = publicizeDirectiveText(s);
    assert.equal(containsBannedPublicLanguage(out), false, `"${s}" -> "${out}" still banned`);
  }
});

test("publicizeDirectiveText backstop collapses unknown directives to a neutral label", () => {
  assert.equal(publicizeDirectiveText("strong buy right now"), "Momentum Watch");
});

test("order-ticket UI is private-mode only", () => {
  assert.equal(showOrderTicket("private"), true);
  assert.equal(showOrderTicket("public"), false);
});

test("public disclaimer exists and is itself banned-language clean", () => {
  assert.ok(PUBLIC_MODE_DISCLAIMER.length > 40);
  assert.equal(containsBannedPublicLanguage(PUBLIC_MODE_DISCLAIMER), false);
  assert.match(PUBLIC_MODE_DISCLAIMER, /financial advice/i);
});

test("flagged components are wired to language mode (source spec)", () => {
  const mustBeModeAware = [
    "components/AlertsCommandCenter.tsx",
    "components/CompactStatusLine.tsx",
    "components/SessionBanner.tsx",
    "components/OptiscanLiveView.tsx",
    "components/DetailPanel.tsx",
    "components/TradeVerdictHero.tsx",
    "components/VerdictPreviewBlock.tsx",
    "components/HelpSection.tsx",
    "app/alerts/page.tsx",
  ];
  for (const f of mustBeModeAware) {
    const src = readFileSync(join(repoRoot, f), "utf8");
    const wired = src.includes("useLanguageMode") || src.includes('mode === "public"');
    assert.ok(wired, `${f} must consume the language mode`);
  }
});

test("app layout renders the compliance footer", () => {
  const src = readFileSync(join(repoRoot, "app/layout.tsx"), "utf8");
  assert.ok(src.includes("ComplianceFooter"), "layout must mount ComplianceFooter");
});

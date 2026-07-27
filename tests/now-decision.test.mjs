import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveOperatingMode,
  resolveOperatingModeFromHealth,
  heroTitleForMode,
  reviewSessionFromMode,
} from "../lib/dashboard/operating-mode.ts";
import { classifySetupDecision, DECISION_LABEL } from "../lib/dashboard/setup-decision.ts";
import { buildNowReviewSnapshot, modeFromReviewSession } from "../lib/dashboard/demo-now-fixtures.ts";
import { DEMO_OVERNIGHT_PLAN } from "../lib/dashboard/demo-overnight-fixtures.ts";
import { overnightPlanDelta } from "../lib/research/overnight/next-session-plan.ts";
import {
  formatEodWatchlist,
  formatPremarketPlan,
  formatMarketOpenConfirm,
  demoDiscordMessages,
} from "../lib/notifications/owner-research-notify.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const RESEARCH_LABELS = {
  premarket: "PREMARKET · RESEARCH ACTIVE",
  afterhours: "AFTER HOURS · RESEARCH ACTIVE",
  overnight: "OVERNIGHT · RESEARCH ACTIVE",
  weekend: "WEEKEND · PLANNING ACTIVE",
};

test("closed-but-healthy never shows SYSTEM OFFLINE", () => {
  for (const session of ["premarket", "afterhours", "overnight", "weekend"]) {
    const r = resolveOperatingMode({
      sessionOverride: session,
      monitorAlive: false,
      providerConfigured: false,
      providerHealthy: false,
      dbOk: true,
    });
    assert.notEqual(r.mode, "SYSTEM_OFFLINE");
    assert.equal(r.label, RESEARCH_LABELS[session]);
    assert.equal(r.optionsExecutableWindow, false);
  }
});

test("regular session live when healthy", () => {
  const r = resolveOperatingMode({
    sessionOverride: "regular",
    monitorAlive: true,
    providerConfigured: true,
    providerHealthy: true,
    dbOk: true,
  });
  assert.equal(r.mode, "REGULAR_SESSION_LIVE");
  assert.equal(r.label, "LIVE · OPTIONS SESSION");
  assert.equal(r.optionsExecutableWindow, true);
  assert.equal(heroTitleForMode(r.mode), "BEST CURRENT SETUP");
});

test("true failure is SYSTEM OFFLINE", () => {
  const r = resolveOperatingMode({ systemOffline: true });
  assert.equal(r.mode, "SYSTEM_OFFLINE");
  assert.match(r.label, /SYSTEM OFFLINE/);
});

test("regular session with dead monitor is SYSTEM OFFLINE", () => {
  const r = resolveOperatingMode({
    nowMs: Date.parse("2026-07-27T15:00:00-04:00"),
    monitorAlive: false,
    providerConfigured: true,
    providerHealthy: true,
    dbOk: true,
  });
  assert.equal(r.mode, "SYSTEM_OFFLINE");
});

test("after-hours with dead monitor stays research (not offline)", () => {
  const r = resolveOperatingMode({
    nowMs: Date.parse("2026-07-27T18:00:00-04:00"),
    monitorAlive: false,
    providerConfigured: true,
    providerHealthy: false,
    dbOk: true,
  });
  assert.equal(r.mode, "AFTER_HOURS_RESEARCH");
  assert.equal(r.label, RESEARCH_LABELS.afterhours);
});

test("health resolver: afterhours loop down matches research label", () => {
  const r = resolveOperatingModeFromHealth(
    { ok: false, loopRunning: false, session: "afterhours", keyPresent: true },
    { nowMs: Date.parse("2026-07-27T18:00:00-04:00") },
  );
  assert.equal(r.label, RESEARCH_LABELS.afterhours);
  assert.notEqual(r.mode, "SYSTEM_OFFLINE");
});

test("health resolver: fetch failure is SYSTEM OFFLINE", () => {
  const r = resolveOperatingModeFromHealth(null, { fetchFailed: true });
  assert.equal(r.mode, "SYSTEM_OFFLINE");
});

test("health resolver: UI review session wins over unhealthy loop", () => {
  const r = resolveOperatingModeFromHealth(
    { ok: false, loopRunning: false, session: "regular", keyPresent: true },
    { sessionOverride: "afterhours" },
  );
  assert.equal(r.label, RESEARCH_LABELS.afterhours);
});

test("review fixtures and health resolver share labels for every session", () => {
  for (const session of ["regular", "premarket", "afterhours", "overnight", "weekend"]) {
    const mode = modeFromReviewSession(session);
    const snap = buildNowReviewSnapshot(mode);
    const fromHealth = resolveOperatingModeFromHealth(null, { sessionOverride: session });
    assert.equal(snap.operatingLabel, fromHealth.label, `${session} label mismatch`);
    assert.equal(snap.operatingMode, fromHealth.mode, `${session} mode mismatch`);
  }
});

test("shell and mobile use canonical health resolver", () => {
  const shell = read("components/AxiomShell.tsx");
  const mobile = read("components/MobileBottomNav.tsx");
  assert.match(shell, /resolveOperatingModeFromHealth/);
  assert.match(mobile, /resolveOperatingModeFromHealth/);
  assert.ok(!/systemOffline:\s*!loopUp/.test(shell));
});

test("TRADE NOW only in regular session with fresh executable contract", () => {
  const live = classifySetupDecision({
    operatingMode: "REGULAR_SESSION_LIVE",
    systemAction: "SEND",
    entryStatusLabel: "ACTIONABLE NOW",
    status: "ACTIONABLE_NOW",
    quoteFreshness: "fresh",
    contractReady: true,
    hasFreshBidAsk: true,
    actionable: true,
    spreadPct: 7,
  });
  assert.equal(live.state, "TRADE_NOW");
  assert.equal(live.executable, true);

  const after = classifySetupDecision({
    operatingMode: "AFTER_HOURS_RESEARCH",
    systemAction: "SEND",
    entryStatusLabel: "ACTIONABLE NOW",
    status: "ACTIONABLE_NOW",
    quoteFreshness: "fresh",
    contractReady: true,
    hasFreshBidAsk: true,
    actionable: true,
    spreadPct: 7,
  });
  assert.equal(after.state, "TOMORROW");
  assert.equal(after.executable, false);
  assert.equal(after.verifyContractAfterOpen, true);
  assert.match(after.quoteLabel, /STALE/);
});

test("AVOID for blocked / wide spread", () => {
  const d = classifySetupDecision({
    operatingMode: "REGULAR_SESSION_LIVE",
    systemAction: "BLOCK",
    primaryBlockingReason: "spread_too_wide",
    spreadPct: 28,
  });
  assert.equal(d.state, "AVOID");
  assert.equal(d.label, DECISION_LABEL.AVOID);
});

test("ALMOST READY surfaces one confirmation", () => {
  const d = classifySetupDecision({
    operatingMode: "REGULAR_SESSION_LIVE",
    systemAction: "WATCH",
    status: "NEAR_TRIGGER",
    quoteFreshness: "fresh",
    contractReady: true,
    hasFreshBidAsk: true,
    waitFor: "Hold above VWAP for 2 bars",
  });
  assert.equal(d.state, "ALMOST_READY");
  assert.equal(d.confirmationNeeded, "Hold above VWAP for 2 bars");
});

test("review fixtures cover all four decision states in regular mode", () => {
  const snap = buildNowReviewSnapshot("REGULAR_SESSION_LIVE");
  const states = new Set(snap.setups.map((s) => s.state));
  assert.ok(states.has("TRADE_NOW"));
  assert.ok(states.has("ALMOST_READY"));
  assert.ok(states.has("TOMORROW"));
  assert.ok(states.has("AVOID"));
  assert.equal(snap.heroTitle, "BEST CURRENT SETUP");
  assert.equal(snap.operatingLabel, "LIVE · OPTIONS SESSION");
});

test("after-hours review fixtures never include TRADE NOW", () => {
  const snap = buildNowReviewSnapshot(modeFromReviewSession("afterhours"));
  assert.ok(snap.setups.every((s) => s.state !== "TRADE_NOW"));
  assert.equal(snap.heroTitle, "TOP SETUP FOR NEXT SESSION");
  assert.equal(snap.operatingLabel, RESEARCH_LABELS.afterhours);
});

test("reviewSessionFromMode round-trips review sessions", () => {
  for (const session of ["regular", "premarket", "afterhours", "overnight", "weekend"]) {
    const mode = modeFromReviewSession(session);
    assert.equal(reviewSessionFromMode(mode), session === "overnight" ? "overnight" : session);
  }
});

test("owner Discord templates never say buy now", () => {
  const msgs = demoDiscordMessages(DEMO_OVERNIGHT_PLAN);
  for (const [k, v] of Object.entries(msgs)) {
    if (k === "intraday_actionable") continue;
    assert.ok(!/buy now/i.test(v), `${k} must not say buy now`);
    if (k !== "intraday_actionable") {
      assert.ok(/VERIFY CONTRACT|revalidate|Research only|not executable/i.test(v), `${k} needs revalidation language`);
    }
  }
  assert.match(formatEodWatchlist(DEMO_OVERNIGHT_PLAN), /VERIFY CONTRACT AFTER OPTIONS OPEN/);
  assert.match(formatPremarketPlan(DEMO_OVERNIGHT_PLAN), /VERIFY CONTRACT AFTER OPTIONS OPEN/);
  assert.match(formatMarketOpenConfirm(DEMO_OVERNIGHT_PLAN), /Do not use prior-session quotes/);
});

test("overnight plan delta detects symbol add", () => {
  const next = {
    ...DEMO_OVERNIGHT_PLAN,
    recommendations: [
      ...DEMO_OVERNIGHT_PLAN.recommendations,
      { ...DEMO_OVERNIGHT_PLAN.recommendations[0], symbol: "AMD", rank: 9 },
    ],
  };
  const d = overnightPlanDelta(DEMO_OVERNIGHT_PLAN, next);
  assert.equal(d.changed, true);
  assert.ok(d.reasons.some((r) => /AMD/.test(r)));
});

test("OWNER_RESEARCH_DISCORD_ENABLED defaults off in example env", () => {
  const env = read(".env.railway.example");
  assert.match(env, /OWNER_RESEARCH_DISCORD_ENABLED=0/);
  assert.match(env, /PAPER_0DTE_RESEARCH_ENABLED=0/);
});

test("primary nav is NOW RESEARCH PAPER MORE", () => {
  const shell = read("components/AxiomShell.tsx");
  assert.match(shell, /label: "NOW"/);
  assert.match(shell, /label: "RESEARCH"/);
  assert.match(shell, /label: "PAPER"/);
  assert.match(shell, /label: "MORE"/);
  assert.ok(!/label: "Command Center"/.test(shell));
  const mobile = read("components/MobileBottomNav.tsx");
  assert.match(mobile, /label: "NOW"/);
  assert.match(mobile, /MoreDrawer/);
});

test("/now redirects to / and home renders NowPage", () => {
  assert.match(read("app/now/page.tsx"), /redirect\("\/"\)/);
  assert.match(read("app/page.tsx"), /NowPage/);
  assert.match(read("components/NowPage.tsx"), /BEST CURRENT SETUP|heroTitle/);
});

test("ui review session key is supported", () => {
  const ui = read("lib/dashboard/ui-review.ts");
  assert.match(ui, /optiscan:uiReviewSession/);
  assert.match(ui, /getUiReviewSession/);
});

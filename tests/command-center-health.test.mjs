import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realOptionExit, conservativeEntryFill } from "../lib/research/options/paper.ts";
import { overviewAuthFailed, primaryWorkingNowLines } from "../lib/dashboard/command-center-health.ts";
import {
  aggregatePaperSample,
  mapOppStatus,
  mapSystemChips,
  readinessProgressPct,
  sampleSizeLabel,
} from "../lib/dashboard/command-center-view.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("realOptionExit uses conservative bid-side mark on option premium", () => {
  const ex = realOptionExit(5.5, 5.4, 5.6);
  assert.equal(ex.exitFill, 5.44);
  assert.equal(ex.returnPct, +(((5.44 - 5.5) / 5.5) * 100).toFixed(4));
  assert.ok(ex.returnPct < 0);
});

test("conservativeEntryFill pays toward ask — never naive mid on wide quotes", () => {
  const fill = conservativeEntryFill(1.0, 1.2);
  assert.equal(fill, 1.16);
  assert.ok(fill > 1.1);
});

test("AAPL-style 60m return matches ((markUsed-entry)/entry)*100", () => {
  const entry = 5.5;
  const exitBid = 5.2;
  const exitAsk = 5.4;
  const mid = (exitBid + exitAsk) / 2;
  const markUsed = +(mid - (mid - exitBid) * 0.6).toFixed(4);
  const ex = realOptionExit(entry, exitBid, exitAsk);
  assert.equal(ex.exitFill, markUsed);
  assert.equal(ex.returnPct, +(((markUsed - entry) / entry) * 100).toFixed(4));
});

test("unauthorized overview payload is detected so UI does not invent unknown health", () => {
  assert.equal(overviewAuthFailed(null), true);
  assert.equal(overviewAuthFailed({ error: "Unauthorized" }), true);
  assert.equal(overviewAuthFailed({ ok: false, status: 401 }), true);
  assert.equal(overviewAuthFailed({ independent_options: { monitorAlive: true }, provider: { configured: true }, scanner: {} }), false);
});

test("command-center snapshot with faults is not treated as auth failure", () => {
  assert.equal(
    overviewAuthFailed({
      ok: false,
      faults: ["pipeline: boom"],
      sourceEndpoint: "/api/command-center",
      independent: { monitorAlive: true },
    }),
    false,
  );
});

test("primary working-now lines never claim Polygon missing when independent health is good", () => {
  const lines = primaryWorkingNowLines({
    authFailed: false,
    discordFail: 0,
    independent: {
      monitorAlive: true,
      runMode: "RUNNING_IN_WORKER",
      session: "REGULAR_SESSION",
      polygonConfigured: true,
      polygonHealthy: true,
      webhookConfigured: true,
      labels: {
        monitor: "Independent options monitor is running in the worker process",
        session: "Current options session: REGULAR_SESSION",
        polygon: "Polygon/Massive provider configured and healthy in worker",
      },
      sources: { monitor: "Database heartbeat", session: "Session guard", polygon: "Environment configuration" },
    },
    graderRunning: true,
    contentEnabled: false,
    latestAlertLabel: "AAPL · healthy",
  });
  assert.ok(lines.some((l) => /worker process/i.test(l.text) && l.tone === "ok"));
  assert.ok(lines.some((l) => /REGULAR_SESSION/.test(l.text) && l.tone === "ok"));
  assert.ok(lines.some((l) => /Polygon/.test(l.text) && l.tone === "ok"));
  assert.ok(!lines.some((l) => /not configured|API key is not/i.test(l.text)));
  assert.ok(!lines.some((l) => /Supervisor/.test(l.text)), "supervisor must not appear in primary section");
});

test("system chips map live health without unknown jargon", () => {
  const chips = mapSystemChips({
    authFailed: false,
    independent: {
      monitorAlive: true,
      runMode: "RUNNING_IN_THIS_PROCESS",
      session: "REGULAR_SESSION",
      polygonConfigured: true,
      polygonHealthy: true,
      webhookConfigured: true,
    },
    graderRunning: true,
    graderLastCycleAgeMs: 5_000,
  });
  assert.ok(chips.some((c) => c.label === "OPTISCAN" && c.state === "LIVE" && c.tone === "ok"));
  assert.ok(chips.some((c) => c.label === "Polygon" && c.state === "CONNECTED"));
  assert.ok(!chips.some((c) => /unknown/i.test(c.state)));
});

test("ui review system chips never mix contradictory live states", () => {
  const chips = mapSystemChips({ authFailed: false, independent: {}, uiReview: true });
  assert.deepEqual(
    chips.map((c) => `${c.label}:${c.state}`),
    ["SYSTEM:DEMO", "SESSION:REVIEW", "MONITOR:DEMO", "PROVIDER:SEEDED", "DISCORD:NOT TESTED", "GRADER:DEMO"],
  );
});

test("opportunity status mapping covers T1 HIT and CLOSED", () => {
  assert.equal(mapOppStatus({ paperStatus: "EXITED" }), "CLOSED");
  assert.equal(mapOppStatus({ paperStatus: "ENTERED", t1Hit: true }), "T1_HIT");
  assert.equal(mapOppStatus({ paperStatus: "ENTERED", latestMarkReturnPct: 2 }), "CONFIRMED");
});

test("aggregatePaperSample computes extrema and rates", () => {
  const agg = aggregatePaperSample([
    { paperStatus: "ENTERED", mfePct: 10, maePct: -2, t1Hit: true, stopHit: false, latestMarkReturnPct: 3 },
    { paperStatus: "EXITED", mfePct: 5, maePct: -8, t1Hit: false, stopHit: true, returnPct: -4 },
  ]);
  assert.equal(agg.bestMfePct, 10);
  assert.equal(agg.worstMaePct, -8);
  assert.equal(agg.t1HitRate, 0.5);
  assert.equal(agg.stopHitRate, 0.5);
  assert.equal(agg.openCount, 1);
  assert.equal(agg.closedCount, 1);
});

test("sample size label and readiness progress are presentational", () => {
  assert.equal(sampleSizeLabel(2), "Based on 2 graded trades");
  assert.ok(readinessProgressPct({ deliveredSent: 3, deliveredLinked: 3, gradedSample: 2, paperLinkRate: 1 }, false) > 0);
  assert.equal(readinessProgressPct({}, true), 100);
});

test("command-center route passes DB handle to buildWhyNoAlertsDiagnostic", () => {
  const route = readFileSync(join(root, "app/api/command-center/route.ts"), "utf8");
  assert.ok(
    /buildWhyNoAlertsDiagnostic\(\s*db\s*,/.test(route),
    "must pass sqlite db, not { getDb } deps bag (causes a.prepare is not a function)",
  );
  assert.ok(!/buildWhyNoAlertsDiagnostic\(\s*\{\s*getDb/.test(route));
  assert.ok(/equityCurve/.test(route));
  assert.ok(/aiOverviewOnDb/.test(route));
});

test("Command Center terminal UI uses authenticated snapshot and trader panels", () => {
  const cc = readFileSync(join(root, "components/CommandCenter.tsx"), "utf8");
  assert.ok(/\/api\/command-center/.test(cc));
  assert.ok(/scanHeaders\(\)/.test(cc));
  assert.ok(/Highest-quality setups/.test(cc));
  assert.ok(/Delivered equity|Open positions/.test(cc));
  assert.ok(/Pipeline funnel|Pipeline/.test(cc));
  assert.ok(/Live accounts/.test(cc));
  assert.ok(/Paid-beta|readiness/i.test(cc));
  assert.ok(/cc-term-optional|Optional systems/.test(cc));
  assert.ok(/AI advisory/.test(cc));
  assert.ok(!/not running in this process/.test(cc));
  assert.ok(/commitShort|Commit/.test(cc));
  assert.ok(/rankedSetups/.test(cc));
});

test("PRODUCT nav matches control-room destinations", () => {
  const shell = readFileSync(join(root, "components/AxiomShell.tsx"), "utf8");
  assert.ok(/Live Options/.test(shell));
  assert.ok(/Paper & Research/.test(shell));
  assert.ok(/0DTE Research/.test(shell));
  assert.ok(/Quant Lab/.test(shell));
  assert.ok(/Content Drafts/.test(shell));
  assert.ok(/ADVANCED_NAV[\s\S]*Shadow Soak/.test(shell));
  assert.ok(/PRODUCT_NAV[\s\S]*Command Center/.test(shell));
});

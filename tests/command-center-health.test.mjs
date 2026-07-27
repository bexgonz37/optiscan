import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realOptionExit, conservativeEntryFill } from "../lib/research/options/paper.ts";
import { overviewAuthFailed, primaryWorkingNowLines } from "../lib/dashboard/command-center-health.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("realOptionExit uses conservative bid-side mark on option premium", () => {
  // mid=5.5, exitFill = mid - 0.6*(mid-bid) = 5.5 - 0.6*(5.5-5.4) = 5.44
  const ex = realOptionExit(5.5, 5.4, 5.6);
  assert.equal(ex.exitFill, 5.44);
  assert.equal(ex.returnPct, +(((5.44 - 5.5) / 5.5) * 100).toFixed(4));
  assert.ok(ex.returnPct < 0);
});

test("conservativeEntryFill pays toward ask — never naive mid on wide quotes", () => {
  const fill = conservativeEntryFill(1.0, 1.2);
  // mid=1.1; fill = 1.1 + 0.6*(1.2-1.1) = 1.16
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

test("Command Center uses authenticated command-center endpoint and collapses stock", () => {
  const cc = readFileSync(join(root, "components/CommandCenter.tsx"), "utf8");
  assert.ok(/\/api\/command-center/.test(cc));
  assert.ok(/scanHeaders\(\)/.test(cc));
  assert.ok(/What is working right now/.test(cc));
  assert.ok(/Future paid-beta readiness/.test(cc));
  assert.ok(/Optional stock scanner/.test(cc));
  assert.ok(!/not running in this process/.test(cc));
  assert.ok(/Last refreshed/.test(cc));
  assert.ok(/commitShort|Commit:/.test(cc));
});

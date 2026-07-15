import test from "node:test";
import assert from "node:assert/strict";
import { buildNightlySummary } from "../lib/ai/nightly-summary.ts";
import { buildNightlyRecapMessage, deliverNightlyRecapOnDb } from "../lib/ai/recap.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }
const skip = Database ? false : "better-sqlite3 unavailable";

const NOW = Date.parse("2026-07-14T00:30:00Z");
const CFG = { recapModel: "claude-haiku-4-5" };

function summary() {
  return buildNightlySummary({
    tradingDay: "2026-07-13",
    periodStartMs: null,
    periodEndMs: NOW,
    outcomes: [
      {
        strategy: "swing",
        direction: "CALL",
        dteAtEntry: 4,
        entrySession: "regular",
        entryTimeMs: Date.parse("2026-07-13T14:00:00Z"),
        terminalKind: "STOP",
        grade: "LOSS",
        gradingStatus: "GRADED",
        returnPct: -20,
        opportunityGrade: "HIT",
        peakFavorablePct: 32,
      },
    ],
    candidates: [
      { status: "REJECTED", rejectReason: "wide spread", entryState: "ACTIONABLE", confidenceTier: "HIGH", direction: "CALL" },
    ],
    live: { available: true, actionableAlerts: 1, nearMissCount: 2, lateCalloutCount: 0, crossingRescues: 1, avgTriggerToDiscordMs: 1500 },
    options: {
      cycles: 4,
      setupsQualified: 2,
      chainsFetched: 2,
      canonical: 1,
      emitted: 1,
      delivered: 0,
      emittedButUndelivered: 1,
      configBlockedCycles: 1,
      topDeliveryGateReason: "DISCORD_SUPERVISOR_SEND off",
      diagnosis: "delivery_config_blocked",
    },
    momentum: { total: 3, sent: 1, rescued: 1, nearMisses: 2, rejected: 0, extendedRejections: 0, staleRejected: 0, avgLatencyMs: 1200 },
  });
}

test("nightly recap message is deterministic and links to AI Lab", () => {
  const msg = buildNightlyRecapMessage(summary(), { topLesson: "Exit management leak", reportUrl: "https://app.example/ai" });
  assert.match(msg, /OptiScan Nightly Review/);
  assert.match(msg, /Trades: 1 \| Wins: 0 \| Losses: 1/);
  assert.match(msg, /Options candidates blocked: 1/);
  assert.match(msg, /Options delivery blocked by config: DISCORD_SUPERVISOR_SEND off/);
  assert.match(msg, /Top lesson: Exit management leak/);
  assert.match(msg, /Full report: https:\/\/app\.example\/ai/);
  assert.doesNotMatch(msg, /ANTHROPIC_API_KEY|DISCORD_WEBHOOK|SCAN_API_TOKEN/);
});

test("nightly recap delivery uses only the private recap webhook", { skip }, async () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE ai_job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL, model TEXT, status TEXT NOT NULL,
      error_category TEXT, error TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
      diagnostic_json TEXT,
      month_key TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
    CREATE TABLE ai_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, dedup_key TEXT, finding_type TEXT,
      summary TEXT, evidence_json TEXT, sample_size INTEGER, status TEXT, confidence TEXT,
      decision_state TEXT, occurrences INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER);
  `);
  const posted = [];
  const res = await deliverNightlyRecapOnDb(db, summary(), CFG, {
    nowMs: NOW,
    env: { PUBLIC_APP_URL: "https://app.example" },
    notif: {
      discordWebhookConfigured: (kind) => kind === "recap",
      postToDiscord: async (payload, opts) => { posted.push({ payload, opts }); },
    },
  });
  assert.equal(res.posted, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].opts.webhook, "recap");
  assert.equal(posted[0].opts.skipPublicCheck, true);
  assert.match(posted[0].payload.content, /https:\/\/app\.example\/ai/);
  assert.equal(db.prepare("SELECT status FROM ai_job_runs WHERE job_type='recap'").get().status, "SUCCESS");
  db.close();
});

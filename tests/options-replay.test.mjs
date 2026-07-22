import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { replaySymbolBars, summarizeReplay, runOptionsReplay } from "../lib/research/options/replay.ts";

// Phase-1 Options Historical Replay Lab: runs the ACTUAL production detection over historical bars
// with no look-ahead; outcomes are UNDERLYING forward returns (never fabricated option premiums).

// Build a synthetic trading day (Tue 2026-07-21, EDT=UTC-4): quiet morning, acceleration burst at
// 15:00 UTC (11:00 ET), then continued rise (so forward labels are positive for calls).
const DAY_OPEN = Date.UTC(2026, 6, 21, 13, 30, 0); // 09:30 ET
function makeDay(burst = true) {
  const bars = [];
  for (let i = 0; i < 390; i++) {
    const t = DAY_OPEN + i * 60_000;
    let c = 100, v = 1000;
    if (burst && i >= 90) { const k = Math.min(i - 90, 60); c = 100 + k * 0.15; v = i < 96 ? 9000 : 3000; } // accelerating from 11:00 ET
    bars.push({ t, o: c - 0.03, h: c + 0.05, l: c - 0.06, c, v });
  }
  return bars;
}

test("replay runs the PRODUCTION detection: burst detected as momentum; flat tape only low-grade compression", () => {
  const withBurst = replaySymbolBars("NVDA", makeDay(true));
  const quiet = replaySymbolBars("NVDA", makeDay(false));
  assert.ok(withBurst.length >= 1, "acceleration burst detected historically");
  const burstStrats = new Set(["momentum_acceleration", "sr_reclaim", "breakout_forming", "confirmed_breakout", "trend_continuation", "pullback_continuation"]);
  const atBurst = withBurst.filter((r) => r.tMs >= DAY_OPEN + 90 * 60_000 && r.tMs <= DAY_OPEN + 110 * 60_000);
  assert.ok(atBurst.some((r) => burstStrats.has(r.strategy)), "a burst-driven strategy fires AT the burst window");
  // a flat tape IS compression by the production definition — the point of replay is measuring that
  // these low-evidence candidates underperform, so the quality layer can rank them out with evidence.
  assert.equal(quiet.some((r) => r.strategy === "momentum_acceleration" || r.strategy === "confirmed_breakout"), false, "no momentum/breakout fabricated from a flat tape");
  const maxQuiet = Math.max(...quiet.map((r) => r.quality), 0);
  const maxBurst = Math.max(...withBurst.map((r) => r.quality));
  assert.ok(maxBurst > maxQuiet, `burst quality ${maxBurst} exceeds flat-tape quality ${maxQuiet}`);
});

test("NO LOOK-AHEAD: detection at time t is identical with or without future bars in the input", () => {
  const bars = makeDay(true);
  const full = replaySymbolBars("NVDA", bars);
  assert.ok(full.length >= 1);
  const t0 = full[0].tMs;
  const truncated = replaySymbolBars("NVDA", bars.filter((b) => b.t <= t0));
  const a = truncated.find((r) => r.tMs === t0);
  assert.ok(a, "the same candidate exists when the future is removed");
  assert.equal(a.strategy, full[0].strategy);
  assert.equal(a.quality, full[0].quality, "quality identical without future data → no leakage into detection");
  assert.equal(a.fwd60Pct, null, "forward label honestly null when the future does not exist");
});

test("forward labels are direction-adjusted underlying returns; gradingBasis stamped; no option fields", () => {
  const rows = replaySymbolBars("NVDA", makeDay(true));
  const r = rows[0];
  assert.equal(r.gradingBasis, "UNDERLYING_FORWARD");
  if (r.side === "call") assert.ok(r.fwd60Pct == null || r.fwd60Pct > 0, "rising tape → positive call-adjusted forward return");
  for (const k of ["premium", "bid", "ask", "strike", "optionSymbol", "delta"]) assert.equal(k in r, false, `no fabricated option field '${k}'`);
});

test("threshold sensitivity: summary buckets outcomes by quality band + above/below the deliver bar", () => {
  const rows = replaySymbolBars("NVDA", makeDay(true));
  const s = summarizeReplay(rows, 0.62);
  assert.match(String(s.gradingBasis), /UNDERLYING_FORWARD/);
  assert.ok(s.thresholdSensitivity && Object.keys(s.thresholdSensitivity).length >= 1, "quality-band buckets exist");
  assert.ok(s.overall.h60.n === rows.length);
  assert.ok("aboveDeliverBar" in s && "belowDeliverBar" in s, "delivered-vs-withheld comparison available");
  assert.ok(JSON.stringify(s).length < 6000, "summary stays a bounded payload for the AI queue");
});

test("runOptionsReplay: gated OFF by default; range cap enforced; persists run+candidates+summary; enqueues ONE compact AI task", async () => {
  assert.equal((await runOptionsReplay({ symbols: ["NVDA"], from: "2026-07-21", to: "2026-07-22" }, { getBars: async () => [] }, {})).ok, false, "hard no-op without the flag");
  const env = { OPTIONS_REPLAY_ENABLED: "1", OPTIONS_REPLAY_MAX_DAYS: "45" };
  const tooLong = await runOptionsReplay({ symbols: ["NVDA"], from: "2020-01-01", to: "2026-01-01" }, { getBars: async () => [] }, env);
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.reason, /Phase-1 cap/);

  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_replay_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, symbols TEXT NOT NULL, from_day TEXT NOT NULL, to_day TEXT NOT NULL, status TEXT NOT NULL, candidates INTEGER, summary_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE TABLE options_replay_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, t_ms INTEGER NOT NULL, symbol TEXT NOT NULL, strategy TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, quality REAL, strategy_score REAL, matched_signals INTEGER, required_signals INTEGER, fraction_move REAL, hour_et INTEGER, fwd30_pct REAL, fwd60_pct REAL, fwd_eod_pct REAL, grading_basis TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
          CREATE TABLE ai_research_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, priority INTEGER NOT NULL, ref_id TEXT NOT NULL, payload_json TEXT, status TEXT NOT NULL DEFAULT 'QUEUED', attempts INTEGER NOT NULL DEFAULT 0, result_json TEXT, error TEXT, lease_until_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, UNIQUE(kind, ref_id));`);
  const res = await runOptionsReplay({ symbols: ["NVDA"], from: "2026-07-21", to: "2026-07-22" }, { getDb: () => d, getBars: async () => makeDay(true) }, env);
  assert.equal(res.ok, true);
  assert.ok(res.candidates >= 1);
  const run = d.prepare("SELECT status, candidates, summary_json FROM options_replay_runs WHERE id=?").get(res.runId);
  assert.equal(run.status, "DONE");
  assert.ok(JSON.parse(run.summary_json).thresholdSensitivity);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_replay_candidates WHERE run_id=?").get(res.runId).n, res.candidates);
  assert.equal(d.prepare("SELECT grading_basis FROM options_replay_candidates LIMIT 1").get().grading_basis, "UNDERLYING_FORWARD");
  // exactly ONE bounded AI task; deterministic compute completed even though AI is entirely disabled
  const q = d.prepare("SELECT kind, ref_id, status, LENGTH(payload_json) len FROM ai_research_queue").all();
  assert.equal(q.length, 1);
  assert.equal(q[0].ref_id, `replay:${res.runId}`);
  assert.equal(q[0].status, "QUEUED", "waits harmlessly for AI/budget; replay itself already finished");
  assert.ok(q[0].len < 6000, "Claude receives ONLY the compact summary, never raw bars");
});

test("provider failure on one symbol is isolated; the run still completes with the rest", async () => {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_replay_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, symbols TEXT NOT NULL, from_day TEXT NOT NULL, to_day TEXT NOT NULL, status TEXT NOT NULL, candidates INTEGER, summary_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE TABLE options_replay_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, t_ms INTEGER NOT NULL, symbol TEXT NOT NULL, strategy TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, quality REAL, strategy_score REAL, matched_signals INTEGER, required_signals INTEGER, fraction_move REAL, hour_et INTEGER, fwd30_pct REAL, fwd60_pct REAL, fwd_eod_pct REAL, grading_basis TEXT NOT NULL, created_at_ms INTEGER NOT NULL);`);
  const res = await runOptionsReplay({ symbols: ["BAD", "NVDA"], from: "2026-07-21", to: "2026-07-22" }, { getDb: () => d, getBars: async (s) => { if (s === "BAD") throw new Error("provider 500"); return makeDay(true); } }, { OPTIONS_REPLAY_ENABLED: "1" });
  assert.equal(res.ok, true);
  assert.match(res.reason, /1 symbol error/);
  assert.ok(res.candidates >= 1, "healthy symbols still replayed");
});

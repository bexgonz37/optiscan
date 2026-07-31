/**
 * tests/watchlist-copy-clarity.test.mjs — copy-only regression cover for the
 * next-session Watchlist message.
 *
 * The reported defect, from the real 2026-07-30 18:01 ET message: SPCX was
 * published as a PUT with the text calling it a "0.6% prior-session decline"
 * when it had actually CLOSED UP 0.61% (price 113.09 vs VWAP 115.90 — below
 * VWAP, hence correctly bearish). plainThesis() took the bearish branch and
 * discarded the sign with Math.abs(). The trigger also read "Hold above $X and
 * reclaim it", which is self-contradictory.
 *
 * These tests fix the WORDING only. Direction, ranking, selection, and every
 * gate are untouched — a companion assertion pins that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatEodWatchlist } from "../lib/notifications/owner-research-notify.ts";

/** A published recommendation, shaped as buildNextSessionPlan emits it. */
const rec = (over = {}) => ({
  symbol: "SPCX", bias: "bearish", setupFamily: "0dte_momentum",
  triggerLevel: 113.09, invalidationLevel: 115.9, preferredDteRange: "1-5 DTE",
  preferredMoneyness: "ATM or 1 strike ITM",
  contractSelectionGuidance: "Verify exact contract after options open",
  confidence: 99, supportingEvidence: [], verifyContractAfterOpen: true,
  quoteContext: "STALE_PRIOR_SESSION", executable: false, rank: 1,
  priorContractContext: null, status: "WATCH", planStatus: "QUALIFIED_PLAN",
  mainRisk: "A premarket gap can invalidate the prior-session structure before the options market opens.",
  catalyst: "No confirmed catalyst",
  sessionSummary: "Price rose 0.6% on the session on 0.9x relative volume.",
  vwapPosition: "It closed 2.4% below prior-session VWAP $115.90.",
  thesis: "Price rose 0.6% on the session on 0.9x relative volume.",
  triggerText: "Stay below $113.09 after the open.",
  invalidationText: "Reclaims prior-session VWAP near $115.90 and holds above it.",
  ...over,
});

const plan = (recs) => ({
  tradingDay: "2026-07-30", builtAtMs: Date.UTC(2026, 6, 30, 22, 0, 0),
  planVersion: "overnight-v2-2026-07-30", recommendations: recs,
  needsMoreData: [], omitted: [],
  marketContext: { spyNote: "SPY trend: BULLISH", qqqNote: "QQQ trend: BULLISH", newsNote: "No confirmed catalyst" },
});

// ── The SPCX defect ─────────────────────────────────────────────────────────

test("a positive daily move is never called a decline, even on a bearish setup", () => {
  const msg = formatEodWatchlist(plan([rec()]));
  assert.match(msg, /rose 0\.6%/, "the signed move must be stated as a rise");
  assert.equal(/decline|fell 0\.6|dropped/i.test(msg), false, "a green day must never read as a decline");
  // and the bearish classification is still explained, via VWAP
  assert.match(msg, /below prior-session VWAP/);
  assert.match(msg, /PUT watch/);
});

test("a negative daily move is never called a gain, even on a bullish setup", () => {
  const msg = formatEodWatchlist(plan([rec({
    symbol: "ACME", bias: "bullish",
    sessionSummary: "Price fell 1.8% on the session on 2.1x relative volume.",
    vwapPosition: "It closed 0.7% above prior-session VWAP $44.10.",
    thesis: "Price fell 1.8% on the session on 2.1x relative volume.",
    triggerText: "Hold above $44.40 after the open.",
  })]));
  assert.match(msg, /fell 1\.8%/);
  assert.equal(/rose 1\.8|gain(ed)? 1\.8|rallied/i.test(msg), false, "a red day must never read as a gain");
  assert.match(msg, /CALL watch/);
});

// ── Holding above vs needing to reclaim ─────────────────────────────────────

test("already above the level says hold, below it says reclaim", () => {
  const holding = formatEodWatchlist(plan([rec({ symbol: "AAA", bias: "bullish", triggerText: "Hold above $100.00 after the open." })]));
  assert.match(holding, /Hold above \$100\.00 after the open\./);
  assert.equal(/reclaim it/i.test(holding), false, "must not tell a holder to reclaim");

  const reclaiming = formatEodWatchlist(plan([rec({ symbol: "BBB", bias: "bullish", triggerText: "Reclaim $100.00 after the open and hold above it." })]));
  assert.match(reclaiming, /Reclaim \$100\.00 after the open and hold above it\./);

  // The old contradiction must not reappear in any form.
  for (const m of [holding, reclaiming]) {
    assert.equal(/Hold above .* and reclaim it/i.test(m), false, "the self-contradictory phrasing must be gone");
  }
});

// ── Today's evidence separated from tomorrow's requirement ──────────────────

test("today's session and the post-open requirement are separate labelled lines", () => {
  const msg = formatEodWatchlist(plan([rec()]));
  const today = msg.split("\n").find((l) => l.startsWith("Today:"));
  const needs = msg.split("\n").find((l) => l.startsWith("Needs after the open:"));
  assert.ok(today, "today's evidence must have its own line");
  assert.ok(needs, "tomorrow's requirement must have its own line");
  assert.equal(/after the open/.test(today), false, "today's line must not contain tomorrow's condition");
  assert.equal(/rose|fell/.test(needs), false, "the requirement line must not restate today's move");
  for (const label of ["Invalid if:", "Careful:", "Catalyst:"]) assert.ok(msg.includes(label), `${label} must be present`);
});

test("missing catalyst is stated plainly, not omitted", () => {
  const msg = formatEodWatchlist(plan([rec({ catalyst: "No confirmed catalyst" })]));
  assert.match(msg, /Catalyst: No confirmed catalyst/);
});

// ── Internal vocabulary and confidence removed ──────────────────────────────

test("internal setup names and numeric confidence never reach the message", () => {
  const msg = formatEodWatchlist(plan([rec()]));
  assert.equal(msg.includes("0dte_momentum"), false, "internal setup family must not leak");
  assert.equal(/confidence|conf \d|99\/100|score/i.test(msg), false, "no numeric confidence or score");
  assert.equal(/planStatus|QUALIFIED_PLAN|STALE_PRIOR_SESSION|preferredMoneyness/.test(msg), false, "no pipeline vocabulary");
});

test("the message carries WATCH ONLY, contract verification, and one disclaimer", () => {
  const msg = formatEodWatchlist(plan([rec(), rec({ symbol: "MSFT", bias: "bullish", rank: 2 })]));
  assert.match(msg, /WATCH ONLY/);
  assert.match(msg, /VERIFY CONTRACT AFTER OPTIONS OPEN/);
  assert.equal((msg.match(/Educational research only/g) ?? []).length, 1, "exactly one disclaimer");
  assert.equal(/guaranteed|will move|can't lose|sure thing/i.test(msg), false, "no guaranteed language");
  assert.equal(/\bO:[A-Z]{1,6}\d{6}[CP]\d{8}\b/.test(msg), false, "no exact contract before options open");
});

test("the empty state stays clean", () => {
  const msg = formatEodWatchlist(plan([]));
  assert.match(msg, /No qualified setups yet\./);
  assert.equal(/decline|Needs after the open/.test(msg), false);
});

// ── Copy-only guarantee ─────────────────────────────────────────────────────

test("this change touches wording only, not direction, ranking, or gates", () => {
  const src = readFileSync("lib/research/overnight/next-session-plan.ts", "utf8");
  // The direction rule and the publication gate must be untouched.
  assert.match(src, /const bearish = String\(row\.direction \?\? row\.option_side \?\? ""\)/,
    "direction still derives from the persisted alert, not from copy");
  assert.match(src, /planStatus === "QUALIFIED_PLAN"/, "the publication gate is unchanged");
  assert.match(src, /\.slice\(0, 5\)/, "the published row cap is unchanged");
  // The sign bug specifically must be gone.
  assert.equal(/Math\.abs\(move\)\.toFixed\(1\)}% prior-session decline/.test(src), false,
    "the Math.abs decline phrasing must not return");
});

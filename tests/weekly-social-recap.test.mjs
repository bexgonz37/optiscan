import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildWeeklySocialRecap,
  completedWeeklyWindow,
  windowForRange,
  screenRecapWording,
  LABEL_COMBINED_PEAK,
  LABEL_COMBINED_TRACKED,
} from "../lib/research/social/weekly-recap.ts";
import {
  renderDraft,
  renderAllDrafts,
  validateDraftAgainstRecap,
  DRAFT_STYLES,
} from "../lib/research/social/weekly-recap-drafts.ts";
import { rewriteRecapDraft } from "../lib/research/social/weekly-recap-ai.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// Week of Mon 2026-07-27 .. Fri 2026-07-31 (ET).
const WINDOW = windowForRange("2026-07-27", "2026-07-31");
const NOW = Date.parse("2026-08-03T14:00:00.000Z");
const TUE = Date.parse("2026-07-28T15:00:00.000Z"); // 11:00 a.m. ET

let seq = 0;
function row(overrides = {}) {
  seq += 1;
  return {
    lane: "VERIFIED_SUBSCRIBER",
    alertId: `oa_${seq}`,
    opportunityCaseId: `oc_${seq}`,
    symbol: "NVDA",
    optionSymbol: "O:NVDA260731C00180000",
    thesisKey: `th_${seq}`,
    frozenEntry: 2,
    entryBid: 1.98,
    entryAsk: 2.04,
    entryQuoteTsMs: TUE - 1000,
    discordMessageId: `disc_${seq}`,
    subscriberDelivered: true,
    paperStatus: "EXITED",
    paperTradeId: seq,
    trackedPct: 50,
    exitReason: "target_hit",
    peakPct: 100,
    markCount: 12,
    gaveBackProfit: false,
    verifiedPnlEligible: true,
    pnlClassification: "VERIFIED_REALIZED",
    pnlExclusionReasons: [],
    openedAtMs: TUE,
    setupReason: "Reclaimed VWAP with rising relative volume.",
    ...overrides,
  };
}

function recapOf(rows, opts = {}) {
  return buildWeeklySocialRecap(rows, { window: WINDOW, nowMs: NOW, ...opts });
}

// ------------------------------------------------------------------ weekly window

test("the default window is the most recent COMPLETED Monday-Friday ET week", () => {
  // Monday 2026-08-03 -> the completed week is 2026-07-27..2026-07-31.
  const fromMonday = completedWeeklyWindow(Date.parse("2026-08-03T14:00:00.000Z"));
  assert.equal(fromMonday.startDay, "2026-07-27");
  assert.equal(fromMonday.endDay, "2026-07-31");
  // Mid-week must NOT return a partial current week.
  const fromWednesday = completedWeeklyWindow(Date.parse("2026-08-05T14:00:00.000Z"));
  assert.equal(fromWednesday.startDay, "2026-07-27");
  assert.equal(fromWednesday.endDay, "2026-07-31");
  // Saturday: the week that just ended is complete.
  const fromSaturday = completedWeeklyWindow(Date.parse("2026-08-08T14:00:00.000Z"));
  assert.equal(fromSaturday.startDay, "2026-08-03");
  assert.equal(fromSaturday.endDay, "2026-08-07");
});

test("the window covers Monday open through Friday close and excludes weekends", () => {
  assert.deepEqual(WINDOW.tradingDays, ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"]);
  const friLate = Date.parse("2026-07-31T23:00:00.000Z"); // 7:00 p.m. ET Friday
  assert.ok(friLate >= WINDOW.startMs && friLate < WINDOW.endMs, "Friday evening is inside the week");
  const satMorning = Date.parse("2026-08-01T14:00:00.000Z");
  assert.ok(satMorning >= WINDOW.endMs, "Saturday is outside the week");
  const sunBefore = Date.parse("2026-07-26T14:00:00.000Z");
  assert.ok(sunBefore < WINDOW.startMs, "the prior Sunday is outside the week");
});

test("market holidays are skipped and reported, not silently dropped", () => {
  // 2026-07-03 is the observed Independence Day holiday in the default set.
  const w = windowForRange("2026-06-29", "2026-07-03");
  assert.ok(!w.tradingDays.includes("2026-07-03"), "a holiday is not a trading day");
  assert.deepEqual(w.holidaysSkipped, ["2026-07-03"]);
  const recap = recapOf([row({ openedAtMs: Date.parse("2026-06-30T15:00:00.000Z") })], { window: w });
  assert.ok(recap.warnings.some((x) => /Market holiday skipped: 2026-07-03/.test(x)));
});

test("a manual range is supported for historical review", () => {
  const w = windowForRange("2026-07-06", "2026-07-17");
  assert.equal(w.manualRange, true);
  assert.equal(w.tradingDays.length, 10);
});

test("rows outside the window are excluded by OPENING timestamp", () => {
  const inside = row({ openedAtMs: TUE });
  const before = row({ openedAtMs: Date.parse("2026-07-24T15:00:00.000Z") });
  const after = row({ openedAtMs: Date.parse("2026-08-03T15:00:00.000Z") });
  const recap = recapOf([inside, before, after]);
  assert.equal(recap.verifiedSubscriber.eligibleCallouts, 1);
  assert.equal(recap.callouts.verifiedSubscriber[0].alertId, inside.alertId);
});

// --------------------------------------------------------------------- no inflation

test("repeat signals for the same thesis count once", () => {
  const first = row({ alertId: "oa_a", opportunityCaseId: "oc_same", peakPct: 100, trackedPct: 50, openedAtMs: TUE });
  const repeat = row({ alertId: "oa_b", opportunityCaseId: "oc_same", peakPct: 90, trackedPct: 40, openedAtMs: TUE + 60_000 });
  const recap = recapOf([first, repeat]);
  assert.equal(recap.verifiedSubscriber.eligibleCallouts, 1);
  assert.equal(recap.verifiedSubscriber.combinedPeakMovePct, 100, "the repeat must not add to the peak sum");
  assert.equal(recap.verifiedSubscriber.combinedTrackedResultPct, 50);
  assert.ok(recap.exclusions.some((e) => e.alertId === "oa_b" && /same thesis/.test(e.reason)));
});

test("a contract replacement under one thesis counts once", () => {
  const original = row({ alertId: "oa_c1", opportunityCaseId: "oc_thesis", optionSymbol: "O:NVDA260731C00180000", openedAtMs: TUE });
  const replacement = row({ alertId: "oa_c2", opportunityCaseId: "oc_thesis", optionSymbol: "O:NVDA260731C00185000", openedAtMs: TUE + 120_000 });
  const recap = recapOf([original, replacement]);
  assert.equal(recap.verifiedSubscriber.eligibleCallouts, 1);
  assert.equal(recap.callouts.verifiedSubscriber[0].optionSymbol, "O:NVDA260731C00180000", "the original opening wins");
  assert.ok(recap.exclusions.some((e) => e.alertId === "oa_c2" && /contract replacement/.test(e.reason)));
});

test("lifecycle updates count once", () => {
  // A milestone/lifecycle row shares the opportunity case with its opening.
  const opening = row({ alertId: "oa_open", opportunityCaseId: "oc_life", openedAtMs: TUE });
  const milestone = row({ alertId: "oa_t1", opportunityCaseId: "oc_life", openedAtMs: TUE + 300_000, peakPct: 187 });
  const recap = recapOf([opening, milestone]);
  assert.equal(recap.verifiedSubscriber.eligibleCallouts, 1);
  assert.ok(recap.exclusions.some((e) => /lifecycle update/.test(e.reason)));
});

test("thesis dedup falls back to the thesis fingerprint when no case id differs", () => {
  const a = row({ alertId: "oa_f1", opportunityCaseId: null, thesisKey: "fp_1", openedAtMs: TUE });
  const b = row({ alertId: "oa_f2", opportunityCaseId: null, thesisKey: "fp_1", openedAtMs: TUE + 1000 });
  const recap = recapOf([a, b]);
  // Both lack an opportunity case, so neither is eligible — but they collapse first.
  assert.ok(recap.exclusions.some((e) => e.alertId === "oa_f2" && /same thesis/.test(e.reason)));
  assert.equal(recap.verifiedSubscriber.eligibleCallouts, 0);
  assert.ok(recap.exclusions.some((e) => e.alertId === "oa_f1" && /no opportunity case/.test(e.reason)));
});

test("research rows never enter the subscriber totals", () => {
  const verified = row({ peakPct: 100, trackedPct: 50 });
  const research = row({
    lane: "RESEARCH_ONLY", alertId: "oa_r", opportunityCaseId: "oc_r",
    subscriberDelivered: false, verifiedPnlEligible: false,
    pnlClassification: "RESEARCH_ONLY", peakPct: 900, trackedPct: 400,
  });
  const recap = recapOf([verified, research]);
  assert.equal(recap.verifiedSubscriber.eligibleCallouts, 1);
  assert.equal(recap.verifiedSubscriber.combinedPeakMovePct, 100, "research peaks must not leak in");
  assert.equal(recap.verifiedSubscriber.combinedTrackedResultPct, 50);
  // The research row is not eligible in its own lane either (no verified evidence),
  // so it is excluded rather than silently promoted.
  assert.equal(recap.researchOnly.eligibleCallouts, 0);
  assert.ok(recap.exclusions.some((e) => e.alertId === "oa_r"));
});

test("verifiedSubscriberOnly suppresses the research and watchlist lanes entirely", () => {
  const recap = recapOf(
    [row(), row({ lane: "RESEARCH_ONLY", verifiedPnlEligible: false }), row({ lane: "WATCHLIST" })],
    { verifiedSubscriberOnly: true },
  );
  assert.equal(recap.researchOnly.eligibleCallouts, 0);
  assert.equal(recap.watchlist.eligibleCallouts, 0);
  assert.equal(recap.callouts.researchOnly.length, 0);
  assert.equal(recap.callouts.watchlist.length, 0);
});

test("missing mirrors, unlinked delivery, audit-only, and stale marks are excluded", () => {
  const cases = [
    ["MISSING_MIRROR", "missing mirror"],
    ["UNLINKED_DELIVERY", "unlinked delivery"],
    ["AUDIT_ONLY", "audit only"],
    ["STALE_MARK", "stale mark"],
    ["INVALID_EXIT", "invalid exit"],
    ["INVALID_ENTRY", "invalid entry"],
    ["DUPLICATE_POSITION", "duplicate position"],
  ];
  for (const [classification, phrase] of cases) {
    const recap = recapOf([row({ pnlClassification: classification, verifiedPnlEligible: false })]);
    assert.equal(recap.verifiedSubscriber.eligibleCallouts, 0, classification);
    assert.ok(
      recap.exclusions.some((e) => e.reason.includes(phrase)),
      `${classification} must be excluded with a named reason`,
    );
  }
});

test("an after-hours or otherwise invalid mark cannot produce a callout", () => {
  // No verified peak survived validation upstream.
  const noPeak = recapOf([row({ peakPct: null })]);
  assert.equal(noPeak.verifiedSubscriber.eligibleCallouts, 0);
  assert.ok(noPeak.exclusions.some((e) => /no valid lifecycle or grading evidence/.test(e.reason)));
  // Closed with no canonical exit is unusable too.
  const noTracked = recapOf([row({ paperStatus: "EXITED", trackedPct: null })]);
  assert.equal(noTracked.verifiedSubscriber.eligibleCallouts, 0);
  assert.ok(noTracked.exclusions.some((e) => /no canonical tracked result/.test(e.reason)));
});

test("missing subscriber proof, OCC, frozen entry, or entry bid/ask is excluded with a reason", () => {
  const checks = [
    [{ subscriberDelivered: false }, /no verified subscriber Discord opening proof/],
    [{ discordMessageId: null }, /no Discord message id/],
    [{ optionSymbol: "NVDA-CALL" }, /no exact OCC contract/],
    [{ frozenEntry: 0 }, /no frozen entry/],
    [{ entryBid: null }, /no valid entry bid\/ask evidence/],
    [{ entryAsk: 1.0, entryBid: 1.5 }, /no valid entry bid\/ask evidence/],
    [{ entryQuoteTsMs: null }, /no valid entry bid\/ask evidence/],
    [{ opportunityCaseId: null }, /no opportunity case/],
  ];
  for (const [override, re] of checks) {
    const recap = recapOf([row(override)]);
    assert.equal(recap.verifiedSubscriber.eligibleCallouts, 0, JSON.stringify(override));
    assert.ok(recap.exclusions.some((e) => re.test(e.reason)), `${JSON.stringify(override)} -> ${re}`);
  }
});

// ---------------------------------------------------------- peak vs tracked vs open

test("peak and tracked results stay separate and are never combined", () => {
  const recap = recapOf([
    row({ peakPct: 187, trackedPct: 92 }),
    row({ peakPct: 94, trackedPct: 51 }),
    row({ peakPct: 76, trackedPct: 43 }),
  ]);
  const t = recap.verifiedSubscriber;
  assert.equal(t.combinedPeakMovePct, 357);
  assert.equal(t.combinedTrackedResultPct, 186);
  assert.notEqual(t.combinedPeakMovePct, t.combinedTrackedResultPct);
  assert.equal(t.averageTrackedPct, 62);
  assert.equal(recap.labels.combinedPeak, LABEL_COMBINED_PEAK);
  assert.equal(recap.labels.combinedTracked, LABEL_COMBINED_TRACKED);
});

test("open trades never affect win rate or tracked results", () => {
  const recap = recapOf([
    row({ peakPct: 100, trackedPct: 50 }),
    row({ peakPct: 80, trackedPct: -30 }),
    row({ paperStatus: "ENTERED", trackedPct: null, peakPct: 400 }),
  ]);
  const t = recap.verifiedSubscriber;
  assert.equal(t.eligibleCallouts, 3);
  assert.equal(t.closedCallouts, 2);
  assert.equal(t.openCallouts, 1);
  assert.equal(t.winners, 1);
  assert.equal(t.losers, 1);
  assert.equal(t.winRatePct, 50, "the open trade is neither a win nor a loss");
  assert.equal(t.combinedTrackedResultPct, 20, "the open trade adds nothing to tracked results");
  assert.equal(t.combinedPeakMovePct, 180, "by default the open peak is excluded too");
  assert.ok(recap.warnings.some((w) => /1 open position excluded from all totals/.test(w)));

  const withOpen = recapOf([
    row({ peakPct: 100, trackedPct: 50 }),
    row({ peakPct: 80, trackedPct: -30 }),
    row({ paperStatus: "ENTERED", trackedPct: null, peakPct: 400 }),
  ], { includeOpenTrades: true });
  assert.equal(withOpen.verifiedSubscriber.combinedPeakMovePct, 580, "opt-in includes the open peak");
  assert.equal(withOpen.verifiedSubscriber.combinedTrackedResultPct, 20, "tracked results still exclude it");
  assert.equal(withOpen.verifiedSubscriber.winRatePct, 50, "win rate is unchanged");
});

test("best peak and best tracked are reported separately when they differ", () => {
  const recap = recapOf([
    row({ symbol: "NVDA", optionSymbol: "O:NVDA260731C00180000", peakPct: 187, trackedPct: 20 }),
    row({ symbol: "SPY", optionSymbol: "O:SPY260729P00736000", peakPct: 94, trackedPct: 88 }),
  ]);
  const t = recap.verifiedSubscriber;
  assert.match(t.bestPeak.contractLabel, /NVDA/);
  assert.equal(t.bestPeak.pct, 187);
  assert.match(t.bestTracked.contractLabel, /SPY/);
  assert.equal(t.bestTracked.pct, 88);
  assert.notEqual(t.bestPeak.contractLabel, t.bestTracked.contractLabel);
});

test("losses are surfaced, not hidden", () => {
  const recap = recapOf([
    row({ symbol: "IWM", optionSymbol: "O:IWM260731P00289000", peakPct: 5, trackedPct: -64 }),
    row({ peakPct: 100, trackedPct: 50 }),
  ]);
  assert.equal(recap.verifiedSubscriber.losers, 1);
  assert.match(recap.verifiedSubscriber.largestLoss.contractLabel, /IWM/);
  assert.equal(recap.verifiedSubscriber.largestLoss.pct, -64);
  const card = renderDraft(recap, "D_REPORT_CARD").text;
  assert.match(card, /Largest loss \(tracked\): IWM [^\n]*-64%/);
});

// ------------------------------------------------------------------ warnings

test("fewer than five eligible closed callouts raises LOW SAMPLE", () => {
  const four = recapOf([row(), row(), row(), row()]);
  assert.equal(four.lowSample, true);
  assert.ok(four.warnings.some((w) => w === "LOW SAMPLE — weekly percentages may not be representative."));
  const five = recapOf([row(), row(), row(), row(), row()]);
  assert.equal(five.lowSample, false);
});

test("exclusions are counted in a warning", () => {
  const recap = recapOf([row(), row({ pnlClassification: "MISSING_MIRROR", verifiedPnlEligible: false })]);
  assert.ok(recap.warnings.some((w) => /1 callout excluded due to incomplete verification\./.test(w)));
});

test("negative tracked with positive peaks states the giveback plainly", () => {
  const recap = recapOf([
    row({ peakPct: 120, trackedPct: -40, gaveBackProfit: true }),
    row({ peakPct: 60, trackedPct: -30, gaveBackProfit: true }),
  ]);
  assert.ok(recap.verifiedSubscriber.combinedPeakMovePct > 0);
  assert.ok(recap.verifiedSubscriber.combinedTrackedResultPct < 0);
  assert.ok(recap.warnings.some((w) => w === "Several callouts moved favorably but the tracked exit policy gave back gains."));
  assert.equal(recap.verifiedSubscriber.profitGivenBackCount, 2);
});

// --------------------------------------------------------------------- draft styles

function fullRecap() {
  return recapOf([
    row({ symbol: "NVDA", optionSymbol: "O:NVDA260731C00180000", peakPct: 187, trackedPct: 92 }),
    row({ symbol: "SPY", optionSymbol: "O:SPY260729P00736000", peakPct: 94, trackedPct: 51 }),
    row({ symbol: "IWM", optionSymbol: "O:IWM260731P00289000", peakPct: 76, trackedPct: 43 }),
    row({ symbol: "TSLA", optionSymbol: "O:TSLA260731C00330000", peakPct: 40, trackedPct: -25 }),
    row({ symbol: "META", optionSymbol: "O:META260731C00520000", peakPct: 20, trackedPct: -15 }),
  ]);
}

test("all four styles render and preserve the exact deterministic numbers", () => {
  const recap = fullRecap();
  const t = recap.verifiedSubscriber;
  assert.equal(t.combinedPeakMovePct, 417);
  assert.equal(t.combinedTrackedResultPct, 146);
  for (const draft of renderAllDrafts(recap)) {
    const v = validateDraftAgainstRecap(draft.text, recap);
    assert.equal(v.ok, true, `${draft.style} -> ${JSON.stringify(v.failures)}`);
    assert.equal(draft.wordingOk, true, `${draft.style} wording -> ${JSON.stringify(draft.wordingViolations)}`);
    assert.match(draft.text, /Educational purposes only/);
  }
  assert.deepEqual(DRAFT_STYLES, ["A_CLEAN_RECAP", "B_TWITTER_THREAD", "C_CONCISE_FLEX", "D_REPORT_CARD"]);
});

test("Style A shows counts, both combined labels, and top callouts", () => {
  const recap = fullRecap();
  const text = renderDraft(recap, "A_CLEAN_RECAP").text;
  assert.match(text, /5 verified setups/);
  assert.match(text, /3 winners/);
  assert.match(text, /60% win rate/);
  assert.match(text, /Combined peak moves: \+417%/);
  assert.match(text, /Combined tracked results: \+146%/);
  assert.match(text, /NVDA 07\/31 \$180 Call · peak \+187% · tracked \+92%/);
  assert.match(text, /Past performance does not guarantee future results\./);
});

test("Style B is a thread with one callout per tweet and a disclosure final tweet", () => {
  const recap = fullRecap();
  const draft = renderDraft(recap, "B_TWITTER_THREAD");
  assert.ok(draft.parts.length >= 3);
  assert.match(draft.parts[0], /Combined peak moves: \+417%/);
  assert.match(draft.parts[0], /3 of 5 closed green/);
  const tweet1 = draft.parts[1];
  assert.match(tweet1, /NVDA 07\/31 \$180 CALL/);
  assert.match(tweet1, /Posted entry: \$2/);
  assert.match(tweet1, /Verified peak: \+187%/);
  assert.match(tweet1, /Tracked exit result: \+92%/);
  const last = draft.parts[draft.parts.length - 1];
  assert.match(last, /not a portfolio return/);
  assert.match(last, /frozen entry posted at the callout and verified option bid marks/);
  assert.match(last, /cannot prove any person entered, exited, or captured it/);
});

test("Style C leads with the peak sum and auto-appends the peak disclosure", () => {
  const text = renderDraft(fullRecap(), "C_CONCISE_FLEX").text;
  assert.match(text, /^\+417% in combined verified peak moves across this week's OptiScan callouts\./);
  assert.match(text, /Combined peak moves are the sum of individual callout peaks, not portfolio return\. Educational purposes only\./);
});

test("Style D reports every required transparency field including exclusions", () => {
  const recap = recapOf([
    row({ symbol: "NVDA", optionSymbol: "O:NVDA260731C00180000", peakPct: 187, trackedPct: 92 }),
    row({ symbol: "IWM", optionSymbol: "O:IWM260731P00289000", peakPct: 8, trackedPct: -55, gaveBackProfit: false }),
    row({ paperStatus: "ENTERED", trackedPct: null, peakPct: 30 }),
    row({ pnlClassification: "MISSING_MIRROR", verifiedPnlEligible: false, symbol: "AVGO" }),
  ]);
  const text = renderDraft(recap, "D_REPORT_CARD").text;
  for (const field of [
    /Total callouts: 3/, /Winners: 1/, /Losers: 1/, /Open: 1/, /Win rate: 50%/,
    /Average callout \(tracked\)/, /Combined tracked results/, /Combined peak moves/,
    /Largest winner \(tracked\)/, /Largest loss \(tracked\)/, /Profit given back/,
    /Excluded rows: 1/,
  ]) assert.match(text, field);
  assert.match(text, /AVGO: classification missing mirror/);
});

test("the peak sum is never labelled a portfolio or account return", () => {
  const MISLABEL = /portfolio (?:return|gain|growth)|account (?:return|gain|growth)|total account|realized (?:return|gain)/i;
  for (const draft of renderAllDrafts(fullRecap())) {
    // The phrase may appear ONLY inside the required denial ("not portfolio return"),
    // so every sentence containing it must negate it.
    for (const sentence of draft.text.split(/(?<=[.!?])\s+|\n+/)) {
      if (MISLABEL.test(sentence)) {
        assert.match(sentence, /\bnot\b/i, `mislabel asserted in: ${sentence}`);
      }
    }
    assert.equal(screenRecapWording(draft.text).ok, true, draft.style);
  }
  // Asserting the label is still a violation.
  assert.equal(screenRecapWording("Combined peak moves are our portfolio return.").ok, false);
  assert.equal(screenRecapWording("This was the total account gain.").ok, false);
});

test("a draft mentioning combined peak without the disclosure fails validation", () => {
  const recap = fullRecap();
  const bad = "Combined peak moves: +417%. Educational purposes only.";
  const v = validateDraftAgainstRecap(bad, recap);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.kind === "MISSING_REQUIRED_DISCLOSURE"));
});

// ------------------------------------------------------------ wording + AI limits

test("unsupported performance wording is rejected", () => {
  for (const phrase of [
    "we made +417% this week",
    "I gave you the NVDA call",
    "followers made huge gains",
    "our members made money",
    "you would have made +187%",
    "this was our portfolio return",
    "total account up +417%",
    "risk-free setup",
    "guaranteed winners",
    "subscribers captured the move",
  ]) {
    const screen = screenRecapWording(phrase);
    assert.equal(screen.ok, false, phrase);
    assert.ok(screen.violations.length > 0, phrase);
  }
  // Permitted framing about the callouts themselves.
  for (const phrase of [
    "OptiScan's verified callouts produced a combined peak of +417%.",
    "Across this week's verified OptiScan callouts, three of five closed green.",
    "The combined peak moves across verified callouts were +417%.",
  ]) {
    assert.equal(screenRecapWording(phrase).ok, true, phrase);
  }
});

test("AI cannot invent a ticker or a percentage", () => {
  const recap = fullRecap();
  const invented = validateDraftAgainstRecap(
    "AAPL 07/31 $200 Call · peak +999%. Combined peak moves are not a portfolio return. Educational purposes only.",
    recap,
  );
  assert.equal(invented.ok, false);
  assert.ok(invented.failures.some((f) => f.kind === "UNKNOWN_SYMBOL" && f.token === "AAPL"));
  assert.ok(invented.failures.some((f) => f.kind === "UNSUPPORTED_NUMBER" && f.token === "999"));
});

function fakeFetch(payload) {
  return async () => new Response(JSON.stringify({
    content: [{ type: "tool_use", name: "recap_rewrite", input: payload }],
    usage: { input_tokens: 100, output_tokens: 40 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}
const AI_ENV = { AI_ENABLED: "1", ANTHROPIC_API_KEY: "sk-ant-test", AI_WEEKLY_MODEL: "claude-sonnet-5" };

test("an AI variant that alters a number is discarded", async () => {
  const recap = fullRecap();
  const draft = renderDraft(recap, "A_CLEAN_RECAP");
  const out = await rewriteRecapDraft({
    recap,
    draft,
    deps: {
      env: AI_ENV,
      fetchImpl: fakeFetch({
        variants: [{ parts: ["Combined peak moves: +9999%. Not a portfolio return. Educational purposes only."] }],
      }),
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, "REJECTED_VALIDATION");
  assert.equal(out.variants.length, 0);
  assert.equal(out.rejected.length, 1);
  assert.match(out.note, /discarded/);
});

test("an AI variant preserving every number is accepted", async () => {
  const recap = fullRecap();
  const draft = renderDraft(recap, "A_CLEAN_RECAP");
  const faithful = [
    "Across this week's verified OptiScan callouts: 5 verified setups, 3 winners, 60% win rate.",
    "Combined peak moves: +417%",
    "Combined tracked results: +146%",
    "NVDA 07/31 $180 Call · peak +187% · tracked +92%",
    "Combined peak moves are the sum of individual callout peaks, not portfolio return.",
    "Past performance does not guarantee future results.",
    "Educational purposes only. Options involve substantial risk.",
  ].join("\n");
  const out = await rewriteRecapDraft({
    recap, draft,
    deps: { env: AI_ENV, fetchImpl: fakeFetch({ variants: [{ parts: [faithful] }] }) },
  });
  assert.equal(out.ok, true, JSON.stringify(out.rejected));
  assert.equal(out.variants.length, 1);
  assert.match(out.variants[0].text, /\+417%/);
});

test("AI disabled or failing leaves the deterministic draft intact", async () => {
  const recap = fullRecap();
  const draft = renderDraft(recap, "A_CLEAN_RECAP");
  const disabled = await rewriteRecapDraft({
    recap, draft,
    deps: { env: { AI_ENABLED: "0" }, fetchImpl: async () => { throw new Error("must not be called"); } },
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.status, "AI_DISABLED");
  const failed = await rewriteRecapDraft({
    recap, draft,
    deps: { env: AI_ENV, fetchImpl: async () => { throw new Error("network down"); } },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "PROVIDER_ERROR");
  // The deterministic draft is unchanged and still valid.
  assert.equal(validateDraftAgainstRecap(draft.text, recap).ok, true);
});

test("AI performs no arithmetic and the report says so", () => {
  const recap = fullRecap();
  assert.equal(recap.safety.aiCalculatesNumbers, false);
  const ai = read("lib/research/social/weekly-recap-ai.ts");
  assert.doesNotMatch(ai, /combinedPeakMovePct\s*[+\-*/]/);
  assert.match(ai, /You may NOT calculate, adjust, round, sum, average, or invent ANY number/);
  assert.match(ai, /validateDraftAgainstRecap/);
});

// ------------------------------------------------------------ delivery boundaries

test("no automatic Twitter or X posting exists anywhere in the feature", () => {
  const files = [
    "lib/research/social/weekly-recap.ts",
    "lib/research/social/weekly-recap-drafts.ts",
    "lib/research/social/weekly-recap-sources.ts",
    "lib/research/social/weekly-recap-ai.ts",
    "app/api/research/social/weekly-recap/route.ts",
    "app/weekly-social-recap/page.tsx",
  ];
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /api\.twitter\.com|api\.x\.com|tweepy|twitter[_-]?api|oauth_token/i, f);
    assert.doesNotMatch(src, /\bpostTweet\b|\bpublishTweet\b|\bautoPost\b\s*[:=]\s*true/i, f);
  }
});

test("no subscriber Discord delivery and no Recap scheduler or webhook use", () => {
  const files = [
    "lib/research/social/weekly-recap.ts",
    "lib/research/social/weekly-recap-drafts.ts",
    "lib/research/social/weekly-recap-sources.ts",
    "lib/research/social/weekly-recap-ai.ts",
    "app/api/research/social/weekly-recap/route.ts",
    "app/weekly-social-recap/page.tsx",
  ];
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /DISCORD_WEBHOOK_OPTIONS|DISCORD_WEBHOOK_RECAP|DISCORD_WEBHOOK_WATCHLIST/, f);
    assert.doesNotMatch(src, /sendOwnerResearchNotify|deliverOptionsCallout|sendDiscord|postDiscord|notifyNewAlert/i, f);
    assert.doesNotMatch(src, /recapEnabled|AI_RECAP_ENABLED|startScheduler|watchlistScheduleWindow/, f);
  }
  // The route exposes no write handler at all.
  const route = read("app/api/research/social/weekly-recap/route.ts");
  assert.match(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
});

test("the feature writes no production state", () => {
  const dir = join(root, "lib/research/social");
  const walk = (d) => readdirSync(d).flatMap((e) => {
    const full = join(d, e);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
  for (const f of [...walk(dir), join(root, "app/api/research/social/weekly-recap/route.ts")]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /\b(?:INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|CREATE TABLE|ALTER TABLE|DROP TABLE)\b/i, f);
    assert.doesNotMatch(src, /writeFileSync|execSync|spawnSync|child_process/i, f);
  }
});

test("owner output is one weekly batch, generated on demand", () => {
  const recap = fullRecap();
  // A single window, a single recap object, one draft per style.
  assert.equal(recap.window.startDay, "2026-07-27");
  assert.equal(recap.window.endDay, "2026-07-31");
  const drafts = renderAllDrafts(recap);
  assert.equal(drafts.length, 4);
  assert.equal(new Set(drafts.map((d) => d.style)).size, 4);
  const page = read("app/weekly-social-recap/page.tsx");
  assert.match(page, /Copy/);
  assert.match(page, /Export text/);
  assert.doesNotMatch(page, /\bPost\b|\bPublish\b|\bSend\b|\bSchedule\b/);
  assert.match(page, /Nothing here posts, sends, or schedules/);
});

test("the recap reports its own safety posture", () => {
  const recap = fullRecap();
  assert.equal(recap.safety.autoPostEnabled, false);
  assert.equal(recap.safety.subscriberDeliveryEnabled, false);
  assert.equal(recap.safety.aiCalculatesNumbers, false);
});

test("every callout carries its opportunity case and verified evidence internally", () => {
  const recap = fullRecap();
  for (const c of recap.callouts.verifiedSubscriber) {
    assert.ok(c.evidence.opportunityCaseId, "each callout must cite its opportunity case");
    assert.ok(c.evidence.alertId);
    assert.ok(Number.isFinite(Number(c.evidence.entryBid)));
    assert.ok(Number.isFinite(Number(c.evidence.entryAsk)));
    assert.ok(Number.isFinite(Number(c.evidence.entryQuoteTsMs)));
    assert.match(c.evidence.peakSource, /bid/, "the peak source must be bid-based");
    assert.equal(c.evidence.trackedSource, "options_paper_trades/return_pct");
  }
});

test("peaks are bid-based by construction, never midpoint or ask", () => {
  const sources = read("lib/research/social/weekly-recap-sources.ts");
  assert.match(sources, /bestGainPct/);
  assert.match(sources, /in-session BID marks only/);
  assert.doesNotMatch(sources, /peakPct:\s*num\(\w+\?\.(?:mid|ask)\b/);
});

// ------------------- regression: ticker detection must be precise, not merely broad

test("ticker detection flags invented callouts but not ordinary copy", () => {
  const recap = fullRecap();
  // Ordinary uppercase copy is not a ticker claim.
  for (const clean of [
    "Reclaimed VWAP with rising relative volume. Combined peak moves are not portfolio return. Educational purposes only.",
    "All times ET. OCC contracts verified. Not portfolio return. Educational purposes only.",
    "LOW SAMPLE — weekly percentages may not be representative. Not portfolio return. Educational purposes only.",
  ]) {
    const v = validateDraftAgainstRecap(clean, recap);
    assert.ok(
      !v.failures.some((f) => f.kind === "UNKNOWN_SYMBOL"),
      `${clean} -> ${JSON.stringify(v.failures)}`,
    );
  }
  // Contract-shaped references to a symbol not in the week ARE flagged.
  for (const invented of [
    "AAPL 07/31 $200 Call was a great setup.",
    "$AAPL ripped this week.",
    "AMZN $150 Put closed green.",
  ]) {
    const v = validateDraftAgainstRecap(invented, recap);
    assert.ok(
      v.failures.some((f) => f.kind === "UNKNOWN_SYMBOL"),
      `${invented} must be flagged`,
    );
  }
  // A symbol that IS in the week passes.
  const ok = validateDraftAgainstRecap(
    "NVDA 07/31 $180 Call · peak +187%. Combined peak moves are not portfolio return. Educational purposes only.",
    recap,
  );
  assert.ok(!ok.failures.some((f) => f.kind === "UNKNOWN_SYMBOL"), JSON.stringify(ok.failures));
});

test("the required denial passes the screener while the assertion fails", () => {
  assert.equal(screenRecapWording("Combined peak moves are the sum of individual callout peaks, not portfolio return.").ok, true);
  assert.equal(screenRecapWording("These are not realized returns.").ok, true);
  assert.equal(screenRecapWording("That is our realized return for the week.").ok, false);
  // Absolute claims are never rescued by a negation elsewhere.
  assert.equal(screenRecapWording("This is not advice but we made +417%.").ok, false);
});

// ------------------------------------- Watchlist section: link-through, not a "win"

function watchlistRecap() {
  const verified = row({
    symbol: "NVDA", optionSymbol: "O:NVDA260731C00180000", peakPct: 187, trackedPct: 92,
  });
  const linked = { ...verified, alertId: "oa_wl", lane: "WATCHLIST", opportunityCaseId: "oc_wl" };
  return recapOf([verified, linked]);
}

test("the Watchlist section is never labelled a win", () => {
  const recap = watchlistRecap();
  assert.equal(recap.watchlist.eligibleCallouts, 1);
  const text = renderDraft(recap, "D_REPORT_CARD").text;
  assert.match(text, /WATCHLIST → VERIFIED CALLOUTS/);
  assert.doesNotMatch(text, /WATCHLIST WINS/i);
  assert.doesNotMatch(text, /watchlist win/i);
  const page = read("app/weekly-social-recap/page.tsx");
  assert.doesNotMatch(page, /Watchlist wins/i);
  assert.match(page, /Watchlist → verified callouts/);
});

test("the Watchlist section carries its plain-English description and tracking caveat", () => {
  const text = renderDraft(watchlistRecap(), "D_REPORT_CARD").text;
  assert.match(
    text,
    /Watchlist symbols that later produced a verified subscriber callout during the selected period\./,
  );
  assert.match(text, /Watchlist outcome tracking is not yet available/);
  assert.match(text, /no result is assigned to the Watchlist plan itself/);
  assert.match(text, /not included in subscriber totals/i);
  const page = read("app/weekly-social-recap/page.tsx");
  assert.match(page, /Watchlist symbols that later produced a verified subscriber callout/);
  assert.match(page, /Watchlist outcome tracking is not yet available/);
  assert.match(page, /implies the original Watchlist trigger was entered/);
});

test("no return is attributed to the Watchlist plan itself", () => {
  const text = renderDraft(watchlistRecap(), "D_REPORT_CARD").text;
  const line = text.split("\n").find((l) => /later produced verified callout/.test(l));
  assert.ok(line, "the Watchlist link-through line must exist");
  // Figures are attributed to the followed-on callout, never to a bare symbol.
  assert.match(line, /NVDA — later produced verified callout NVDA 07\/31 \$180 Call \(peak \+187%, tracked \+92%\)/);
  assert.doesNotMatch(line, /^\s*NVDA · peak/, "a bare symbol + return would read as the plan's result");
});

test("Watchlist rows never enter subscriber performance totals", () => {
  const recap = watchlistRecap();
  // One verified callout and one Watchlist link-through referencing the same result.
  assert.equal(recap.verifiedSubscriber.eligibleCallouts, 1);
  assert.equal(recap.verifiedSubscriber.combinedPeakMovePct, 187);
  assert.equal(recap.verifiedSubscriber.combinedTrackedResultPct, 92);
  assert.equal(recap.watchlist.eligibleCallouts, 1);
  // The Watchlist lane is tallied separately and does not double the subscriber sums.
  assert.notEqual(
    recap.verifiedSubscriber.combinedPeakMovePct,
    (recap.verifiedSubscriber.combinedPeakMovePct ?? 0) + (recap.watchlist.combinedPeakMovePct ?? 0),
  );
  assert.equal(recap.verifiedSubscriber.winRatePct, 100);
  assert.equal(recap.verifiedSubscriber.closedCallouts, 1, "the Watchlist row is not a second closed callout");
});

test("the Watchlist section stays optional", () => {
  const off = buildWeeklySocialRecap(
    [row(), { ...row(), lane: "WATCHLIST" }],
    { window: WINDOW, nowMs: NOW, includeWatchlist: false },
  );
  assert.equal(off.watchlist.eligibleCallouts, 0);
  assert.equal(off.callouts.watchlist.length, 0);
  const text = renderDraft(off, "D_REPORT_CARD").text;
  assert.doesNotMatch(text, /WATCHLIST → VERIFIED CALLOUTS/);
});

test("the Watchlist section reuses only verified subscriber callout evidence", () => {
  const recap = watchlistRecap();
  for (const c of recap.callouts.watchlist) {
    assert.ok(c.evidence.opportunityCaseId);
    assert.ok(c.evidence.discordMessageId, "must trace to a verified subscriber delivery");
    assert.match(c.evidence.peakSource, /bid/);
    assert.equal(c.evidence.trackedSource, "options_paper_trades/return_pct");
  }
  const sources = read("lib/research/social/weekly-recap-sources.ts");
  assert.match(sources, /no outcome tracking for Watchlist plans/i);
  assert.match(sources, /verifiedRows/, "watchlist rows are derived from verified rows only");
});

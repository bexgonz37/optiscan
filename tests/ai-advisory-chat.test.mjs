import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAdvisoryEvidencePacket,
  validateAdvisoryAnswer,
  extractNumericClaims,
  AI_UNAVAILABLE_MESSAGE,
  CHAT_MODES,
} from "../lib/ai/advisory-chat-evidence.ts";
import {
  answerAdvisoryChat,
  buildFixPrompt,
  SUGGESTED_PROMPTS,
  GLOSSARY,
} from "../lib/ai/advisory-chat.ts";
import {
  ensureAdvisoryChatSchema,
  createConversationOnDb,
  appendMessageOnDb,
  getConversationOnDb,
  listConversationsOnDb,
  renameConversationOnDb,
  deleteConversationOnDb,
  recordFeedbackOnDb,
  redactForPersistence,
  titleFromMessage,
} from "../lib/ai/advisory-chat-store.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const NOW = Date.parse("2026-07-30T02:00:00.000Z");

// A minimal canonical report shaped like buildCanonicalFindingsReport output.
function report(overrides = {}) {
  return {
    reportId: "rep_test_1",
    sourceReportId: 1,
    generatedAtMs: NOW,
    tradingDay: "2026-07-29",
    reportVersion: 1,
    overallState: "LOSING",
    overallConfidence: "HIGH",
    activeProductionPipeline: "options_delivered_paper",
    sourceReferences: ["ai_reports"],
    metrics: [
      {
        id: "paper.verifiedClosedLosses", label: "Verified closed losses", value: 49, unit: "trades",
        pipeline: "options_delivered_paper", lane: "delivered_paper", timeWindow: "all_verified_history",
        sampleSize: 73, confidence: "HIGH", freshness: "current",
        source: { table: "options_paper_trades", function: "buildPaperChainDiagnostic", field: "return_pct" },
        qualityStatus: "VALID", safeForTopLine: true,
        meaning: "Closed trades with a verified loss.", whyItMatters: "Size of the problem.", better: "lower",
      },
      {
        id: "paper.downTwentyByFiveMin", label: "Losses already down 20% by five minutes", value: 37, unit: "trades",
        pipeline: "options_delivered_paper", lane: "delivered_paper", timeWindow: "all_verified_history",
        sampleSize: 49, confidence: "HIGH", freshness: "current",
        source: { table: "options_paper_marks", function: "analyzeExitPolicies", field: "entryReturns" },
        qualityStatus: "VALID", safeForTopLine: true,
        meaning: "Losers that were already deeply negative five minutes in.", whyItMatters: "Points at entries.", better: "lower",
      },
      {
        id: "discord.sentToday", label: "Alerts sent", value: 59, unit: "alerts",
        pipeline: "discord_delivery", lane: "subscriber_alerts", timeWindow: "last_24h",
        sampleSize: 59, confidence: "HIGH", freshness: "current",
        source: { table: "discord_deliveries", function: "discordHealth", field: "status" },
        qualityStatus: "VALID", safeForTopLine: true,
        meaning: "Alerts delivered in 24h.", whyItMatters: "Delivery volume.", better: "neutral",
      },
      {
        id: "paper.missingMetric", label: "Unavailable sample metric", value: null, unit: "%",
        pipeline: "options_delivered_paper", lane: "delivered_paper", timeWindow: "all_verified_history",
        sampleSize: null, confidence: "LOW", freshness: "unknown",
        source: { table: "n/a", function: "n/a", field: "n/a" },
        qualityStatus: "MISSING_DATA", safeForTopLine: false,
        meaning: "Not computable from stored data.", whyItMatters: "Gap.", better: "neutral",
      },
    ],
    topFindings: [], workingFindings: [], failingFindings: [], dataQualityFindings: [],
    missedOpportunities: {}, timingFindings: [], entryFindings: [], exitFindings: [],
    discordFindings: [], paperFindings: [],
    callsVsPuts: { call: {}, put: {}, comparison: "NO_VALID_COMPARISON" },
    strategyFindings: [], recommendedInvestigations: [], fixQueue: [], researchQuestionRegistry: [],
    narrative: { status: null, message: "" },
    dataGaps: ["No timestamped underlying observations stored."],
    safety: {
      productionBehaviorChanged: false,
      aiAuthority: "ADVISORY_ONLY",
      liveBehaviorChangeSource: "HUMAN_REVIEWED_CODE_DEPLOYMENT_ONLY",
    },
    ...overrides,
  };
}

const supplemental = {
  exitPolicy: {
    minimumSupportedSample: 30,
    bestSupportedPolicy: "Trail 10%",
    profitableThenLostCount: 6,
    profitableTradeCount: 29,
    policies: [
      { policy: "Current policy", sampleSize: 73, winRatePct: 27.4, averageReturnPct: -27.7668, totalPnlUsd: -6242.0005, supported: true },
      { policy: "Trail 10%", sampleSize: 73, winRatePct: 30.14, averageReturnPct: -26.2307, totalPnlUsd: -5498.5998, supported: true },
      { policy: "Underlying thesis exit", sampleSize: 0, winRatePct: null, averageReturnPct: null, totalPnlUsd: 0, supported: false },
      { policy: "0DTE protection", sampleSize: 21, winRatePct: 23.81, averageReturnPct: -41.3883, totalPnlUsd: -2495.2, supported: false },
    ],
  },
  watchlist: {
    publishedCount: 0,
    candidatesConsidered: 58,
    vwapUsable: 0,
    vwapUnavailable: 58,
    marketContextAvailable: true,
    blockers: ["No candidate carries a usable VWAP reference."],
  },
};

function packet() {
  return buildAdvisoryEvidencePacket(report(), supplemental);
}

// ------------------------------------------------------- grounding + validation

test("the packet is built only from canonical findings and named supplemental sources", () => {
  const p = packet();
  assert.equal(p.reportId, "rep_test_1");
  assert.ok(p.items.some((i) => i.id === "paper.verifiedClosedLosses"));
  assert.ok(p.items.some((i) => i.id === "exit.policy.trail_10_.avgReturnPct"));
  assert.ok(p.items.some((i) => i.id === "watchlist.publishedCount"));
  assert.equal(p.safety.aiAuthority, "ADVISORY_ONLY");
  assert.equal(p.safety.productionBehaviorChanged, false);
  for (const item of p.items) {
    assert.ok(item.pipeline && item.lane && item.timeWindow, `${item.id} must carry pipeline/lane/window`);
    assert.ok(item.sourceRef, `${item.id} must carry a source reference`);
    assert.ok(item.confidence && item.qualityStatus, `${item.id} must carry confidence and quality`);
  }
});

test("a supported answer citing real evidence passes validation", () => {
  const p = packet();
  const res = validateAdvisoryAnswer({
    answer: "Delivered entries are the primary observed weakness: 49 verified closed losses, and 37 were already down at least 20% by the five-minute mark.",
    citedEvidenceIds: ["paper.verifiedClosedLosses", "paper.downTwentyByFiveMin"],
    packet: p,
    supplemental,
  });
  assert.equal(res.ok, true, JSON.stringify(res.failures));
  assert.deepEqual(res.numbersChecked.sort(), ["20", "37", "49"].sort());
});

test("an unsupported number is rejected", () => {
  const res = validateAdvisoryAnswer({
    answer: "There were 51 verified closed losses.",
    citedEvidenceIds: ["paper.verifiedClosedLosses"],
    packet: packet(),
    supplemental,
  });
  assert.equal(res.ok, false);
  assert.ok(res.failures.some((f) => f.kind === "UNSUPPORTED_NUMBER" && f.token === "51"));
});

test("numbers with no citation at all are rejected", () => {
  const res = validateAdvisoryAnswer({
    answer: "You had 49 losses.",
    citedEvidenceIds: [],
    packet: packet(),
    supplemental,
  });
  assert.equal(res.ok, false);
  assert.ok(res.failures.some((f) => f.kind === "NO_CITATION"));
});

test("an invented evidence id is rejected", () => {
  const res = validateAdvisoryAnswer({
    answer: "Entries are weak.",
    citedEvidenceIds: ["paper.doesNotExist"],
    packet: packet(),
    supplemental,
  });
  assert.equal(res.ok, false);
  assert.ok(res.failures.some((f) => f.kind === "UNKNOWN_EVIDENCE_ID"));
});

test("mixing pipelines or windows in one answer is blocked", () => {
  const mixedPipeline = validateAdvisoryAnswer({
    answer: "Across the system there were 49 losses and 59 alerts.",
    citedEvidenceIds: ["paper.verifiedClosedLosses", "discord.sentToday"],
    packet: packet(),
    supplemental,
  });
  assert.equal(mixedPipeline.ok, false);
  assert.ok(mixedPipeline.failures.some(
    (f) => f.kind === "PIPELINE_WINDOW_MIXED" && /pipelines/.test(f.detail),
  ));
  assert.ok(mixedPipeline.failures.some(
    (f) => f.kind === "PIPELINE_WINDOW_MIXED" && /time windows/.test(f.detail),
  ));
});

test("a missing metric is never rendered as zero", () => {
  const res = validateAdvisoryAnswer({
    answer: "The Unavailable sample metric is 0 right now.",
    citedEvidenceIds: ["paper.missingMetric"],
    packet: packet(),
    supplemental,
  });
  assert.equal(res.ok, false);
  assert.ok(res.failures.some((f) => f.kind === "MISSING_TREATED_AS_ZERO"));
});

test("the least-bad losing policy can never be called profitable or winning", () => {
  for (const wording of [
    "Trail 10% is profitable and should be adopted.",
    "Trail 10% is the winning policy.",
    "Trail 10% makes money over the sample.",
  ]) {
    const res = validateAdvisoryAnswer({
      answer: wording,
      citedEvidenceIds: ["exit.policy.trail_10_.avgReturnPct"],
      packet: packet(),
      supplemental,
    });
    assert.equal(res.ok, false, wording);
    assert.ok(res.failures.some((f) => f.kind === "PROFIT_CLAIM_ON_LOSING_POLICY"), wording);
  }
  // Describing it accurately is allowed.
  const honest = validateAdvisoryAnswer({
    answer: "Trail 10% is only less bad than the current policy at -26.2307%, not profitable.",
    citedEvidenceIds: ["exit.policy.trail_10_.avgReturnPct"],
    packet: packet(),
    supplemental,
  });
  assert.equal(honest.ok, true, JSON.stringify(honest.failures));
});

test("mandatory caveats state the losing-policy, zero-sample, and Watchlist truths", () => {
  const p = packet();
  const all = p.mandatoryCaveats.join(" ");
  assert.match(all, /ADVISORY ONLY/);
  assert.match(all, /Trail 10% is only LESS BAD/);
  assert.match(all, /never be described as a winning or profitable policy/);
  assert.match(all, /Underlying thesis exit has no evaluable trades \(sample size 0\)/);
  assert.match(all, /0DTE protection is below the minimum supported sample \(21 of 30\)/);
  assert.match(all, /Watchlist currently publishes 0 qualified rows/);
  assert.match(all, /evidence gate working, not a bug/);
});

test("the assistant may never claim it changed production", () => {
  for (const wording of [
    "I have updated the exit policy for you.",
    "I just deployed the fix.",
    "We enabled the new threshold.",
    "Production has been changed.",
  ]) {
    const res = validateAdvisoryAnswer({
      answer: wording, citedEvidenceIds: [], packet: packet(), supplemental,
    });
    assert.equal(res.ok, false, wording);
    assert.ok(res.failures.some((f) => f.kind === "PRODUCTION_CHANGE_CLAIM"), wording);
  }
});

test("years are not treated as quantitative claims", () => {
  assert.ok(!extractNumericClaims("In 2026 the report changed.").includes("2026"));
  assert.deepEqual(extractNumericClaims("49 losses and 6,242 dollars"), ["49", "6,242"]);
});

// -------------------------------------------------------------- runtime behaviour

function fakeFetch(payload) {
  return async () => new Response(JSON.stringify({
    content: [{ type: "tool_use", name: "advisory_answer", input: payload }],
    usage: { input_tokens: 100, output_tokens: 50 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const AI_ENV = { AI_ENABLED: "1", ANTHROPIC_API_KEY: "sk-ant-test", AI_WEEKLY_MODEL: "claude-sonnet-5" };

test("a valid model answer is returned with its evidence and safety flags", async () => {
  const out = await answerAdvisoryChat({
    question: "Why are we losing money?",
    mode: "EXPLAIN",
    report: report(),
    supplemental,
    deps: {
      env: AI_ENV,
      fetchImpl: fakeFetch({
        answer: "Entries look like the bigger problem: there are 49 verified closed losses and 37 were already down 20% by the five-minute mark.",
        citedEvidenceIds: ["paper.verifiedClosedLosses", "paper.downTwentyByFiveMin"],
      }),
    },
  });
  assert.equal(out.validationStatus, "VALID");
  assert.equal(out.degraded, false);
  assert.equal(out.safety.aiAuthority, "ADVISORY_ONLY");
  assert.equal(out.safety.productionBehaviorChanged, false);
  assert.deepEqual(out.citedEvidenceIds, ["paper.verifiedClosedLosses", "paper.downTwentyByFiveMin"]);
});

test("an answer with a hallucinated number is withheld and findings survive", async () => {
  const out = await answerAdvisoryChat({
    question: "How bad is it?",
    report: report(),
    supplemental,
    deps: {
      env: AI_ENV,
      fetchImpl: fakeFetch({
        answer: "There were 512 verified closed losses totalling $99,999.",
        citedEvidenceIds: ["paper.verifiedClosedLosses"],
      }),
    },
  });
  assert.equal(out.degraded, true);
  assert.equal(out.validationStatus, "REJECTED_VALIDATION");
  assert.equal(out.answer, AI_UNAVAILABLE_MESSAGE);
  assert.ok(out.validationFailures.some((f) => f.kind === "UNSUPPORTED_NUMBER"));
  assert.ok(out.evidence.length > 0, "deterministic evidence is still returned");
});

test("provider failure, timeout, and disabled AI all degrade without throwing", async () => {
  const failed = await answerAdvisoryChat({
    question: "q", report: report(), supplemental,
    deps: { env: AI_ENV, fetchImpl: async () => { throw new Error("network down"); } },
  });
  assert.equal(failed.answer, AI_UNAVAILABLE_MESSAGE);
  assert.equal(failed.degraded, true);
  assert.ok(failed.evidence.length > 0);

  const http500 = await answerAdvisoryChat({
    question: "q", report: report(), supplemental,
    deps: { env: AI_ENV, fetchImpl: async () => new Response("boom", { status: 500 }) },
  });
  assert.equal(http500.degraded, true);

  const disabled = await answerAdvisoryChat({
    question: "q", report: report(), supplemental,
    deps: { env: { AI_ENABLED: "0" }, fetchImpl: async () => { throw new Error("must not be called"); } },
  });
  assert.equal(disabled.validationStatus, "AI_DISABLED");
  assert.equal(disabled.answer, AI_UNAVAILABLE_MESSAGE);
});

test("with no evidence the chat refuses rather than speculating", async () => {
  const out = await answerAdvisoryChat({
    question: "q",
    report: report({ metrics: [] }),
    deps: { env: AI_ENV, fetchImpl: async () => { throw new Error("must not be called"); } },
  });
  assert.equal(out.validationStatus, "NO_EVIDENCE_AVAILABLE");
  assert.equal(out.answer, AI_UNAVAILABLE_MESSAGE);
});

test("Watchlist evidence gaps are explained accurately from real numbers", () => {
  const p = packet();
  const wl = p.items.find((i) => i.id === "watchlist.vwapUnavailable");
  assert.equal(wl.value, 58);
  const res = validateAdvisoryAnswer({
    answer: "The Watchlist publishes 0 qualified rows because 58 of 58 candidates have no usable VWAP reference.",
    citedEvidenceIds: ["watchlist.publishedCount", "watchlist.vwapUnavailable", "watchlist.candidatesConsidered"],
    packet: p,
    supplemental,
  });
  assert.equal(res.ok, true, JSON.stringify(res.failures));
});

// --------------------------------------------------------------- fix prompt export

test("the fix prompt is deterministic, evidence-bearing, and export-only", () => {
  const prompt = buildFixPrompt({
    question: "Why are entries failing?",
    packet: packet(),
    citedEvidenceIds: ["paper.verifiedClosedLosses"],
    finding: "Entries are the primary weakness.",
  });
  assert.match(prompt, /## Question\nWhy are entries failing\?/);
  assert.match(prompt, /## Finding\nEntries are the primary weakness\./);
  assert.match(prompt, /Verified closed losses = 49 trades/);
  assert.match(prompt, /pipeline=options_delivered_paper/);
  assert.match(prompt, /sample=73/);
  assert.match(prompt, /source=options_paper_trades\/buildPaperChainDiagnostic\/return_pct/);
  assert.match(prompt, /reportId=rep_test_1/);
  // Safety constraints must be present verbatim.
  assert.match(prompt, /Do NOT change scanner formulas, scoring weights, thresholds, targets, stops/);
  assert.match(prompt, /Do NOT apply live changes automatically/);
  assert.match(prompt, /Do NOT send Discord messages, trigger scans, or modify Railway variables/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /npx tsc --noEmit --incremental false/);
});

test("a fix prompt is still available when the model is unavailable", async () => {
  const out = await answerAdvisoryChat({
    question: "Build an investigation prompt.",
    mode: "BUILD_FIX_PROMPT",
    report: report(),
    supplemental,
    deps: { env: { AI_ENABLED: "0" }, fetchImpl: async () => { throw new Error("no"); } },
  });
  assert.equal(out.degraded, true);
  assert.ok(out.fixPrompt && out.fixPrompt.includes("Do NOT apply live changes automatically"));
});

test("there is no APPLY mode anywhere in the chat surface", () => {
  assert.deepEqual(CHAT_MODES, ["EXPLAIN", "INVESTIGATE", "COMPARE", "BUILD_FIX_PROMPT"]);
  const ui = read("components/AdvisoryChat.tsx");
  assert.doesNotMatch(ui, /APPLY[_\s]?CHANGES/i);
  assert.match(ui, /No APPLY mode exists by design/);
  const runtime = read("lib/ai/advisory-chat.ts");
  assert.doesNotMatch(runtime, /"APPLY"|APPLY_CHANGES/);
});

// ----------------------------------------------------------------- persistence

test("conversation history persists with evidence refs, model, and validation status", () => {
  const d = new Database(":memory:");
  ensureAdvisoryChatSchema(d);
  const conv = createConversationOnDb(d, { title: titleFromMessage("Why are we losing money?"), mode: "EXPLAIN", nowMs: NOW });
  appendMessageOnDb(d, { conversationId: conv.conversationId, role: "user", content: "Why are we losing money?", mode: "EXPLAIN", nowMs: NOW });
  const assistantId = appendMessageOnDb(d, {
    conversationId: conv.conversationId,
    role: "assistant",
    content: "Entries look like the bigger problem.",
    mode: "EXPLAIN",
    evidenceIds: ["paper.verifiedClosedLosses"],
    reportId: "rep_test_1",
    model: "claude-sonnet-5",
    validationStatus: "VALID",
    nowMs: NOW + 1000,
  });
  const loaded = getConversationOnDb(d, conv.conversationId);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.conversation.messageCount, 2);
  assert.deepEqual(loaded.messages[1].evidenceIds, ["paper.verifiedClosedLosses"]);
  assert.equal(loaded.messages[1].model, "claude-sonnet-5");
  assert.equal(loaded.messages[1].reportId, "rep_test_1");
  assert.equal(loaded.messages[1].validationStatus, "VALID");

  assert.equal(recordFeedbackOnDb(d, { conversationId: conv.conversationId, messageId: assistantId, feedback: "down", note: "too vague" }), true);
  assert.equal(getConversationOnDb(d, conv.conversationId).messages[1].feedback, "down");

  assert.equal(renameConversationOnDb(d, conv.conversationId, "Loss investigation", NOW + 2000), true);
  assert.equal(listConversationsOnDb(d)[0].title, "Loss investigation");

  assert.equal(deleteConversationOnDb(d, conv.conversationId, NOW + 3000), true);
  assert.equal(listConversationsOnDb(d).length, 0);
  assert.equal(getConversationOnDb(d, conv.conversationId), null);
});

test("feedback only attaches to assistant messages", () => {
  const d = new Database(":memory:");
  ensureAdvisoryChatSchema(d);
  const conv = createConversationOnDb(d, { nowMs: NOW });
  const userId = appendMessageOnDb(d, { conversationId: conv.conversationId, role: "user", content: "hi", nowMs: NOW });
  assert.equal(recordFeedbackOnDb(d, { conversationId: conv.conversationId, messageId: userId, feedback: "up" }), false);
});

test("secrets are never persisted, even if pasted into the chat", () => {
  const secrets = [
    "my key is sk-ant-abc123def456ghi",
    "webhook https://discord.com/api/webhooks/12345/abcdefghijk",
    "SCAN_API_TOKEN=supersecretvalue",
    "Authorization: Bearer abcdefghijklmnop",
  ];
  for (const s of secrets) {
    const red = redactForPersistence(s);
    assert.match(red, /\[REDACTED\]/, s);
  }
  assert.doesNotMatch(redactForPersistence(secrets[0]), /abc123def456ghi/);
  assert.doesNotMatch(redactForPersistence(secrets[1]), /abcdefghijk/);
  assert.doesNotMatch(redactForPersistence(secrets[2]), /supersecretvalue/);

  const d = new Database(":memory:");
  ensureAdvisoryChatSchema(d);
  const conv = createConversationOnDb(d, { nowMs: NOW });
  appendMessageOnDb(d, { conversationId: conv.conversationId, role: "user", content: secrets[0], nowMs: NOW });
  const stored = d.prepare("SELECT content FROM ai_chat_messages").get().content;
  assert.doesNotMatch(stored, /abc123def456ghi/);
});

// ------------------------------------------------------------- safety boundaries

test("the chat execution path imports nothing from scanner, delivery, or Discord", () => {
  const chatFiles = [
    "lib/ai/advisory-chat.ts",
    "lib/ai/advisory-chat-evidence.ts",
    "lib/ai/advisory-chat-store.ts",
  ];
  const forbidden = [
    /from "[^"]*scanner-loop/, /from "[^"]*alert-capture/, /from "[^"]*stock-capture/,
    /from "[^"]*options\/delivery/, /from "[^"]*discord/i, /from "[^"]*notifications/,
    /from "[^"]*options\/grade/, /from "[^"]*market-session-guard/,
  ];
  for (const f of chatFiles) {
    const src = read(f);
    for (const re of forbidden) {
      assert.doesNotMatch(src, re, `${f} must not import ${re}`);
    }
  }
});

test("no chat file can write trading state, send Discord, or touch Railway", () => {
  const files = [
    "lib/ai/advisory-chat.ts",
    "lib/ai/advisory-chat-evidence.ts",
    "lib/ai/advisory-chat-store.ts",
    "lib/ai/advisory-chat-sources.ts",
    "app/api/ai/advisory-chat/route.ts",
    "app/api/ai/advisory-chat/[conversationId]/route.ts",
    "app/api/ai/advisory-chat/[conversationId]/feedback/route.ts",
  ];
  for (const f of files) {
    const src = read(f);
    // Only chat tables may be written.
    for (const m of src.match(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/gi) ?? []) {
      const table = m.split(/\s+/).pop();
      assert.ok(
        /^ai_chat_(conversations|messages)$/.test(table),
        `${f} writes non-chat table ${table}`,
      );
    }
    assert.doesNotMatch(src, /sendDiscord|postDiscord|deliverOptionsCallout|sendOwnerResearchNotify/i, f);
    // Reading a Railway credential or calling its API — mentioning the name in a
    // redaction denylist is the opposite of using it, so match real usage only.
    assert.doesNotMatch(src, /process\.env\.RAILWAY_TOKEN|railway\.app\/graphql|backboard\.railway/i, f);
    assert.doesNotMatch(src, /runOptionsMonitorCycle|gradeOpenOptionPositions|captureZeroDte/i, f);
    assert.doesNotMatch(src, /writeFileSync|execSync|spawnSync|child_process/i, f);
  }
});

test("chat sources read canonical surfaces rather than arbitrary raw tables", () => {
  const src = read("lib/ai/advisory-chat-sources.ts");
  assert.match(src, /buildCanonicalFindingsReport/);
  assert.match(src, /buildPaperChainDiagnostic/);
  assert.match(src, /loadOvernightPlan/);
  // No hand-rolled SQL against raw tables in the chat source path.
  assert.doesNotMatch(src, /SELECT\s+.*\s+FROM\s+/i);
});

test("every chat route requires authentication", () => {
  const routes = [
    "app/api/ai/advisory-chat/route.ts",
    "app/api/ai/advisory-chat/[conversationId]/route.ts",
    "app/api/ai/advisory-chat/[conversationId]/feedback/route.ts",
  ];
  for (const r of routes) {
    const src = read(r);
    const handlers = src.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? [];
    assert.ok(handlers.length > 0, `${r} defines no handlers`);
    const guards = src.match(/if \(!checkApiToken\(req\)\) return unauthorized\(\);/g) ?? [];
    assert.equal(guards.length, handlers.length, `${r} must guard every handler`);
  }
});

test("the UI shows the authority banners and cannot apply anything", () => {
  const ui = read("components/AdvisoryChat.tsx");
  assert.match(ui, /AI AUTHORITY: ADVISORY ONLY/);
  assert.match(ui, /PRODUCTION BEHAVIOR CHANGED: NO/);
  assert.match(ui, /Copying this text is the only action available/);
  const page = read("app/ai/page.tsx");
  assert.match(page, /"CHAT"/);
  assert.match(page, /<AdvisoryChat \/>/);
});

test("suggested prompts and glossary cover the required plain-English surface", () => {
  const prompts = SUGGESTED_PROMPTS.map((p) => p.prompt);
  for (const expected of [
    "What should I investigate first?",
    "Why is OptiScan losing money?",
    "Are entries or exits the bigger problem?",
    "Which trades gave back profits?",
    "Why are there no Watchlist setups?",
    "What is working?",
    "What data is missing?",
    "Are CALLS or PUTS performing better?",
    "Explain today's report in plain English.",
    "Build a Claude/Codex investigation prompt.",
  ]) {
    assert.ok(prompts.includes(expected), `missing suggested prompt: ${expected}`);
  }
  for (const term of ["MFE", "MAE", "capture efficiency", "expectancy", "profit factor", "delta band"]) {
    assert.ok(GLOSSARY[term], `glossary must define ${term}`);
  }
  assert.match(GLOSSARY["capture efficiency"], /how much of a trade's best available gain the exit policy actually kept/);
});

test("chat migrations are additive and repeat-safe", () => {
  const dbsrc = read("lib/db.ts");
  assert.match(dbsrc, /CREATE TABLE IF NOT EXISTS ai_chat_conversations/);
  assert.match(dbsrc, /CREATE TABLE IF NOT EXISTS ai_chat_messages/);
  assert.doesNotMatch(dbsrc, /DROP TABLE\s+ai_chat/i);
  // Running the schema twice must be safe.
  const d = new Database(":memory:");
  ensureAdvisoryChatSchema(d);
  ensureAdvisoryChatSchema(d);
  assert.equal(
    d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'ai_chat_%'").get().n,
    2,
  );
});

test("no chatbot file reaches into the live scanner or delivery directories", () => {
  // Guard against a future edit wiring the chat into execution paths.
  const chatDir = join(root, "app/api/ai/advisory-chat");
  const walk = (dir) => readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
  const files = walk(chatDir);
  assert.ok(files.length >= 3, "expected the three chat routes");
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /research\/options\/(delivery|grade|discovery)/, f);
    assert.doesNotMatch(src, /scanner-loop|alert-capture/, f);
  }
});

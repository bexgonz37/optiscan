/**
 * audit-historical-content.mjs — owner-only forensic audit of the historical
 * report cards that reached the private Recaps channel.
 *
 * Answers, per delivered Discord message and per canonical outcome:
 *   which drafts exist, which were delivered, which were duplicates of an
 *   outcome already reported, what the displayed contract was, where the
 *   displayed return came from, and whether the failure explanation is
 *   grounded in stored evidence or is template language.
 *
 * Read-only. Issues no provider calls and writes nothing to the database.
 * The token is read from SCAN_API_TOKEN and never printed.
 *
 *   railway run -- node scripts/audit-historical-content.mjs [--json out.json]
 */
const BASE = process.env.OPTISCAN_BASE_URL || "https://optiscan-production.up.railway.app";
const TOKEN = process.env.SCAN_API_TOKEN || "";
if (!TOKEN) {
  console.error("SCAN_API_TOKEN is not present. Run through `railway run`.");
  process.exit(3);
}

const PERFORMANCE_CATEGORIES = [
  "CLOSED_LOSER", "CLOSED_WINNER", "WHY_THIS_FAILED", "WHY_THIS_WORKED",
  "RETURN_MILESTONE", "NEW_HIGH",
];

/** Categories that report the SAME closed outcome, just in different words. */
const OUTCOME_REPORT_CATEGORIES = new Set([
  "CLOSED_LOSER", "CLOSED_WINNER", "WHY_THIS_FAILED", "WHY_THIS_WORKED",
]);

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "x-scan-token": TOKEN, accept: "application/json" },
    signal: AbortSignal.timeout(Number(process.env.DIAG_TIMEOUT_MS ?? 60_000)),
  });
  const text = await res.text();
  if (!res.ok) return { httpStatus: res.status, ok: false, body: text.slice(0, 400) };
  try { return { httpStatus: res.status, ...JSON.parse(text) }; }
  catch { return { httpStatus: res.status, ok: false, body: text.slice(0, 400) }; }
}

/**
 * Generic template sentences that describe a market CONDITION. None of them
 * states a mechanism by which the option lost, so none may stand alone as a
 * verified cause. Matched against the rendered draft text.
 */
const TEMPLATE_CONDITION_PHRASES = [
  /structure intact/i, /vwap reject/i, /sellers kept control/i,
  /buyers kept control/i, /lower high/i, /higher low/i,
  /continuation/i, /reclaimed/i, /held (support|resistance)/i,
];

/** A failure draft that reprints a BULLISH/BEARISH thesis as the loss cause. */
function contradictionCheck(category, text, optionType) {
  if (category !== "WHY_THIS_FAILED") return null;
  const t = String(text || "");
  const bearishThesis = /bearish|lower high|breakdown|sellers/i.test(t);
  const bullishThesis = /bullish|higher low|breakout|buyers/i.test(t);
  const type = String(optionType || "").toUpperCase();
  // A PUT that lost while the draft asserts the bearish thesis stayed intact,
  // or a CALL that lost while the draft asserts the bullish thesis stayed
  // intact, is self-contradictory: the stated condition would have WON.
  if (type === "PUT" && bearishThesis && /intact|continuation/i.test(t)) return "BEARISH_THESIS_INTACT_BUT_PUT_LOST";
  if (type === "CALL" && bullishThesis && /intact|continuation/i.test(t)) return "BULLISH_THESIS_INTACT_BUT_CALL_LOST";
  return null;
}

function classifyReturnEvidence(draft) {
  const frozen = draft.frozen_entry;
  const mark = draft.mark_used;
  if (frozen == null && mark == null) return "INSUFFICIENT_EVIDENCE";
  if (frozen == null) return "INSUFFICIENT_EVIDENCE";
  if (mark == null) return "INSUFFICIENT_EVIDENCE";
  // The draft row alone cannot prove the entry was an ASK and the exit a BID.
  // That proof lives in the claim packet; without it the row is at best a mark.
  if (draft.claim_packet_id) return "VERIFIED_ASK_TO_BID";
  return "MIDPOINT_ONLY";
}

function displayedContract(d) {
  const parts = [];
  if (d.expiration) parts.push(String(d.expiration));
  if (d.strike != null) parts.push(`$${d.strike}`);
  if (d.option_type) parts.push(String(d.option_type).toUpperCase());
  return parts.length ? parts.join(" ") : null;
}

async function main() {
  const health = await get("/api/healthz");
  const census = await get("/api/diagnostics/content-delivery");

  const all = [];
  for (const cat of PERFORMANCE_CATEGORIES) {
    const r = await get(`/api/content-drafts?category=${encodeURIComponent(cat)}&limit=200`);
    if (Array.isArray(r?.drafts)) all.push(...r.drafts);
  }

  // ── group by canonical outcome ────────────────────────────────────────
  // The canonical outcome is the opportunity case. CLOSED_* and WHY_THIS_*
  // are two content EVENTS describing one closure, so grouping on the event
  // id would hide exactly the duplication we are auditing.
  const byOutcome = new Map();
  for (const d of all) {
    const key = d.opportunity_case_id || `noCase:${d.content_event_id}`;
    if (!byOutcome.has(key)) byOutcome.set(key, []);
    byOutcome.get(key).push(d);
  }

  const messages = [];
  const outcomes = [];
  for (const [caseId, drafts] of byOutcome) {
    drafts.sort((a, b) => (a.created_at_ms || 0) - (b.created_at_ms || 0));
    const sent = drafts.filter((d) => d.discord_delivery_status === "SENT");
    const events = new Set(drafts.map((d) => d.content_event_id));
    const reportEvents = new Set(
      drafts.filter((d) => OUTCOME_REPORT_CATEGORIES.has(d.category)).map((d) => d.content_event_id),
    );
    const sentReportEvents = new Set(
      sent.filter((d) => OUTCOME_REPORT_CATEGORIES.has(d.category)).map((d) => d.content_event_id),
    );

    outcomes.push({
      canonicalOutcomeId: caseId,
      symbol: drafts[0]?.symbol ?? null,
      totalDrafts: drafts.length,
      contentEvents: events.size,
      outcomeReportEvents: reportEvents.size,
      sentDrafts: sent.length,
      distinctDiscordMessages: new Set(sent.map((d) => d.discord_message_id).filter(Boolean)).size,
      /** > 1 means one closure produced more than one Discord report card. */
      duplicateOutcomeMessages: Math.max(0, sentReportEvents.size - 1),
      categories: [...new Set(drafts.map((d) => d.category))],
    });

    for (const d of drafts) {
      const contradiction = contradictionCheck(d.category, d.draft_text, d.option_type);
      const templatePhrase = TEMPLATE_CONDITION_PHRASES.some((re) => re.test(String(d.draft_text || "")));
      const returnEvidence = classifyReturnEvidence(d);
      const duplicative = OUTCOME_REPORT_CATEGORIES.has(d.category) && sentReportEvents.size > 1;

      let classification;
      if (contradiction) classification = "CONTRADICTORY_FAILURE_EXPLANATION";
      else if (d.category === "WHY_THIS_FAILED" && templatePhrase) classification = "UNSUPPORTED_FAILURE_EXPLANATION";
      else if (returnEvidence === "INSUFFICIENT_EVIDENCE") classification = "RETURN_EVIDENCE_INSUFFICIENT";
      else if (duplicative) classification = "SAFE_BUT_DUPLICATIVE";
      else classification = "SAFE_VERIFIED_REPORT_CARD";

      messages.push({
        draftId: d.id,
        contentEventId: d.content_event_id,
        discordMessageId: d.discord_message_id ?? null,
        canonicalOutcomeId: d.opportunity_case_id ?? null,
        alertId: d.alert_id ?? null,
        claimPacketId: d.claim_packet_id ?? null,
        symbol: d.symbol ?? null,
        displayedContract: displayedContract(d),
        strike: d.strike ?? null,
        expiration: d.expiration ?? null,
        optionType: d.option_type ?? null,
        category: d.category,
        templateFamily: d.template_family,
        resultType: d.result_type ?? null,
        sessionDate: d.trading_session_date ?? null,
        generatedAtMs: d.created_at_ms ?? null,
        deliveredAtMs: d.discord_last_attempt_at_ms ?? null,
        deliveryStatus: d.discord_delivery_status,
        deliveryReason: d.discord_delivery_reason ?? null,
        frozenEntry: d.frozen_entry ?? null,
        markUsed: d.mark_used ?? null,
        returnEvidence,
        containsTemplateConditionPhrase: templatePhrase,
        contradiction,
        classification,
        shouldHaveBeenDeliveredIndividually: !duplicative,
      });
    }
  }

  const tally = (rows, key) => rows.reduce((m, r) => { const k = r[key] ?? "<null>"; m[k] = (m[k] || 0) + 1; return m; }, {});
  const sentMessages = messages.filter((m) => m.deliveryStatus === "SENT");

  const report = {
    generatedAtMs: Date.now(),
    production: {
      sha: health?.commitShort ?? null,
      ok: health?.ok ?? null,
      schemaMissing: health?.schemaMissing ?? null,
    },
    census: census?.census ?? null,
    totals: {
      draftsExamined: messages.length,
      draftsDelivered: sentMessages.length,
      uniqueCanonicalOutcomes: outcomes.length,
      outcomesWithDuplicateReportCards: outcomes.filter((o) => o.duplicateOutcomeMessages > 0).length,
      duplicateOutcomeMessages: outcomes.reduce((n, o) => n + o.duplicateOutcomeMessages, 0),
    },
    classificationCounts: tally(messages, "classification"),
    deliveredClassificationCounts: tally(sentMessages, "classification"),
    returnEvidenceCounts: tally(messages, "returnEvidence"),
    contradictionCounts: tally(messages.filter((m) => m.contradiction), "contradiction"),
    bySymbol: tally(sentMessages, "symbol"),
    outcomes: outcomes.sort((a, b) => b.duplicateOutcomeMessages - a.duplicateOutcomeMessages),
    messages,
  };

  const jsonIdx = process.argv.indexOf("--json");
  if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(report, null, 2));
  }

  console.log("=== HISTORICAL CONTENT AUDIT ===");
  console.log(`production ${report.production.sha} ok=${report.production.ok}`);
  console.log(JSON.stringify({
    totals: report.totals,
    classificationCounts: report.classificationCounts,
    deliveredClassificationCounts: report.deliveredClassificationCounts,
    returnEvidenceCounts: report.returnEvidenceCounts,
    contradictionCounts: report.contradictionCounts,
    bySymbol: report.bySymbol,
  }, null, 2));
  console.log("\n=== outcomes with duplicate report cards (top 15) ===");
  for (const o of report.outcomes.filter((x) => x.duplicateOutcomeMessages > 0).slice(0, 15)) {
    console.log(JSON.stringify(o));
  }
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  renderLine,
  renderTemplate,
  buildDraftBundle,
  eligibleCategories,
} from "../lib/content/content-event-engine.ts";
import {
  varsForEventRow,
  bundleForEventRow,
  formatBundleForDiscord,
  runContentDraftsScan,
} from "../lib/content/content-drafts-runtime.ts";

const RICH_VARS = {
  symbol: "AMD", optionType: "call", strike: 400, expiration: "08/27",
  premium: 5.2, confidence: 0.72, relativeVolume: 4.2, callFlow: 1200,
  sector: "Semiconductors", catalyst: "AI demand", vwap: 398.5, support: 395, resistance: 405,
  underlyingPrice: 399.1, reason: "Reclaimed VWAP on rising call flow",
};

test("renderLine drops a line when a placeholder value is missing (never emits {{token}} or fabricates)", () => {
  assert.equal(renderLine("Rel volume {{relativeVolume}}", { relativeVolume: 4.2 }), "Rel volume 4.2x");
  assert.equal(renderLine("Rel volume {{relativeVolume}}", {}), null); // missing → dropped
  assert.equal(renderLine("static line", {}), "static line");
});

test("renderTemplate keeps static + resolvable lines and drops unresolvable ones", () => {
  const tpl = ["{{symbol}} update", "• Rel volume {{relativeVolume}}", "• Sector {{sector}}", "static tail"];
  const withPartial = renderTemplate(tpl, { symbol: "AMD", relativeVolume: 4.2 }); // no sector
  assert.match(withPartial, /\$AMD update/);
  assert.match(withPartial, /Rel volume 4\.2x/);
  assert.doesNotMatch(withPartial, /Sector/);      // dropped
  assert.match(withPartial, /static tail/);
});

test("eligibleCategories applies deterministic rules by event type + thresholds", () => {
  assert.deepEqual(eligibleCategories("OPPORTUNITY_OPENED", RICH_VARS), ["JUST_ENTERED_RADAR"]);
  // Below confidence/relVol thresholds → OPPORTUNITY_OPENED is not eligible.
  assert.deepEqual(eligibleCategories("OPPORTUNITY_OPENED", { confidence: 0.2, relativeVolume: 1.1 }), []);
  assert.deepEqual(eligibleCategories("RETURN_MILESTONE_REACHED", { milestonePercent: 50 }), ["RETURN_MILESTONE"]);
  assert.deepEqual(eligibleCategories("OPPORTUNITY_CLOSED", { returnPct: 63 }), ["CLOSED_WINNER"]);
  assert.deepEqual(eligibleCategories("OPPORTUNITY_CLOSED", { returnPct: -40 }), ["CLOSED_LOSER"]);
});

test("buildDraftBundle produces 3–5 drafts with char count, hashtags, screenshot, chart, CTA", () => {
  const bundle = buildDraftBundle("JUST_ENTERED_RADAR", RICH_VARS);
  assert.ok(bundle);
  assert.equal(bundle.generatedByLlm, false);
  assert.ok(bundle.drafts.length >= 3 && bundle.drafts.length <= 5, `drafts=${bundle.drafts.length}`);
  for (const d of bundle.drafts) {
    assert.equal(typeof d.text, "string");
    assert.equal(d.charCount, d.text.length);
    assert.ok(d.charCount <= 280, "within X budget");
    assert.doesNotMatch(d.text, /\{\{/); // no unresolved placeholders ever
    assert.ok(d.hashtags.includes("$AMD"));
    assert.ok(d.suggestedScreenshot.length > 0);
    assert.ok(d.suggestedChartAnnotation.length > 0);
    assert.ok(d.suggestedCta.length > 0);
  }
});

test("drafts never contain live-action language", () => {
  const bundle = buildDraftBundle("RETURN_MILESTONE", { symbol: "AMD", optionType: "call", strike: 400, expiration: "08/27", premium: 5.2, milestonePercent: 50, maxReturnPct: 63 });
  assert.ok(bundle);
  for (const d of bundle.drafts) {
    assert.doesNotMatch(d.text.toLowerCase(), /\bbuy now\b|\benter now\b|\bget in now\b/);
  }
});

// ── delivery/runtime: idempotent, private-only, never auto-posts ───────────────
function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE opportunity_content_events (
      id TEXT PRIMARY KEY, opportunity_case_id TEXT, event_type TEXT, symbol TEXT, occurred_at_ms INTEGER,
      frozen_entry REAL, current_mark REAL, return_percent REAL, milestone_percent REAL, max_return_percent REAL,
      direction TEXT, option_type TEXT, strike REAL, expiration TEXT, original_thesis_json TEXT,
      evidence_summary_json TEXT, strategy_key TEXT, content_status TEXT, label TEXT, payload_json TEXT, created_at_ms INTEGER
    );
  `);
  return db;
}
function seedEvent(db, over = {}) {
  const row = {
    id: over.id ?? "ce_1", opportunity_case_id: "oc_1", event_type: "OPPORTUNITY_OPENED", symbol: "AMD",
    occurred_at_ms: 1_700_000_000_000, frozen_entry: 5.2, current_mark: null, return_percent: null,
    milestone_percent: null, max_return_percent: null, direction: "bullish", option_type: "call",
    strike: 400, expiration: "08/27", original_thesis_json: JSON.stringify(["Reclaimed VWAP on rising call flow"]),
    evidence_summary_json: JSON.stringify(["rel vol 4.2x"]), strategy_key: "sr_reclaim", content_status: "PENDING",
    label: null, payload_json: null, created_at_ms: 1_700_000_000_000, ...over,
  };
  db.prepare(`INSERT INTO opportunity_content_events
    (id,opportunity_case_id,event_type,symbol,occurred_at_ms,frozen_entry,current_mark,return_percent,milestone_percent,max_return_percent,direction,option_type,strike,expiration,original_thesis_json,evidence_summary_json,strategy_key,content_status,label,payload_json,created_at_ms)
    VALUES (@id,@opportunity_case_id,@event_type,@symbol,@occurred_at_ms,@frozen_entry,@current_mark,@return_percent,@milestone_percent,@max_return_percent,@direction,@option_type,@strike,@expiration,@original_thesis_json,@evidence_summary_json,@strategy_key,@content_status,@label,@payload_json,@created_at_ms)`).run(row);
  return row;
}

const ENV = { CONTENT_EVENTS_ENABLED: "1" };
function captureDeps() {
  const sent = [];
  return {
    sent,
    deps: {
      send: async (content) => { sent.push(content); return { ok: true, messageId: `m${sent.length}`, error: null }; },
      webhookConfigured: () => true,
      loadCaseVars: () => ({ confidence: 0.72, relativeVolume: 4.2, callFlow: 1200, sector: "Semiconductors", catalyst: "AI demand", vwap: 398.5, support: 395 }),
      now: () => 1_700_000_100_000,
    },
  };
}

test("varsForEventRow maps persisted columns to template variables", () => {
  const db = makeDb();
  const row = seedEvent(db);
  const v = varsForEventRow(row, {});
  assert.equal(v.symbol, "AMD");
  assert.equal(v.premium, 5.2);
  assert.equal(v.reason, "Reclaimed VWAP on rising call flow");
});

test("scan delivers a private bundle, marks DRAFTED, and is idempotent (no re-delivery)", async () => {
  const db = makeDb();
  seedEvent(db);
  const { sent, deps } = captureDeps();

  const first = await runContentDraftsScan(db, deps, ENV);
  assert.equal(first.delivered, 1);
  assert.ok(sent.length >= 1);
  assert.match(sent[0], /CONTENT DRAFTS/);
  assert.match(sent[0], /Never auto-posted/);
  const status = db.prepare("SELECT content_status FROM opportunity_content_events WHERE id='ce_1'").get().content_status;
  assert.equal(status, "DRAFTED");

  // Second scan: the row is no longer PENDING → nothing re-delivered.
  const beforeLen = sent.length;
  const second = await runContentDraftsScan(db, deps, ENV);
  assert.equal(second.delivered, 0);
  assert.equal(sent.length, beforeLen, "no duplicate delivery");
});

test("HARD no-op when disabled or webhook missing (never auto-posts)", async () => {
  const db = makeDb();
  seedEvent(db);
  const { sent, deps } = captureDeps();
  const disabled = await runContentDraftsScan(db, deps, { CONTENT_EVENTS_ENABLED: "0" });
  assert.equal(disabled.delivered, 0);
  assert.equal(sent.length, 0);
  const noWebhook = await runContentDraftsScan(db, { ...deps, webhookConfigured: () => false }, ENV);
  assert.equal(noWebhook.delivered, 0);
  assert.equal(sent.length, 0);
});

test("bundleForEventRow with missing case enrichment still renders (drops signal-dependent lines)", () => {
  const db = makeDb();
  const row = seedEvent(db, { id: "ce_2" });
  const bundle = bundleForEventRow(db, row, { loadCaseVars: () => ({}) }, ENV); // no rel vol / vwap / sector
  assert.ok(bundle, "still produces at least one draft from always-present vars");
  for (const d of bundle.drafts) assert.doesNotMatch(d.text, /\{\{/);
  const msgs = formatBundleForDiscord(bundle);
  assert.ok(msgs.length >= 1 && msgs.every((m) => m.length <= 2000));
});

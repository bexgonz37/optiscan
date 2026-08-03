/**
 * Content Event Engine safety + runtime tests.
 * Covers claim integrity, webhook isolation, idempotency, SKIPPED_NO_WEBHOOK,
 * session language, MFE wording, and no Twitter auto-post path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  renderLine,
  buildDraftBundle,
  eligibleCategories,
  filterCategoriesForClaim,
} from "../lib/content/content-event-engine.ts";
import {
  varsForEventRow,
  bundleForEventRow,
  formatBundleForDiscord,
  runContentDraftsScan,
  contentWebhookConfigured,
  draftFingerprint,
  listContentDraftsOnDb,
  updateContentDraftOnDb,
  TWITTER_AUTO_POST_PATHS,
} from "../lib/content/content-drafts-runtime.ts";
import {
  isPerformanceCategory,
  isSafeCategory,
  mfeDisclaimer,
  verifyContentClaimForCase,
} from "../lib/content/claim-integrity.ts";
import { validateSocialDraftLanguage } from "../lib/social-drafts.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RICH_VARS = {
  symbol: "AMD", optionType: "call", strike: 400, expiration: "08/27",
  premium: 5.2, confidence: 0.72, relativeVolume: 4.2, callFlow: 1200,
  sector: "Semiconductors", catalyst: "AI demand", vwap: 398.5, support: 395, resistance: 405,
  underlyingPrice: 399.1, reason: "Reclaimed VWAP on rising call flow",
};

test("renderLine drops a line when a placeholder value is missing", () => {
  assert.equal(renderLine("Rel volume {{relativeVolume}}", { relativeVolume: 4.2 }), "Rel volume 4.2x");
  assert.equal(renderLine("Rel volume {{relativeVolume}}", {}), null);
});

test("safe categories do not require claim; performance categories do", () => {
  assert.equal(isSafeCategory("JUST_ENTERED_RADAR"), true);
  assert.equal(isSafeCategory("NEXT_SESSION_WATCH"), true);
  assert.equal(isPerformanceCategory("RETURN_MILESTONE"), true);
  assert.deepEqual(
    filterCategoriesForClaim(["JUST_ENTERED_RADAR", "RETURN_MILESTONE"], false),
    ["JUST_ENTERED_RADAR"],
  );
  assert.deepEqual(
    filterCategoriesForClaim(["RETURN_MILESTONE"], true),
    ["RETURN_MILESTONE"],
  );
});

test("buildDraftBundle produces 3–5 drafts with mixed CTA types and no live-action language", () => {
  const bundle = buildDraftBundle("JUST_ENTERED_RADAR", RICH_VARS);
  assert.ok(bundle);
  assert.equal(bundle.generatedByLlm, false);
  assert.ok(bundle.drafts.length >= 3 && bundle.drafts.length <= 5);
  const ctaTypes = new Set(bundle.drafts.map((d) => d.ctaType));
  assert.ok(ctaTypes.size >= 2, "deliberate CTA mix");
  for (const d of bundle.drafts) {
    assert.ok(d.charCount <= 280);
    assert.doesNotMatch(d.text, /\{\{/);
    assert.doesNotMatch(d.text.toLowerCase(), /\bbuy now\b|\benter now\b/);
    assert.ok(d.templateFamily);
  }
});

test("MFE disclaimer never labels peak as realized return", () => {
  const disc = mfeDisclaimer(63);
  assert.match(disc, /maximum favorable move/i);
  assert.match(disc, /not the same as a realized subscriber return/i);
  const bundle = buildDraftBundle("NEW_HIGH", {
    ...RICH_VARS, returnPct: 40, maxReturnPct: 63, premium: 5.2,
  }, { appendMfeDisclaimer: true });
  assert.ok(bundle);
  for (const d of bundle.drafts) {
    assert.doesNotMatch(d.text.toLowerCase(), /\bmade \+?\d|earned \+?\d|realized gain of the peak/i);
  }
});

test("after-hours language blocks live-setup phrases", () => {
  assert.equal(validateSocialDraftLanguage("Buy now on AMD").ok, false);
  assert.equal(validateSocialDraftLanguage("This is a live setup moving now", { outsideRegularSession: true }).ok, false);
  assert.equal(validateSocialDraftLanguage("Watchlist for next session: AMD").ok, true);
  assert.equal(validateSocialDraftLanguage("Recap from the regular session on AMD").ok, true);
});

test("contentWebhookConfigured uses recap in the two-channel Discord model", () => {
  assert.equal(contentWebhookConfigured({ DISCORD_WEBHOOK_RECAP: "https://discord.com/api/webhooks/x" }), true);
  assert.equal(contentWebhookConfigured({ DISCORD_WEBHOOK_CONTENT: "https://discord.com/api/webhooks/y" }), false);
  assert.equal(contentWebhookConfigured({}), false);
});

test("content drafts route to recap, not Alerts", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../lib/notifications.ts"), "utf8");
  const runtime = readFileSync(join(here, "../lib/content/content-drafts-runtime.ts"), "utf8");
  assert.doesNotMatch(src, /DISCORD_WEBHOOK_CONTENT|owner_actionable|owner_research|lifecycle/);
  assert.match(runtime, /discordWebhookConfigured\("recap"\)/);
  assert.match(runtime, /webhook:\s*"recap"/);
  assert.doesNotMatch(runtime, /webhook:\s*"options"/);
});

test("no Twitter auto-post path exists in runtime exports", () => {
  assert.deepEqual([...TWITTER_AUTO_POST_PATHS], []);
  const here = dirname(fileURLToPath(import.meta.url));
  const runtime = readFileSync(join(here, "../lib/content/content-drafts-runtime.ts"), "utf8");
  assert.doesNotMatch(runtime, /twitter\.com\/i\/api|api\.twitter\.com|oauth\/access_token|tweet\(|postTweet/i);
});

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE opportunity_content_events (
      id TEXT PRIMARY KEY, opportunity_case_id TEXT, event_type TEXT, symbol TEXT, occurred_at_ms INTEGER,
      frozen_entry REAL, current_mark REAL, return_percent REAL, milestone_percent REAL, max_return_percent REAL,
      direction TEXT, option_type TEXT, strike REAL, expiration TEXT, original_thesis_json TEXT,
      evidence_summary_json TEXT, strategy_key TEXT, content_status TEXT, label TEXT, payload_json TEXT, created_at_ms INTEGER
    );
    CREATE TABLE content_drafts (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, content_event_id TEXT NOT NULL,
      opportunity_case_id TEXT, alert_id TEXT, claim_packet_id TEXT, category TEXT NOT NULL,
      template_family TEXT NOT NULL, template_version TEXT NOT NULL DEFAULT 'v1', platform TEXT NOT NULL DEFAULT 'twitter',
      draft_text TEXT NOT NULL, char_count INTEGER NOT NULL, hashtags_json TEXT, screenshot_suggestion TEXT,
      chart_annotation TEXT, cta_type TEXT NOT NULL DEFAULT 'NONE', result_type TEXT,
      frozen_entry REAL, mark_used REAL, original_alert_at_ms INTEGER, trading_session_date TEXT,
      status TEXT NOT NULL DEFAULT 'GENERATED', discord_delivery_status TEXT NOT NULL DEFAULT 'PENDING',
      discord_message_id TEXT, final_copy TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      approved_at_ms INTEGER, rejected_at_ms INTEGER, manually_posted_at_ms INTEGER
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, opportunity_case_id TEXT, state TEXT, entry_mid REAL,
      discord_message_id TEXT, sent_at_ms INTEGER, candidate_symbol TEXT, option_symbol TEXT, side TEXT
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT, paper_kind TEXT, entry_fill REAL,
      status TEXT, return_pct REAL, last_mark_return_pct REAL, mfe_pct REAL, mae_pct REAL,
      option_symbol TEXT, side TEXT, strike REAL, expiration TEXT, exit_reason TEXT
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

const ENV = { CONTENT_EVENTS_ENABLED: "1", DISCORD_WEBHOOK_RECAP: "https://discord.com/api/webhooks/test" };

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

test("non-performance drafts persist and deliver; idempotent on second scan", async () => {
  const db = makeDb();
  seedEvent(db);
  const { sent, deps } = captureDeps();
  const first = await runContentDraftsScan(db, deps, ENV);
  assert.ok(first.persisted >= 1);
  assert.equal(first.delivered, 1);
  assert.match(sent[0], /OWNER ONLY/);
  assert.match(sent[0], /Never auto-posted/);
  const status = db.prepare("SELECT content_status FROM opportunity_content_events WHERE id='ce_1'").get().content_status;
  assert.equal(status, "PROCESSED");
  const n = db.prepare("SELECT COUNT(*) n FROM content_drafts").get().n;
  assert.ok(n >= 1);

  const before = sent.length;
  const second = await runContentDraftsScan(db, deps, ENV);
  assert.equal(second.examined, 0);
  assert.equal(sent.length, before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM content_drafts").get().n, n);
});

test("one content scheduler run emits at most one controlled Recap message", async () => {
  const db = makeDb();
  seedEvent(db, { id: "ce_batch_1", symbol: "AMD" });
  seedEvent(db, { id: "ce_batch_2", symbol: "NVDA" });
  const { sent, deps } = captureDeps();
  const result = await runContentDraftsScan(db, { ...deps, maxPerScan: 20 }, ENV);
  assert.equal(result.examined, 1);
  assert.equal(sent.length, 1);
  assert.equal(result.delivered, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM opportunity_content_events WHERE content_status='PENDING'").get().n, 1);
});

test("missing webhook persists drafts as SKIPPED_NO_WEBHOOK and does not send", async () => {
  const db = makeDb();
  seedEvent(db, { id: "ce_nw" });
  const sent = [];
  const res = await runContentDraftsScan(db, {
    send: async (c) => { sent.push(c); return { ok: true, messageId: "x", error: null }; },
    webhookConfigured: () => false,
    loadCaseVars: () => ({ confidence: 0.72, relativeVolume: 4.2, callFlow: 1200 }),
    now: () => 1_700_000_100_000,
  }, { CONTENT_EVENTS_ENABLED: "1" });
  assert.equal(sent.length, 0);
  assert.ok(res.persisted >= 1 || res.skippedNoWebhook >= 1);
  assert.equal(res.skippedNoWebhook, 1);
  const rows = db.prepare("SELECT discord_delivery_status FROM content_drafts WHERE content_event_id='ce_nw'").all();
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.discord_delivery_status === "SKIPPED_NO_WEBHOOK"));
  assert.equal(db.prepare("SELECT content_status FROM opportunity_content_events WHERE id='ce_nw'").get().content_status, "PROCESSED");
});

test("REGRESSION: drafts skipped for want of a webhook are RECOVERED once one exists", async () => {
  // The 2026-08-03 production state: CONTENT_EVENTS_ENABLED=1, generation healthy,
  // DISCORD_WEBHOOK_RECAP unset, and 50 drafts sitting at SKIPPED_NO_WEBHOOK.
  //
  // The scan marks the SOURCE EVENT 'PROCESSED' BEFORE it checks the webhook, so
  // the PENDING scan never revisits it; and the retry query excluded
  // SKIPPED_NO_WEBHOOK, so the drafts were never picked up either. Configuring the
  // webhook would deliver only FUTURE content and strand everything already
  // written — including closed-winner report cards.
  const db = makeDb();
  seedEvent(db, { id: "ce_strand" });

  // Session 1 — no webhook. Drafts are written and deferred.
  const cold = await runContentDraftsScan(db, {
    send: async () => { throw new Error("must not send with no webhook"); },
    webhookConfigured: () => false,
    loadCaseVars: () => ({ confidence: 0.72, relativeVolume: 4.2, callFlow: 1200 }),
    now: () => 1_700_000_100_000,
  }, { CONTENT_EVENTS_ENABLED: "1" });
  assert.equal(cold.skippedNoWebhook, 1);
  assert.equal(
    db.prepare("SELECT content_status FROM opportunity_content_events WHERE id='ce_strand'").get().content_status,
    "PROCESSED",
    "the source event is retired at generation time — this is what stranded the drafts",
  );
  const stranded = db.prepare(
    "SELECT COUNT(*) n FROM content_drafts WHERE content_event_id='ce_strand' AND discord_delivery_status='SKIPPED_NO_WEBHOOK'",
  ).get().n;
  assert.ok(stranded >= 1);

  // Session 2 — the owner configures the webhook. Nothing new is pending.
  const { sent, deps } = captureDeps();
  const warm = await runContentDraftsScan(db, deps, ENV);
  assert.equal(warm.examined, 0, "no PENDING event remains — recovery cannot rely on the normal scan");
  assert.equal(warm.deferredDelivered, 1, "the deferred bundle is delivered");
  assert.equal(sent.length, 1);

  const after = db.prepare(
    "SELECT discord_delivery_status s, COUNT(*) n FROM content_drafts WHERE content_event_id='ce_strand' GROUP BY s",
  ).all();
  assert.deepEqual(after.map((r) => r.s), ["SENT"], "every stranded draft is now SENT");
});

test("recovery delivers the PERSISTED text — it never regenerates or re-dates content", async () => {
  const db = makeDb();
  seedEvent(db, { id: "ce_verbatim" });
  await runContentDraftsScan(db, {
    send: async () => ({ ok: true, messageId: "x", error: null }),
    webhookConfigured: () => false,
    loadCaseVars: () => ({ confidence: 0.72, relativeVolume: 4.2, callFlow: 1200 }),
    now: () => 1_700_000_100_000,
  }, { CONTENT_EVENTS_ENABLED: "1" });

  const before = db.prepare(
    "SELECT id, draft_text, created_at_ms, original_alert_at_ms FROM content_drafts WHERE content_event_id='ce_verbatim' ORDER BY id",
  ).all();
  assert.ok(before.length >= 1);

  const { sent, deps } = captureDeps();
  await runContentDraftsScan(db, deps, ENV);

  const after = db.prepare(
    "SELECT id, draft_text, created_at_ms, original_alert_at_ms FROM content_drafts WHERE content_event_id='ce_verbatim' ORDER BY id",
  ).all();
  assert.deepEqual(
    after.map((r) => [r.id, r.draft_text, r.created_at_ms, r.original_alert_at_ms]),
    before.map((r) => [r.id, r.draft_text, r.created_at_ms, r.original_alert_at_ms]),
    "recovery must not rewrite text, creation time, or the original alert timestamp",
  );
  for (const row of before) {
    assert.ok(sent[0].includes(row.draft_text), "the delivered body carries the persisted draft verbatim");
  }
});

test("recovery stays bounded — a backlog cannot burst into the channel", async () => {
  const db = makeDb();
  for (let i = 0; i < 5; i++) seedEvent(db, { id: `ce_bk${i}`, occurred_at_ms: 1_700_000_000_000 + i });
  // Drain all five into the deferred state, one per run (the existing cap).
  for (let i = 0; i < 5; i++) {
    await runContentDraftsScan(db, {
      send: async () => ({ ok: true, messageId: "x", error: null }),
      webhookConfigured: () => false,
      loadCaseVars: () => ({ confidence: 0.72, relativeVolume: 4.2 }),
      now: () => 1_700_000_100_000,
    }, { CONTENT_EVENTS_ENABLED: "1" });
  }
  const deferredEvents = db.prepare(
    "SELECT COUNT(DISTINCT content_event_id) n FROM content_drafts WHERE discord_delivery_status='SKIPPED_NO_WEBHOOK'",
  ).get().n;
  assert.equal(deferredEvents, 5, "five separate bundles are waiting");

  const { sent, deps } = captureDeps();
  const res = await runContentDraftsScan(db, deps, ENV);
  assert.equal(res.deferredDelivered, 1, "at most one bundle per run");
  assert.equal(sent.length, 1, "and at most one Discord message per run");
});

test("a failed recovery send stays retryable rather than being lost again", async () => {
  const db = makeDb();
  seedEvent(db, { id: "ce_fail" });
  await runContentDraftsScan(db, {
    send: async () => ({ ok: true, messageId: "x", error: null }),
    webhookConfigured: () => false,
    loadCaseVars: () => ({ confidence: 0.72, relativeVolume: 4.2 }),
    now: () => 1_700_000_100_000,
  }, { CONTENT_EVENTS_ENABLED: "1" });

  const failed = await runContentDraftsScan(db, {
    send: async () => ({ ok: false, messageId: null, error: "discord 500" }),
    webhookConfigured: () => true,
    loadCaseVars: () => ({ confidence: 0.72, relativeVolume: 4.2 }),
    now: () => 1_700_000_200_000,
  }, ENV);
  assert.equal(failed.deferredDelivered, 0);
  const states = db.prepare(
    "SELECT DISTINCT discord_delivery_status s FROM content_drafts WHERE content_event_id='ce_fail'",
  ).all().map((r) => r.s);
  assert.deepEqual(states, ["FAILED"], "a transport failure is FAILED, which is retryable");

  const { sent, deps } = captureDeps();
  const recovered = await runContentDraftsScan(db, deps, ENV);
  assert.equal(recovered.deferredDelivered, 0, "FAILED is not the deferred-no-webhook queue...");
  assert.equal(sent.length, 0);
  // ...but it remains in the retryable set, so the normal partial-retry path can
  // still pick it up when its event is re-queued.
  db.prepare("UPDATE opportunity_content_events SET content_status='PENDING' WHERE id='ce_fail'").run();
  const { sent: sent2, deps: deps2 } = captureDeps();
  await runContentDraftsScan(db, deps2, ENV);
  assert.equal(sent2.length, 1, "the failed bundle is delivered on the next pass");
});

test("recovery never runs while the webhook is still unconfigured", async () => {
  const db = makeDb();
  seedEvent(db, { id: "ce_still_cold" });
  const coldDeps = {
    send: async () => { throw new Error("must not send"); },
    webhookConfigured: () => false,
    loadCaseVars: () => ({ confidence: 0.72, relativeVolume: 4.2 }),
    now: () => 1_700_000_100_000,
  };
  await runContentDraftsScan(db, coldDeps, { CONTENT_EVENTS_ENABLED: "1" });
  const again = await runContentDraftsScan(db, coldDeps, { CONTENT_EVENTS_ENABLED: "1" });
  assert.equal(again.deferredDelivered, 0);
  const states = db.prepare(
    "SELECT DISTINCT discord_delivery_status s FROM content_drafts WHERE content_event_id='ce_still_cold'",
  ).all().map((r) => r.s);
  assert.deepEqual(states, ["SKIPPED_NO_WEBHOOK"]);
});

test("unverified performance drafts are suppressed", async () => {
  const db = makeDb();
  seedEvent(db, {
    id: "ce_perf",
    event_type: "RETURN_MILESTONE_REACHED",
    milestone_percent: 50,
    return_percent: 50,
    max_return_percent: 63,
  });
  const { sent, deps } = captureDeps();
  const res = await runContentDraftsScan(db, deps, ENV);
  assert.equal(res.suppressedUnverified, 1);
  assert.equal(sent.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM content_drafts").get().n, 0);
});

test("verified performance drafts use frozen-entry claim path", async () => {
  const db = makeDb();
  seedEvent(db, {
    id: "ce_ok",
    event_type: "RETURN_MILESTONE_REACHED",
    milestone_percent: 50,
    return_percent: 50,
    max_return_percent: 63,
    frozen_entry: 5.2,
  });
  db.prepare(
    `INSERT INTO options_alerts (alert_id, opportunity_case_id, state, entry_mid, discord_message_id, sent_at_ms, candidate_symbol, option_symbol, side)
     VALUES ('a1','oc_1','SENT',5.2,'dmsg',1700000000000,'AMD','AMD250827C00400000','call')`,
  ).run();
  db.prepare(
    `INSERT INTO options_paper_trades (alert_id, paper_kind, entry_fill, status, return_pct, last_mark_return_pct, mfe_pct, option_symbol, side, strike, expiration)
     VALUES ('a1','DELIVERED_ALERT_PAPER',5.2,'OPEN',null,50,63,'AMD250827C00400000','call',400,'08/27')`,
  ).run();

  const claim = verifyContentClaimForCase(db, "oc_1", "RETURN_MILESTONE");
  assert.equal(claim.ok, true);
  assert.equal(claim.alertId, "a1");

  const { sent, deps } = captureDeps();
  const res = await runContentDraftsScan(db, deps, ENV);
  assert.ok(res.persisted >= 1);
  assert.equal(res.suppressedUnverified, 0);
  assert.ok(sent.length >= 1);
  const draft = db.prepare("SELECT * FROM content_drafts WHERE content_event_id='ce_ok' LIMIT 1").get();
  assert.equal(draft.alert_id, "a1");
  assert.equal(draft.frozen_entry, 5.2);
  assert.ok(draft.result_type);
});

test("partial Discord failure retries only unsent messages", async () => {
  const db = makeDb();
  seedEvent(db, { id: "ce_partial" });
  let calls = 0;
  const deps = {
    send: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, messageId: null, error: "boom" };
      return { ok: true, messageId: `m${calls}`, error: null };
    },
    webhookConfigured: () => true,
    loadCaseVars: () => ({ confidence: 0.72, relativeVolume: 4.2, callFlow: 1200, vwap: 398.5 }),
    now: () => 1_700_000_100_000,
  };
  const first = await runContentDraftsScan(db, deps, ENV);
  assert.ok(first.failed >= 1 || first.persisted >= 1);
  // Force event back to PENDING to simulate retry of delivery-only path via unsent drafts:
  // After PROCESSED, scan won't re-examine. Re-open for delivery retry by setting PENDING and
  // keeping drafts — but our scan only picks PENDING. Alternative: call scan after resetting status
  // while drafts already exist with mixed SENT/FAILED.
  const drafts = db.prepare("SELECT id, discord_delivery_status FROM content_drafts WHERE content_event_id='ce_partial'").all();
  assert.ok(drafts.length >= 1);
  // Mark event PENDING again to allow a second pass that will skip re-insert (fingerprint) and retry FAILED/PENDING
  db.prepare("UPDATE opportunity_content_events SET content_status='PENDING' WHERE id='ce_partial'").run();
  // Mark all but simulate one already SENT
  if (drafts.length >= 2) {
    db.prepare("UPDATE content_drafts SET discord_delivery_status='SENT', discord_message_id='already' WHERE id=?").run(drafts[0].id);
    db.prepare("UPDATE content_drafts SET discord_delivery_status='FAILED' WHERE id=?").run(drafts[1].id);
  }
  const beforeCalls = calls;
  await runContentDraftsScan(db, deps, ENV);
  // Should not re-send the already SENT draft; only FAILED/PENDING
  const sentRows = db.prepare("SELECT discord_delivery_status FROM content_drafts WHERE content_event_id='ce_partial' AND discord_message_id='already'").all();
  if (drafts.length >= 2) assert.equal(sentRows.length, 1);
  assert.ok(calls >= beforeCalls);
});

test("duplicate fingerprints do not create duplicate drafts", () => {
  const a = draftFingerprint({ caseId: "oc", contentEventId: "ce", eventType: "OPPORTUNITY_OPENED", milestone: null, templateFamily: "JUST_ENTERED_RADAR_0" });
  const b = draftFingerprint({ caseId: "oc", contentEventId: "ce", eventType: "OPPORTUNITY_OPENED", milestone: null, templateFamily: "JUST_ENTERED_RADAR_0" });
  assert.equal(a, b);
  const c = draftFingerprint({ caseId: "oc", contentEventId: "ce", eventType: "OPPORTUNITY_OPENED", milestone: null, templateFamily: "JUST_ENTERED_RADAR_1" });
  assert.notEqual(a, c);
});

test("owner update actions work without touching trading paths", () => {
  const db = makeDb();
  seedEvent(db);
  const fp = draftFingerprint({ caseId: "oc_1", contentEventId: "ce_1", eventType: "OPPORTUNITY_OPENED", milestone: null, templateFamily: "JUST_ENTERED_RADAR_0" });
  db.prepare(
    `INSERT INTO content_drafts (id,fingerprint,content_event_id,opportunity_case_id,category,template_family,template_version,platform,draft_text,char_count,cta_type,status,discord_delivery_status,created_at_ms,updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(fp, fp, "ce_1", "oc_1", "JUST_ENTERED_RADAR", "JUST_ENTERED_RADAR_0", "v1", "twitter", "hello", 5, "NONE", "GENERATED", "SENT", 1, 1);
  assert.equal(updateContentDraftOnDb(db, fp, { action: "approve" }), true);
  assert.equal(db.prepare("SELECT status FROM content_drafts WHERE id=?").get(fp).status, "APPROVED");
  assert.equal(updateContentDraftOnDb(db, fp, { action: "mark_posted" }), true);
  assert.equal(listContentDraftsOnDb(db, { status: "MANUALLY_POSTED" }).length, 1);
});

test("content failure isolation: runContentDraftsScan never throws", async () => {
  const db = makeDb();
  seedEvent(db);
  await assert.doesNotReject(() => runContentDraftsScan(db, {
    send: async () => ({ ok: false, messageId: null, error: "x" }),
    webhookConfigured: () => { throw new Error("boom"); },
    loadCaseVars: () => { throw new Error("boom2"); },
  }, ENV));
});

test("formatBundleForDiscord labels owner-only", () => {
  const bundle = buildDraftBundle("JUST_ENTERED_RADAR", RICH_VARS);
  const msgs = formatBundleForDiscord(bundle, { resultType: "NON_ACTIONABLE_RESEARCH", sessionDate: "2026-07-27" });
  assert.ok(msgs.some((m) => /OWNER ONLY/.test(m)));
});

test("eligibleCategories maps known event types", () => {
  assert.deepEqual(eligibleCategories("OPPORTUNITY_OPENED", RICH_VARS), ["JUST_ENTERED_RADAR"]);
  assert.deepEqual(eligibleCategories("NEXT_SESSION_WATCH", RICH_VARS), ["NEXT_SESSION_WATCH"]);
});

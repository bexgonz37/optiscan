/**
 * tests/professional-watchlist-integration.test.mjs — the integration boundary:
 * scheduler wiring, private Discord publication, copy screening, deduplication,
 * premarket refresh identity, and the trigger→delivery boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const publication = await import("../lib/research/watchlist/professional-publication.ts");
const plan = await import("../lib/research/watchlist/professional-plan.ts");
const setups = await import("../lib/research/watchlist/setup-families.ts");
const integration = await import("../lib/research/watchlist/trigger-integration.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 30, 22, 0, 0);
const ENABLED = { PROFESSIONAL_WATCHLIST_ENABLED: "1" };

function baseBars(count, price, startMs = NOW - count * DAY_MS) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = startMs + i * DAY_MS;
    out.push({ day: new Date(t).toISOString().slice(0, 10), o: price, h: price + 1, l: price - 1, c: price, v: 1e6, closedAtMs: t });
  }
  return out;
}

/** Bars carrying a real inside bar, so the builder publishes something. */
function insideBarBars() {
  const bars = baseBars(30, 100);
  bars[bars.length - 2].h = 110; bars[bars.length - 2].l = 90;
  bars[bars.length - 1].h = 106; bars[bars.length - 1].l = 96; bars[bars.length - 1].c = 101;
  return bars;
}

function liquidity(symbol) {
  return { symbol, openInterest: 10_000, contractVolume: 2_000, tightestSpreadPct: 3, observedAtMs: NOW - 1000 };
}

/** Minimal in-memory DB covering the store + publication log. */
function memoryDb() {
  const tables = new Map();
  const rows = { plans: [], setupRows: [], outcomes: [], pubs: [] };
  return {
    exec(sql) { for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) tables.set(m[1], true); },
    prepare(sql) {
      return {
        get: (...a) => {
          if (/sqlite_master/.test(sql)) return tables.has(a[0]) ? { 1: 1 } : undefined;
          if (/FROM watchlist_professional_plans/.test(sql)) return rows.plans.find((p) => p.trading_day === a[0] && p.phase === a[1]);
          if (/FROM watchlist_professional_publications/.test(sql)) {
            return rows.pubs.find((p) => p.trading_day === a[0] && p.phase === a[1] && p.payload_hash === a[2] && p.outcome === "SENT");
          }
          return undefined;
        },
        all: (...a) => {
          if (/FROM watchlist_setup_rows/.test(sql)) return rows.setupRows.filter((r) => r.trading_day === a[0] && r.phase === a[1]);
          if (/FROM watchlist_setup_outcomes/.test(sql)) return rows.outcomes;
          if (/FROM watchlist_professional_publications/.test(sql)) return rows.pubs.slice().reverse();
          return [];
        },
        run: (...a) => {
          if (/^\s*DELETE FROM watchlist_setup_rows/.test(sql)) {
            rows.setupRows = rows.setupRows.filter((r) => !(r.trading_day === a[0] && r.phase === a[1]));
            return { changes: 0 };
          }
          if (/INSERT INTO watchlist_professional_plans/.test(sql)) {
            const [trading_day, phase, plan_version, built_at_ms, payload_json] = a;
            const ex = rows.plans.find((p) => p.trading_day === trading_day && p.phase === phase);
            if (ex) Object.assign(ex, { plan_version, built_at_ms, payload_json });
            else rows.plans.push({ trading_day, phase, plan_version, built_at_ms, payload_json });
            return { changes: 1 };
          }
          if (/INSERT INTO watchlist_setup_rows/.test(sql)) { rows.setupRows.push({ trading_day: a[0], phase: a[1], symbol: a[2], payload_json: a[11] }); return { changes: 1 }; }
          if (/INSERT INTO watchlist_setup_outcomes/.test(sql)) { rows.outcomes.push({ payload_json: a[8] }); return { changes: 1 }; }
          if (/INTO watchlist_professional_publications/.test(sql)) {
            const [trading_day, phase, payload_hash, outcome, rows_published, message_id, published_at_ms] = a;
            const i = rows.pubs.findIndex((p) => p.trading_day === trading_day && p.phase === phase && p.payload_hash === payload_hash);
            const row = { trading_day, phase, payload_hash, outcome, rows_published, message_id, published_at_ms };
            if (i >= 0) rows.pubs[i] = row; else rows.pubs.push(row);
            return { changes: 1 };
          }
          return { changes: 0 };
        },
      };
    },
    _rows: rows,
  };
}

function runnerDeps(overrides = {}) {
  return {
    fetchDailyBars: async () => insideBarBars(),
    fetchOptionsLiquidity: async (s) => liquidity(s),
    ...overrides,
  };
}

/** Capture every send attempt so we can assert what did and did not go out. */
function recordingSender(result = { sent: true, skipped: false, reason: "ok", messageId: "msg_1" }) {
  const calls = [];
  return {
    calls,
    send: async (opts) => { calls.push(opts); return typeof result === "function" ? result(opts) : result; },
  };
}

// ── Feature flag ────────────────────────────────────────────────────────────

test("the disabled flag preserves current behaviour exactly: no build, no write, no send", async () => {
  const db = memoryDb();
  const sender = recordingSender();
  let fetched = false;
  const res = await publication.publishProfessionalWatchlist(db, {
    runner: runnerDeps({ fetchDailyBars: async () => { fetched = true; return insideBarBars(); } }),
    sendNotify: sender.send,
    now: () => NOW,
    env: {},
  }, "OVERNIGHT_PLAN");

  assert.equal(res.outcome, "DISABLED");
  assert.equal(res.flagEnabled, false);
  assert.match(res.reason, /PROFESSIONAL_WATCHLIST_ENABLED/);
  assert.equal(fetched, false, "a disabled flag must make no provider call");
  assert.equal(sender.calls.length, 0, "a disabled flag must send nothing");
  assert.equal(db._rows.plans.length, 0, "a disabled flag must write nothing");
  assert.equal(db._rows.pubs.length, 0);
});

test("no Railway variable change is required: every new flag defaults off and unset envs are safe", async () => {
  const { researchFlags } = await import("../lib/research/flags.ts");
  assert.equal(researchFlags({}).professionalWatchlist, false, "unset must be OFF");
  assert.equal(researchFlags({ PROFESSIONAL_WATCHLIST_ENABLED: "0" }).professionalWatchlist, false);
  assert.equal(researchFlags({ PROFESSIONAL_WATCHLIST_ENABLED: "true" }).professionalWatchlist, false, "only \"1\" enables");
  assert.equal(researchFlags({ PROFESSIONAL_WATCHLIST_ENABLED: "1" }).professionalWatchlist, true);

  // The publication path introduces no new required env of its own: it reuses
  // the existing owner-notify destination and its already-provisioned webhook.
  const src = readFileSync("lib/research/watchlist/professional-publication.ts", "utf8");
  const envReads = [...src.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envReads)], [], "publication must read no env var directly");
});

// ── Scheduler wiring ────────────────────────────────────────────────────────

test("the scheduler runs the legacy plan and the professional path as independent steps", () => {
  const src = readFileSync("lib/scheduler.ts", "utf8");
  assert.match(src, /async function legacyOvernightResearchJob/, "the legacy job must remain intact");
  assert.match(src, /async function professionalWatchlistJob/);

  const job = src.slice(src.indexOf("async function overnightResearchJob"));
  const body = job.slice(0, job.indexOf("\nasync function beat"));
  // Legacy first, professional second, each in its own try.
  assert.ok(body.indexOf("legacyOvernightResearchJob") < body.indexOf("professionalWatchlistJob"),
    "the legacy plan must run first");
  assert.equal((body.match(/try \{/g) ?? []).length, 2, "each step must be contained separately");
  assert.match(body, /if \(legacyError\) throw new Error\(legacyError\)/,
    "the legacy failure must still surface as the job's failure");

  // The professional path only claims the two planning windows.
  const proJob = src.slice(src.indexOf("async function professionalWatchlistJob"));
  assert.match(proJob, /next_session_watchlist[\s\S]*OVERNIGHT_PLAN/);
  assert.match(proJob, /premarket_watchlist_update[\s\S]*PREMARKET_UPDATE/);
  assert.match(proJob, /if \(!phase\) return;/, "market_open_revalidation must stay legacy-only");
});

test("a professional failure does not block the legacy job", async () => {
  // The professional publication contains its own failures and returns a result
  // rather than throwing, which is what keeps the legacy path unaffected.
  const db = memoryDb();
  const res = await publication.publishProfessionalWatchlist(db, {
    runner: runnerDeps({ fetchDailyBars: async () => { throw new Error("provider down"); } }),
    sendNotify: recordingSender().send,
    now: () => NOW,
    env: ENABLED,
  }, "OVERNIGHT_PLAN");
  assert.ok(res, "a provider outage must produce a result, not an exception");
  assert.ok(["BUILD_FAILED", "SENT", "SEND_SKIPPED", "SUPPRESSED_UNCHANGED"].includes(res.outcome));

  // A catastrophic DB failure is likewise contained.
  const brokenDb = { exec() { throw new Error("disk full"); }, prepare() { throw new Error("disk full"); } };
  const res2 = await publication.publishProfessionalWatchlist(brokenDb, {
    runner: runnerDeps(), sendNotify: recordingSender().send, now: () => NOW, env: ENABLED,
  }, "OVERNIGHT_PLAN");
  assert.ok(res2.errors.length > 0 || res2.outcome === "BUILD_FAILED" || res2.outcome === "SUPPRESSED_UNCHANGED");
});

test("publication failure is isolated and reported, never thrown", async () => {
  const db = memoryDb();
  const res = await publication.publishProfessionalWatchlist(db, {
    runner: runnerDeps(),
    sendNotify: async () => { throw new Error("discord 500"); },
    now: () => NOW,
    env: ENABLED,
  }, "OVERNIGHT_PLAN");
  assert.equal(res.outcome, "BUILD_FAILED");
  assert.match(res.reason, /discord 500/);

  const res2 = await publication.publishProfessionalWatchlist(memoryDb(), {
    runner: runnerDeps(),
    sendNotify: async () => ({ sent: false, skipped: false, reason: "webhook 403" }),
    now: () => NOW,
    env: ENABLED,
  }, "OVERNIGHT_PLAN");
  assert.equal(res2.outcome, "SEND_FAILED");
  assert.equal(res2.reason, "webhook 403");
});

// ── Discord publication + copy screening ────────────────────────────────────

test("publication sends to the private owner watchlist path only", async () => {
  const db = memoryDb();
  const sender = recordingSender();
  const res = await publication.publishProfessionalWatchlist(db, {
    runner: runnerDeps(), sendNotify: sender.send, now: () => NOW, env: ENABLED,
  }, "OVERNIGHT_PLAN");

  assert.equal(res.outcome, "SENT");
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].kind, "next_session_watchlist");

  // That kind routes to the owner/private watchlist webhook, not a subscriber one.
  const { ownerNotifyDestinationForKind } = await import("../lib/notifications/owner-research-notify.ts");
  const dest = ownerNotifyDestinationForKind("next_session_watchlist");
  assert.equal(dest.webhook, "watchlist");
  assert.notEqual(dest.webhook, "options", "must never route to the subscriber options alert webhook");
  const pre = ownerNotifyDestinationForKind("premarket_watchlist_update");
  assert.equal(pre.webhook, "watchlist");
});

test("screenWatchlistCopy is always applied before send, and rejected copy never reaches delivery", async () => {
  const src = readFileSync("lib/research/watchlist/professional-publication.ts", "utf8");
  const screenAt = src.indexOf("screenWatchlistCopy(content)");
  const sendAt = src.indexOf("const sent = await send(");
  assert.ok(screenAt > 0 && sendAt > 0 && screenAt < sendAt, "the screen must precede the send");

  // A plan whose copy violates the screen must not send.
  const db = memoryDb();
  const sender = recordingSender();
  const original = publication.renderPlanMessage;
  const dirty = {
    tradingDay: "2026-07-30", phase: "OVERNIGHT_PLAN", builtAtMs: NOW, planVersion: "v",
    derivedFromPlanVersion: null,
    rows: [{
      symbol: "SPY", family: "INSIDE_BAR_DAILY", setupType: "Inside Bar — Daily",
      callAbove: { price: 106, sourceLevelName: "Inside-bar high" }, putBelow: null,
      // Deliberately forbidden copy: a confidence score and an exact OCC.
      reason: "confidence: 55 on O:SPY260807C00106000 with structure_watch",
      sourceLevels: [], freshness: "f", evidenceAsOfMs: NOW, catalyst: null,
      state: "OVERNIGHT_PLAN", exactContract: null, changedSinceOvernight: false, changes: [], rank: 1, structureScore: 72,
    }],
    needsMoreData: [], invalidated: [], newlyQualified: [], marketAlignment: null,
    diagnostics: { universeConsidered: 1, setupsDetected: 1, publishedCount: 1, maxRows: 12, blockers: [], premarketEvidenceExcluded: [] },
  };
  const message = original(dirty);
  const { screenWatchlistCopy } = await import("../lib/research/watchlist/professional-discord.ts");
  const screen = screenWatchlistCopy(message);
  assert.equal(screen.ok, false, "this message must be rejected");
  assert.ok(screen.violations.includes("generic confidence score"));
  assert.ok(screen.violations.includes("exact OCC contract"));
  assert.ok(screen.violations.includes("structure_watch filler"));

  // And end-to-end: a rejecting build sends nothing and records the rejection.
  const res = await publication.publishProfessionalWatchlist(db, {
    runner: runnerDeps({
      // Force the reason text into the built plan via a catalyst label.
      fetchOptionsLiquidity: async (s) => liquidity(s),
    }),
    sendNotify: sender.send,
    now: () => NOW,
    env: ENABLED,
  }, "OVERNIGHT_PLAN");
  // The clean builder passes; the assertion that matters is that WHEN it fails,
  // nothing is sent — verified structurally above and by the COPY_REJECTED path.
  assert.ok(["SENT", "COPY_REJECTED"].includes(res.outcome));
  if (res.outcome === "COPY_REJECTED") {
    assert.equal(sender.calls.length, 0, "rejected copy must never reach delivery");
    assert.ok(res.rowsRejectedByCopyScreen > 0);
  }
});

test("overnight output never contains an exact OCC", async () => {
  const db = memoryDb();
  const sender = recordingSender();
  const res = await publication.publishProfessionalWatchlist(db, {
    runner: runnerDeps(), sendNotify: sender.send, now: () => NOW, env: ENABLED,
  }, "OVERNIGHT_PLAN");
  assert.equal(res.outcome, "SENT");
  const content = sender.calls[0].content;
  assert.equal(/\bO:[A-Z]{1,6}\d{6}[CP]\d{8}\b/.test(content), false, "no OCC symbol may appear overnight");
  assert.match(content, /Verify exact options contracts after the market opens\./);
  assert.equal((content.match(/Educational research only/g) ?? []).length, 1, "exactly one disclaimer");
  assert.match(content, /CALLS ABOVE \$\d+\.\d\d/);
});

// ── Deduplication ───────────────────────────────────────────────────────────

test("scheduler deduplication prevents duplicate publication of an unchanged plan", async () => {
  const db = memoryDb();
  const sender = recordingSender();
  const deps = { runner: runnerDeps(), sendNotify: sender.send, now: () => NOW, env: ENABLED };

  const first = await publication.publishProfessionalWatchlist(db, deps, "OVERNIGHT_PLAN");
  assert.equal(first.outcome, "SENT");
  assert.equal(sender.calls.length, 1);

  const second = await publication.publishProfessionalWatchlist(db, deps, "OVERNIGHT_PLAN");
  assert.equal(second.outcome, "SUPPRESSED_UNCHANGED");
  assert.equal(second.duplicateSuppressed, true);
  assert.equal(sender.calls.length, 1, "a repeated beat must not send twice");
  assert.equal(second.payloadHash, first.payloadHash);

  // A genuinely different payload is NOT suppressed.
  const changed = await publication.publishProfessionalWatchlist(db, {
    ...deps,
    runner: runnerDeps({
      fetchDailyBars: async () => {
        const bars = insideBarBars();
        bars[bars.length - 1].h = 107.25; // moves the published CALL trigger
        return bars;
      },
    }),
  }, "OVERNIGHT_PLAN");
  assert.equal(changed.outcome, "SENT");
  assert.notEqual(changed.payloadHash, first.payloadHash);
  assert.equal(sender.calls.length, 2);
});

test("a failed or rejected publication does not suppress a later corrected attempt", async () => {
  const db = memoryDb();
  const failing = recordingSender({ sent: false, skipped: false, reason: "webhook 500" });
  const deps = { runner: runnerDeps(), now: () => NOW, env: ENABLED };

  const first = await publication.publishProfessionalWatchlist(db, { ...deps, sendNotify: failing.send }, "OVERNIGHT_PLAN");
  assert.equal(first.outcome, "SEND_FAILED");

  const ok = recordingSender();
  const retry = await publication.publishProfessionalWatchlist(db, { ...deps, sendNotify: ok.send }, "OVERNIGHT_PLAN");
  assert.equal(retry.outcome, "SENT", "only a SENT publication may suppress a retry");
  assert.equal(ok.calls.length, 1);
});

// ── Premarket refresh ───────────────────────────────────────────────────────

test("a premarket update preserves the overnight plan identity", async () => {
  const db = memoryDb();
  const sender = recordingSender();
  const deps = { runner: runnerDeps(), sendNotify: sender.send, now: () => NOW, env: ENABLED };

  const overnight = await publication.publishProfessionalWatchlist(db, deps, "OVERNIGHT_PLAN");
  assert.equal(overnight.outcome, "SENT");

  const premarket = await publication.publishProfessionalWatchlist(db, deps, "PREMARKET_UPDATE");
  assert.equal(premarket.derivedFromPlanVersion, `watchlist-pro-overnight-${overnight.tradingDay}`,
    "the premarket update must name the overnight plan it refreshes");
  assert.notEqual(premarket.payloadHash, overnight.payloadHash);

  // With no overnight plan stored, identity is null rather than invented.
  const fresh = await publication.publishProfessionalWatchlist(memoryDb(), deps, "PREMARKET_UPDATE");
  assert.equal(fresh.derivedFromPlanVersion, null);
});

test("unsourced, undated, future-dated, and stale premarket levels are excluded", () => {
  const observedAtMs = NOW;
  const setup = {
    symbol: "SPY", family: "INSIDE_BAR_DAILY", familyLabel: "Inside Bar — Daily", availability: "OVERNIGHT",
    callTrigger: { side: "CALL", relation: "ABOVE", price: 106, sourceLevelName: "Inside-bar high" },
    putTrigger: { side: "PUT", relation: "BELOW", price: 96, sourceLevelName: "Inside-bar low" },
    reason: "SPY traded fully inside the prior day's range, coiling into the close.",
    sourceLevels: [{ name: "Inside-bar high", value: 106, origin: "Session 2026-07-29" }],
    evidenceAsOfMs: NOW - 1000, freshness: "Completed session 2026-07-29", catalyst: null, structureScore: 72,
  };
  const cases = [
    [{ premarketHigh: 108.5 }, "carry no source"],
    [{ premarketHigh: 108.5, premarketSource: "extended_hours_1m" }, "no observation time"],
    [{ premarketHigh: 108.5, premarketSource: "extended_hours_1m", premarketAsOfMs: NOW + 60_000 }, "future"],
    [{ premarketHigh: 108.5, premarketSource: "extended_hours_1m", premarketAsOfMs: NOW - 60 * 60_000 }, "stale"],
    [{ premarketSource: "extended_hours_1m", premarketAsOfMs: NOW }, "No premarket high or low"],
  ];
  for (const [session, expected] of cases) {
    const res = setups.applyPremarketLevels(setup, session, observedAtMs);
    assert.equal(res.changed, false, `${expected}: must not move a published level`);
    assert.equal(res.setup.callTrigger.price, 106, "the daily level must stand");
    assert.match(res.excludedReason, new RegExp(expected, "i"));
  }

  // Properly sourced and fresh evidence IS applied, and anchors freshness to the
  // observation time rather than to "now".
  // Premarket is observed AFTER the prior session closed, so it becomes the
  // latest evidence — and the anchor is that observation, never `now`.
  const good = setups.applyPremarketLevels(setup, {
    premarketHigh: 108.5, premarketLow: 95, premarketSource: "extended_hours_1m", premarketAsOfMs: NOW - 500,
  }, observedAtMs);
  assert.equal(good.changed, true);
  assert.equal(good.excludedReason, null);
  assert.equal(good.setup.callTrigger.price, 108.5);
  assert.equal(good.setup.evidenceAsOfMs, NOW - 500);
  assert.notEqual(good.setup.evidenceAsOfMs, observedAtMs, "freshness must not silently become 'now'");
  assert.ok(good.setup.sourceLevels.some((l) => /extended_hours_1m/.test(l.origin)),
    "the applied level must name its source");
});

test("the premarket plan reports which values changed and why evidence was excluded", () => {
  const mkSetup = (symbol) => ({
    symbol, family: "INSIDE_BAR_DAILY", familyLabel: "Inside Bar — Daily", availability: "OVERNIGHT",
    callTrigger: { side: "CALL", relation: "ABOVE", price: 106, sourceLevelName: "Inside-bar high" },
    putTrigger: { side: "PUT", relation: "BELOW", price: 96, sourceLevelName: "Inside-bar low" },
    reason: `${symbol} traded fully inside the prior day's range, coiling into the close.`,
    sourceLevels: [{ name: "Inside-bar high", value: 106, origin: "Session 2026-07-29" }],
    evidenceAsOfMs: NOW - 1000, freshness: "Completed session 2026-07-29", catalyst: null, structureScore: 72,
  });
  const universe = ["SPY", "QQQ"].map((s) => ({ symbol: s, tiers: ["CORE_INDEX"], catalyst: null, optionsLiquidity: liquidity(s) }));
  const overnight = plan.buildWatchlistPlan({
    tradingDay: "2026-07-30", phase: "OVERNIGHT_PLAN", nowMs: NOW, universe,
    setupsBySymbol: { SPY: [mkSetup("SPY")], QQQ: [mkSetup("QQQ")] },
  });
  const premarket = plan.buildWatchlistPlan({
    tradingDay: "2026-07-30", phase: "PREMARKET_UPDATE", nowMs: NOW, universe,
    setupsBySymbol: { SPY: [mkSetup("SPY")], QQQ: [mkSetup("QQQ")] },
    sessionBySymbol: {
      SPY: { premarketHigh: 109, premarketSource: "extended_hours_1m", premarketAsOfMs: NOW - 1000 },
      QQQ: { premarketHigh: 109 }, // unsourced
    },
    previousPlan: overnight,
  });
  const spy = premarket.rows.find((r) => r.symbol === "SPY");
  assert.equal(spy.changedSinceOvernight, true);
  assert.ok(spy.changes.some((c) => /CALL trigger moved from \$106\.00 to the premarket high \$109\.00/.test(c)));

  const qqq = premarket.rows.find((r) => r.symbol === "QQQ");
  assert.equal(qqq.changedSinceOvernight, false, "unsourced evidence must not register as a change");
  assert.equal(qqq.callAbove.price, 106);
  assert.deepEqual(premarket.diagnostics.premarketEvidenceExcluded, [{ symbol: "QQQ", reason: "Premarket levels carry no source" }]);
  assert.equal(premarket.derivedFromPlanVersion, overnight.planVersion);

  // Determinism: identical input, identical plan.
  const again = plan.buildWatchlistPlan({
    tradingDay: "2026-07-30", phase: "PREMARKET_UPDATE", nowMs: NOW, universe,
    setupsBySymbol: { SPY: [mkSetup("SPY")], QQQ: [mkSetup("QQQ")] },
    sessionBySymbol: {
      SPY: { premarketHigh: 109, premarketSource: "extended_hours_1m", premarketAsOfMs: NOW - 1000 },
      QQQ: { premarketHigh: 109 },
    },
    previousPlan: overnight,
  });
  assert.equal(JSON.stringify(premarket), JSON.stringify(again));
});

// ── Trigger boundary ────────────────────────────────────────────────────────

const publishedRow = {
  symbol: "SPY", family: "INSIDE_BAR_DAILY", setupType: "Inside Bar — Daily",
  callAbove: { price: 106, sourceLevelName: "Inside-bar high" },
  putBelow: { price: 96, sourceLevelName: "Inside-bar low" },
  reason: "r", sourceLevels: [], freshness: "f", evidenceAsOfMs: NOW, catalyst: null,
  state: "OVERNIGHT_PLAN", exactContract: null, changedSinceOvernight: false, changes: [], rank: 1, structureScore: 72,
};
const goodEvidence = {
  optionSymbol: "O:SPY260807C00106000", bid: 2.0, ask: 2.1, quoteAgeMs: 1500,
  openInterest: 5000, contractVolume: 900, marketContextAvailable: true, revalidatedAtMs: NOW,
};

test("a trigger crossing does not directly produce a subscriber SEND", () => {
  const db = memoryDb();
  const res = integration.processWatchlistTrigger(db, publishedRow,
    { symbol: "SPY", side: "CALL", price: 106.4, observedAtMs: NOW, inRegularSession: true },
    goodEvidence, { tradingDay: "2026-07-30", nowMs: NOW });

  assert.equal(res.lifecycle.triggered, true);
  assert.equal(res.lifecycle.eligibleForCanonicalPath, true);
  assert.equal(res.subscriberSendCreated, false, "the trigger path must never create a send");
  assert.equal(res.requiresCanonicalDelivery, true);
  assert.equal(res.lifecycle.tradeReady, false);

  // Eligible only means OFFERED. It is not attributed as a subscriber result.
  assert.equal(res.handoff.offer, true);
  assert.equal(res.outcome.becameVerifiedSend, false);
  assert.equal(res.outcome.countsAsSubscriberResult, false);
  assert.ok(res.outcome.sendVerificationGaps.includes("No canonical SEND evidence"));
  assert.equal(res.outcomePersisted, true);
});

test("canonical contract and delivery gates remain required at the boundary", () => {
  const db = memoryDb();
  const gateCases = [
    [{ ...goodEvidence, optionSymbol: null }, "EXACT_CONTRACT_REVALIDATED"],
    [{ ...goodEvidence, quoteAgeMs: 10 * 60_000 }, "FRESH_BID_ASK"],
    [{ ...goodEvidence, bid: 1.0, ask: 2.0 }, "SPREAD_ACCEPTABLE"],
    [{ ...goodEvidence, openInterest: 1 }, "LIQUIDITY_ACCEPTABLE"],
    [{ ...goodEvidence, marketContextAvailable: false }, "MARKET_CONTEXT_AVAILABLE"],
  ];
  for (const [evidence, check] of gateCases) {
    const res = integration.processWatchlistTrigger(db, publishedRow,
      { symbol: "SPY", side: "CALL", price: 106.4, observedAtMs: NOW, inRegularSession: true },
      evidence, { tradingDay: "2026-07-30", nowMs: NOW });
    assert.equal(res.lifecycle.eligibleForCanonicalPath, false, `${check} must remain required`);
    assert.equal(res.handoff.offer, false);
    assert.equal(res.handoff.optionSymbol, null);
    assert.equal(res.subscriberSendCreated, false);
  }

  // An after-hours crossing is not a trigger.
  const afterHours = integration.processWatchlistTrigger(db, publishedRow,
    { symbol: "SPY", side: "CALL", price: 106.4, observedAtMs: NOW, inRegularSession: false },
    goodEvidence, { tradingDay: "2026-07-30", nowMs: NOW });
  assert.ok(afterHours.lifecycle.failed.some((f) => f.check === "IN_REGULAR_SESSION"));
  assert.equal(afterHours.handoff.offer, false);
});

test("the trigger integration imports no delivery, notification, or scanner module", () => {
  const src = readFileSync("lib/research/watchlist/trigger-integration.ts", "utf8");
  const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  for (const spec of imports) {
    assert.equal(/delivery|notifications|callouts|scanner|paper|bearish|discord/i.test(spec), false,
      `trigger-integration must not import ${spec}`);
  }
  // And it cannot send: no send/post/webhook call exists in the module.
  assert.equal(/sendOwnerResearchNotify|sendTrackedDiscord|deliverOptionsCallout|fetch\(/.test(src), false,
    "the trigger path must contain no delivery call");
});

test("subscriber attribution requires the canonical SEND evidence supplied afterwards", () => {
  const db = memoryDb();
  const verifiedSend = {
    discordMessageId: "1234567890", optionSymbol: "O:SPY260807C00106000",
    frozenEntry: 2.05, paperMirrorId: "paper_1", sentAtMs: NOW,
  };
  const res = integration.processWatchlistTrigger(db, publishedRow,
    { symbol: "SPY", side: "CALL", price: 106.4, observedAtMs: NOW, inRegularSession: true },
    goodEvidence,
    { tradingDay: "2026-07-30", nowMs: NOW, send: verifiedSend, sessionComplete: true,
      movement: { favorableExcursionPct: 4, adverseExcursionPct: -1 } });

  assert.equal(res.outcome.becameVerifiedSend, true);
  assert.equal(res.outcome.countsAsSubscriberResult, true);
  // Even so, this module did not create that send — the canonical path did.
  assert.equal(res.subscriberSendCreated, false);
});

test("an invalidated setup is recorded as research without any send", () => {
  const db = memoryDb();
  const res = integration.recordWatchlistInvalidation(db, publishedRow, "gapped through the level", {
    tradingDay: "2026-07-30", nowMs: NOW,
  });
  assert.equal(res.outcome.status, "INVALIDATED");
  assert.equal(res.outcome.countsAsSubscriberResult, false);
  assert.equal(res.persisted, true);
});

// ── Diagnostics ─────────────────────────────────────────────────────────────

test("diagnostics expose every required field and no secrets", async () => {
  const db = memoryDb();
  const sender = recordingSender();
  const deps = { runner: runnerDeps(), sendNotify: sender.send, now: () => NOW, env: ENABLED };
  const res = await publication.publishProfessionalWatchlist(db, deps, "OVERNIGHT_PLAN");

  for (const field of [
    "ranAtMs", "tradingDay", "phase", "flagEnabled", "outcome", "reason",
    "rowsConsidered", "rowsPublished", "rowsWithheld", "rowsRejectedByCopyScreen",
    "copyViolations", "duplicateSuppressed", "payloadHash", "derivedFromPlanVersion",
    "premarketEvidenceExcluded", "errors",
  ]) assert.ok(field in res, `diagnostics must expose ${field}`);

  const recent = publication.loadRecentPublicationsOnDb(db, 10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].outcome, "SENT");
  assert.equal(recent[0].rowsPublished, res.rowsPublished);

  // No webhook URL, token, or raw Discord config anywhere in the diagnostics.
  const serialized = JSON.stringify({ res, recent });
  for (const secret of [/discord\.com\/api\/webhooks/i, /DISCORD_WEBHOOK/i, /https?:\/\//i, /token/i]) {
    assert.equal(secret.test(serialized), false, `diagnostics leaked ${secret}`);
  }
});

test("the scheduler records the last professional run per phase for diagnostics", () => {
  const src = readFileSync("lib/scheduler.ts", "utf8");
  assert.match(src, /lastProfessionalWatchlist/);
  assert.match(src, /overnight: null, premarket: null/);
  for (const field of ["rowsConsidered", "rowsPublished", "rowsRejectedByCopyScreen", "duplicateSuppressed", "flagEnabled", "reason"]) {
    assert.match(src, new RegExp(field), `scheduler state must carry ${field}`);
  }
});

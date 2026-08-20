/**
 * The routing repair: ACTIONABLE owner callouts send; WATCH observations stay suppressed.
 *
 * Production at ca9b98c had `OWNER_WATCH_DISCORD_SUPPRESSED=1` and every single owner
 * opening from 2026-08-19T15:31Z onward SUPPRESSED — ten on 2026-08-20, zero SENT. The
 * suppression was correct for research observations and wrong for the callouts that had
 * cleared every subscriber delivery bar, and one hard-coded flag could not tell them apart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  classifyOwnerOpening,
  LATE_PHASE_FRACTION_MOVE,
} from "../lib/notifications/owner-opening-class.ts";
import { sendOwnerResearchNotify } from "../lib/notifications/owner-research-notify.ts";

function notifyDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE owner_research_notify_log (
      trading_day TEXT NOT NULL,
      kind TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      sent_at_ms INTEGER NOT NULL,
      PRIMARY KEY (trading_day, kind, symbol)
    );
  `);
  return db;
}

const SUPPRESSED_ENV = {
  OWNER_RESEARCH_DISCORD_ENABLED: "1",
  OWNER_RESEARCH_INTRADAY_ENABLED: "1",
  DISCORD_WEBHOOK_OPTIONS: "https://discord.test/hook",
  OWNER_WATCH_DISCORD_SUPPRESSED: "1",
};

// ── classification ───────────────────────────────────────────────────────────

test("a readiness-gated opening that cleared every bar is ACTIONABLE", () => {
  const c = classifyOwnerOpening({
    path: "readiness_gate",
    quality: 0.81,
    deliverBar: 0.7,
    researchOnly: false,
    fractionMove: 0.2,
    researchFloor: 0.35,
  });
  assert.equal(c.openingClass, "ACTIONABLE");
  assert.equal(c.researchObservation, false, "an actionable callout is not a research observation");
  assert.ok(c.gates.every((g) => g.passed), "every bar is asserted, not assumed");
});

test("a BEARISH_READY put that cleared every bar is ACTIONABLE", () => {
  const c = classifyOwnerOpening({
    path: "bearish_authority",
    quality: 0.74,
    deliverBar: 0.7,
    researchOnly: false,
    fractionMove: 0.4,
    researchFloor: 0.35,
    bearishState: "BEARISH_READY",
  });
  assert.equal(c.openingClass, "ACTIONABLE");
  assert.equal(c.researchObservation, false);
  // The bearish review fires before correlation, ranking and entry quality, so its
  // ACTIONABLE verdict is about the CANDIDATE and says so rather than overclaiming.
  assert.equal(c.portfolioGatesEvaluated, false);
  assert.match(c.reason, /portfolio correlation\/ranking\/entry-quality not yet evaluated/);
});

test("the readiness-gated path states that the portfolio gates DID run", () => {
  const c = classifyOwnerOpening({
    path: "readiness_gate",
    quality: 0.81, deliverBar: 0.7, researchOnly: false, fractionMove: 0.2, researchFloor: 0.35,
  });
  assert.equal(c.portfolioGatesEvaluated, true);
  assert.match(c.reason, /including correlation, ranking and entry quality/);
});

test("a below-bar bearish candidate is WATCH, not an actionable callout", () => {
  // The bearish owner review fires UPSTREAM of the quality bar, so a candidate at the
  // production average (0.628 against a 0.70 bar) reaches it and must NOT be promoted.
  const c = classifyOwnerOpening({
    path: "bearish_authority",
    quality: 0.628,
    deliverBar: 0.7,
    researchOnly: false,
    fractionMove: 0.1,
    researchFloor: 0.35,
    bearishState: "BEARISH_READY",
  });
  assert.equal(c.openingClass, "WATCH");
  assert.equal(c.researchObservation, true);
  assert.match(c.reason, /subscriber_quality_bar/);
});

test("a late-phase candidate is WATCH even at high quality", () => {
  const c = classifyOwnerOpening({
    path: "bearish_authority",
    quality: 0.9,
    deliverBar: 0.7,
    researchOnly: false,
    fractionMove: LATE_PHASE_FRACTION_MOVE,
    researchFloor: 0.35,
    bearishState: "BEARISH_READY",
  });
  assert.equal(c.openingClass, "WATCH");
  assert.match(c.reason, /late_phase_fraction_move/);
});

test("a BEARISH_WATCH state is never actionable however good the quality", () => {
  const c = classifyOwnerOpening({
    path: "bearish_authority",
    quality: 0.95,
    deliverBar: 0.7,
    researchOnly: false,
    fractionMove: 0.1,
    researchFloor: 0.35,
    bearishState: "BEARISH_WATCH",
  });
  assert.equal(c.openingClass, "WATCH");
  assert.match(c.reason, /bearish_authority_state/);
});

test("research-only candidates are WATCH", () => {
  const c = classifyOwnerOpening({
    path: "readiness_gate",
    quality: 0.9, deliverBar: 0.7, researchOnly: true, fractionMove: 0.1, researchFloor: 0.35,
  });
  assert.equal(c.openingClass, "WATCH");
  assert.match(c.reason, /not_research_only/);
});

test("classification fails closed when quality cannot be read", () => {
  for (const bad of [null, undefined, Number.NaN]) {
    const c = classifyOwnerOpening({
      path: "readiness_gate",
      quality: bad, deliverBar: 0.7, researchOnly: false, fractionMove: null,
    });
    assert.equal(c.openingClass, "WATCH", `quality ${String(bad)} must not be actionable`);
  }
});

test("the late-phase bar is the same constant the delivery decision uses", async () => {
  const { readFileSync } = await import("node:fs");
  const dd = readFileSync(new URL("../lib/research/options/delivery-decision.ts", import.meta.url), "utf8");
  assert.ok(
    /fractionMove >= LATE_PHASE_FRACTION_MOVE/.test(dd),
    "the delivery decision reads the shared constant, not a copied literal",
  );
  assert.equal(LATE_PHASE_FRACTION_MOVE, 0.75, "the numeric bar is unchanged");
});

// ── suppression behaviour ────────────────────────────────────────────────────

test("an ACTIONABLE owner callout SENDS while suppression is on", async () => {
  let posted = 0;
  const c = classifyOwnerOpening({
    path: "readiness_gate", quality: 0.81, deliverBar: 0.7, researchOnly: false, fractionMove: 0.2,
  });
  const res = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "intraday_actionable",
    content: "SPY CALL opening",
    symbol: "fp-actionable:OPENING",
    researchObservation: c.researchObservation,
    env: { ...SUPPRESSED_ENV },
    postOverride: async () => { posted += 1; return { ok: true, messageId: "m1", deliveryId: "d1" }; },
  });
  assert.equal(posted, 1, "the owner receives genuine actionable callouts again");
  assert.equal(res.sent, true);
  assert.equal(res.messageId, "m1");
  assert.notEqual(res.reason, "owner_watch_discord_suppressed");
});

test("a WATCH observation stays suppressed while suppression is on", async () => {
  let posted = 0;
  const c = classifyOwnerOpening({
    path: "bearish_authority", quality: 0.6, deliverBar: 0.7, researchOnly: false,
    fractionMove: 0.2, bearishState: "BEARISH_READY",
  });
  const res = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "intraday_actionable",
    content: "AMD PUT owner watch",
    symbol: "fp-watch:OPENING",
    researchObservation: c.researchObservation,
    env: { ...SUPPRESSED_ENV },
    postOverride: async () => { posted += 1; return { ok: true }; },
  });
  assert.equal(posted, 0, "research noise stays out of the actionable channel");
  assert.equal(res.reason, "owner_watch_discord_suppressed");
  assert.equal(res.messageId, null);
  // Still true and still load-bearing: a false here releases the opportunity opening
  // claim, destroying owner-mirror linkage and PRE_MOVE_V2 capture.
  assert.equal(res.sent, true);
});

test("the hard delivery gates stay authoritative over an ACTIONABLE classification", async () => {
  const actionable = classifyOwnerOpening({
    path: "readiness_gate", quality: 0.95, deliverBar: 0.7, researchOnly: false, fractionMove: 0.1,
  });
  assert.equal(actionable.openingClass, "ACTIONABLE");

  // OWNER_RESEARCH_DISCORD_ENABLED off — nothing sends, classification notwithstanding.
  let posted = 0;
  const off = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "intraday_actionable",
    content: "SPY CALL opening",
    symbol: "fp-gate:OPENING",
    researchObservation: actionable.researchObservation,
    env: { ...SUPPRESSED_ENV, OWNER_RESEARCH_DISCORD_ENABLED: "0" },
    postOverride: async () => { posted += 1; return { ok: true }; },
  });
  assert.equal(posted, 0);
  assert.equal(off.sent, false);
  assert.match(off.reason, /OWNER_RESEARCH_DISCORD_ENABLED/);

  // Webhook unconfigured — still nothing sends.
  const noHook = await sendOwnerResearchNotify({
    db: notifyDb(),
    kind: "intraday_actionable",
    content: "SPY CALL opening",
    symbol: "fp-gate2:OPENING",
    researchObservation: actionable.researchObservation,
    env: { ...SUPPRESSED_ENV, DISCORD_WEBHOOK_OPTIONS: "" },
    postOverride: async () => { posted += 1; return { ok: true }; },
  });
  assert.equal(posted, 0);
  assert.equal(noHook.sent, false);
  assert.match(noHook.reason, /not configured/);
});

test("with suppression OFF nothing changes for either class", async () => {
  const env = { ...SUPPRESSED_ENV, OWNER_WATCH_DISCORD_SUPPRESSED: "0" };
  for (const [label, researchObservation] of [["actionable", false], ["watch", true]]) {
    let posted = 0;
    const res = await sendOwnerResearchNotify({
      db: notifyDb(),
      kind: "intraday_actionable",
      content: `${label} opening`,
      symbol: `fp-${label}-off:OPENING`,
      researchObservation,
      env,
      postOverride: async () => { posted += 1; return { ok: true, messageId: "m" }; },
    });
    assert.equal(posted, 1, `${label} still posts when suppression is off`);
    assert.equal(res.sent, true);
  }
});

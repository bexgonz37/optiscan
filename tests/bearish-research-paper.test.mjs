import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  bearishResearchPaperConfig,
  buildBearishResearchPaperSnapshot,
  openBearishResearchPaperOnDb,
} from "../lib/research/options/bearish-research-paper.ts";
import { canOpenRealOptionPaper } from "../lib/research/options/paper.ts";
import { resolveAccountKeyForOptionsPaperKind } from "../lib/broker/accounts.ts";

const NOW = Date.parse("2026-07-27T14:22:10.777Z");

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
      result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL,
      volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT,
      target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL,
      pnl REAL, return_pct REAL, mfe_pct REAL, mae_pct REAL, last_mark_return_pct REAL,
      exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT,
      feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT,
      experiment_id TEXT, experiment_variant TEXT, created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL, thesis_fingerprint TEXT
    );
    CREATE UNIQUE INDEX idx_bearish_paper_active_thesis
      ON options_paper_trades(thesis_fingerprint)
      WHERE status='ENTERED' AND thesis_fingerprint IS NOT NULL;
  `);
  return d;
}

function setup(overrides = {}) {
  return {
    deliveryInput: {
      candidateSymbol: "NVDA",
      strategy: "momentum_breakdown",
      researchOnly: false,
      contract: {
        optionSymbol: "O:NVDA260727P00200000",
        side: "put",
        strike: 200,
        expiration: "2026-07-27",
        dte: 0,
        bid: 0.49,
        ask: 0.5,
        spreadPct: 2.02,
        quoteAgeMs: 1_000,
        volume: 112_193,
        openInterest: 20_139,
        iv: 0.72,
        delta: -0.434,
        providerTimestamp: NOW - 1_000,
      },
      message: "unused",
      observedUnderlyingPrice: 199,
      currentUnderlyingPrice: 198.8,
      chaseLimitPct: 1,
      underlyingPrice: 198.8,
      decisionMs: NOW,
      session: "regular",
      entry: { bid: 0.49, ask: 0.5, mid: 0.495, spreadPct: 2.02, t1: 0.62, t2: 0.75, stop: 0.42, methodology: "test" },
    },
    authority: {
      state: "BEARISH_READY",
      maySubscriberSend: false,
      ownerReview: true,
      reasonCode: "bearish_ready_owner_review_only",
      reasons: [],
      blockers: ["BEARISH_SUBSCRIBER_DELIVERY_ENABLED!=1"],
      passed: ["support_break", "downside_momentum"],
      actionableReason: "Support broke with downside momentum.",
      invalidation: "Exit if bearish structure is reclaimed.",
    },
    quality: 0.9,
    opportunityFingerprint: "opp_nvda_put",
    opportunityCaseId: null,
    nowMs: NOW,
    ...overrides,
  };
}

const ENV = {
  BEARISH_RESEARCH_PAPER_ENABLED: "1",
  REAL_OPTION_PAPER_ENABLED: "1",
  PAPER_BEARISH_RESEARCH_STARTING_BALANCE_USD: "100000",
};

test("qualified NVDA PUT opens only in the isolated bearish research-paper lane", () => {
  const d = db();
  const result = openBearishResearchPaperOnDb(d, setup(), ENV);
  assert.equal(result.opened, true);
  const row = d.prepare("SELECT * FROM options_paper_trades").get();
  assert.equal(row.option_symbol, "O:NVDA260727P00200000");
  assert.equal(row.paper_kind, "BEARISH_RESEARCH_PAPER");
  assert.equal(row.entry_source, "bearish_authority_ready");
  assert.equal(row.alert_id, null);
  assert.equal(row.entry_fill, 0.498);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER'").get().n, 0);

  const rolled = setup();
  rolled.deliveryInput.contract = {
    ...rolled.deliveryInput.contract,
    optionSymbol: "O:NVDA260731P00195000",
    strike: 195,
    expiration: "2026-07-31",
  };
  rolled.deliveryInput.strategy = "vwap_rejection";
  const second = openBearishResearchPaperOnDb(d, rolled, ENV);
  assert.equal(second.opened, false);
  assert.equal(second.reason, "active_paper_position_for_thesis");
  const deliveredLane = canOpenRealOptionPaper(d, {
    optionSymbol: rolled.deliveryInput.contract.optionSymbol,
    strategy: rolled.deliveryInput.strategy,
    nowMs: NOW + 1,
    paperKind: "DELIVERED_ALERT_PAPER",
    thesisFingerprint: row.thesis_fingerprint,
  });
  assert.equal(deliveredLane.ok, false, "a different paper lane cannot silently duplicate the active thesis");
  assert.equal(deliveredLane.reason, "active_paper_position_for_thesis");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_paper_trades").get().n, 1);
});

test("bearish research paper requires its flag, READY authority, and valid freshness", () => {
  const d = db();
  assert.equal(openBearishResearchPaperOnDb(d, setup(), { ...ENV, BEARISH_RESEARCH_PAPER_ENABLED: "0" }).opened, false);
  assert.equal(openBearishResearchPaperOnDb(d, setup({
    authority: { ...setup().authority, state: "BEARISH_WATCH" },
  }), ENV).opened, false);
  const invalidFreshness = setup();
  invalidFreshness.deliveryInput.contract.quoteAgeMs = null;
  assert.equal(openBearishResearchPaperOnDb(d, invalidFreshness, ENV).reason, "quote_freshness_unavailable");
  assert.equal(openBearishResearchPaperOnDb(d, setup({
    authority: { ...setup().authority, state: "BEARISH_SEND" },
  }), ENV).reason, "authority_not_ready:BEARISH_SEND");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_paper_trades").get().n, 0);
});

test("bearish research account and metrics stay separate from delivered and 0DTE lanes", () => {
  const d = db();
  openBearishResearchPaperOnDb(d, setup(), ENV);
  const snapshot = buildBearishResearchPaperSnapshot(d, ENV);
  assert.equal(snapshot.account.identifier, "bearish_research");
  assert.equal(snapshot.account.startingBalanceUsd, 100000);
  assert.equal(snapshot.account.currentEquityUsd, 100000);
  assert.equal(resolveAccountKeyForOptionsPaperKind("BEARISH_RESEARCH_PAPER"), "bearish_research");
  assert.equal(resolveAccountKeyForOptionsPaperKind("ZERO_DTE_RESEARCH_PAPER"), "zero_dte_research");
  assert.equal(resolveAccountKeyForOptionsPaperKind("DELIVERED_ALERT_PAPER"), "subscriber_paper");
});

/**
 * Product-core fixes: delivered paper $ P&L, chase units, late-phase withhold, quote refresh.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { revalidateBeforeDiscordSend } from "../lib/research/options/final-delivery-revalidation.ts";
import { decideDeliveryBatch } from "../lib/research/options/delivery-decision.ts";
import { refreshDeliveryQuotes, deliverOptionsCallout } from "../lib/research/options/delivery.ts";
import { readOptionsReportOnDb } from "../lib/research/options/report.ts";
import { tradingDay } from "../lib/trading-session.ts";
import { formatOccContract, parseOccContract } from "../lib/format-contract.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const MON = Date.parse("2026-07-21T10:30:00-04:00");
const SESSION = tradingDay(MON);

test("paper page defaults to all accounts and reads verified diagnostic rows", () => {
  const src = read("app/paper/page.tsx");
  assert.match(src, /useState<PaperView>\("all"\)/);
  assert.match(src, /d\.diagnostic \?\? d/);
  assert.match(src, /pnlUsd/);
  assert.match(src, /verifiedPnlBreakdown/);
  assert.match(src, /subscriberDelivered/);
  assert.match(src, /verifiedPnlEligible/);
  assert.match(src, /No verified delivered-paper positions are available for this selected window/);
  assert.match(src, /dataSourceLabel/);
  assert.match(src, /formatOccContract/);
});

test("OCC contracts render as readable expiration, strike, and side labels", () => {
  assert.equal(formatOccContract("O:SPY260727C00636000"), "SPY 07/27 $636 Call");
  assert.equal(formatOccContract("O:QQQ260727P00568000"), "QQQ 07/27 $568 Put");
  assert.equal(formatOccContract("O:NVDA260731C00180500"), "NVDA 07/31 $180.5 Call");
  assert.equal(formatOccContract("not-an-occ"), null);
  assert.deepEqual(parseOccContract("O:IWM260729P00289000"), {
    symbol: "IWM",
    expiration: "2026-07-29",
    expirationLabel: "07/29",
    side: "put",
    strike: 289,
  });
});

test("subscriber report exposes sumPnlUsd as primary money metric", () => {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_symbol TEXT, side TEXT, dte INTEGER, strategy TEXT,
      result_class TEXT, status TEXT, return_pct REAL, pnl REAL,
      mfe_pct REAL, mae_pct REAL, exit_reason TEXT, paper_kind TEXT
    );
    CREATE VIEW options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
  `);
  d.prepare(
    `INSERT INTO options_paper_trades (option_symbol, side, dte, strategy, result_class, status, return_pct, pnl, mfe_pct, mae_pct, exit_reason, paper_kind)
     VALUES ('O:SPY','call',0,'orb','WIN','EXITED',50,125,60,10,'target_hit','DELIVERED_ALERT_PAPER'),
            ('O:QQQ','call',1,'orb','LOSS','EXITED',-20,-40,5,-25,'stop','DELIVERED_ALERT_PAPER')`,
  ).run();
  const rep = readOptionsReportOnDb(d);
  assert.equal(rep.subscriberPerformance.sumPnlUsd, 85);
  assert.equal(rep.subscriberPerformance.avgPnlUsd, 42.5);
  assert.match(rep.note, /sumPnlUsd|return-points/i);
});

test("underlying chase uses percent points not *100", () => {
  const r = revalidateBeforeDiscordSend({
    deliveryInput: {
      candidateSymbol: "NVDA",
      strategy: "momentum_acceleration",
      researchOnly: false,
      contract: {
        optionSymbol: "O:NVDA260725C00180000",
        side: "call",
        strike: 180,
        expiration: "2026-07-25",
        bid: 2.1,
        ask: 2.3,
        spreadPct: 4,
        quoteAgeMs: 1000,
        dte: 1,
      },
      message: "x",
      observedUnderlyingPrice: 179.0,
      currentUnderlyingPrice: 181.0, // ~1.12% favorable — above 0.6% chase
      chaseLimitPct: 0.6,
      underlyingPrice: 181.0,
      entry: { bid: 2.1, ask: 2.3, mid: 2.2, spreadPct: 4, quoteAgeMs: 1000, t1: 2.8, t2: 3.2, stop: 1.8, methodology: "test" },
      firstDetectedAtMs: MON - 30_000,
      underlyingAtFirstDetection: 179.0,
      optionAtFirstDetection: 2.15,
      tradingSessionDate: SESSION,
      featureSnapshot: { higherHighs: true, higherLows: true, aboveVwap: true },
    },
    nowMs: MON,
    firstReadyAtMs: MON - 20_000,
    readyExpiresAtMs: MON + 100_000,
  }, { ENTRY_QUALITY_GATE: "enforce", MARKET_SESSION_GUARD: "enforce" });
  assert.equal(r.allowed, false);
  assert.equal(r.rejectionCode, "CHASED_OPTION_PREMIUM");
  assert.match(r.reasons.join(" "), /0\.60%/);
});

test("late-phase fractionMove is RESEARCH_ONLY not Discord SEND", async () => {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_delivery_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT, symbol TEXT, strategy TEXT, side TEXT,
    outcome TEXT, reason TEXT, quality REAL, components_json TEXT, rank INTEGER, batch_size INTEGER,
    cluster_key TEXT, threshold REAL, session_state TEXT, would_deliver_solo INTEGER,
    alert_id TEXT, delivery_attempted INTEGER, delivery_sent INTEGER, delivery_state TEXT,
    final_delivery_outcome TEXT, delivery_failure_category TEXT, final_delivery_reason TEXT,
    created_at_ms INTEGER
  )`);
  const deliveries = [];
  const sub = {
    deliveryInput: {
      candidateSymbol: "SPY",
      strategy: "sr_reclaim",
      researchOnly: false,
      contract: { optionSymbol: "O:SPY260724C00640000", side: "call", strike: 640, expiration: "2026-07-24", bid: 1.2, ask: 1.3, spreadPct: 4, quoteAgeMs: 500, dte: 1 },
      message: "x",
      observedUnderlyingPrice: 638,
      currentUnderlyingPrice: 638,
      chaseLimitPct: 0.6,
      underlyingPrice: 638,
      decisionMs: MON,
      tradingSessionDate: SESSION,
    },
    symbol: "SPY",
    side: "call",
    strategy: "sr_reclaim",
    researchOnly: false,
    tier: 0,
    matchedSignals: 4,
    requiredSignals: 4,
    strategyScore: 1.0,
    spreadPct: 2,
    openInterest: 20000,
    volume: 5000,
    fractionMove: 0.82,
    levelProximityPct: 0.2,
    nowMs: MON,
  };
  const out = await decideDeliveryBatch([sub], {
    getDb: () => d,
    now: () => MON,
    deliver: async (input) => {
      deliveries.push(input);
      return { state: "SENT", alertId: "oa_x", sent: true, reason: "delivered", paperLinked: false };
    },
  }, {
    OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",
    MARKET_SESSION_GUARD: "shadow",
    ENTRY_QUALITY_GATE: "shadow",
  });
  assert.equal(out[0].outcome, "RESEARCH_ONLY");
  assert.match(out[0].reason, /late_phase_fraction_move/);
  assert.equal(deliveries.length, 0);
});

test("refreshDeliveryQuotes ages quote from providerTimestamp", async () => {
  const input = {
    candidateSymbol: "SPY",
    strategy: "orb",
    researchOnly: false,
    contract: {
      optionSymbol: "O:SPY260724C00640000",
      side: "call",
      strike: 640,
      expiration: "2026-07-24",
      bid: 1.2,
      ask: 1.3,
      spreadPct: 4,
      quoteAgeMs: 500,
      providerTimestamp: MON - 20_000,
      dte: 1,
    },
    message: "x",
    observedUnderlyingPrice: 638,
    currentUnderlyingPrice: 638,
    chaseLimitPct: 0.6,
    underlyingPrice: 638,
    decisionMs: MON - 5_000,
  };
  const refreshed = await refreshDeliveryQuotes(input, MON);
  assert.equal(refreshed.contract.quoteAgeMs, 20_000);
});

test("stale quote after refresh blocks deliverOptionsCallout before Discord", async () => {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT, strategy TEXT, option_symbol TEXT, side TEXT,
      research_only INTEGER, state TEXT, message_hash TEXT, message TEXT, delivered_bid REAL, delivered_ask REAL,
      delivered_underlying REAL, paper_linked INTEGER, discord_status INTEGER, latency_ms INTEGER,
      retry_count INTEGER, failure_reason TEXT, attempted_at_ms INTEGER, sent_at_ms INTEGER,
      session_state TEXT, entry_mid REAL, delivered_spread_pct REAL, quote_ts_ms INTEGER,
      target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT, created_at_ms INTEGER, updated_at_ms INTEGER
    );
  `);
  let sent = 0;
  const out = await deliverOptionsCallout(
    {
      candidateSymbol: "SPY",
      strategy: "sr_reclaim",
      researchOnly: false,
      contract: {
        optionSymbol: "O:SPY260724C00640000",
        side: "call",
        strike: 640,
        expiration: "2026-07-24",
        bid: 1.2,
        ask: 1.3,
        spreadPct: 4,
        quoteAgeMs: 500,
        providerTimestamp: MON - 500,
        dte: 1,
      },
      message: "SPY CALL",
      observedUnderlyingPrice: 638,
      currentUnderlyingPrice: 638.05,
      chaseLimitPct: 0.6,
      underlyingPrice: 638.05,
      decisionMs: MON,
      session: "regular",
      entry: { mid: 1.25, t1: 1.66, t2: 2.1, stop: 0.89, methodology: "fixed_r", bid: 1.2, ask: 1.3, spreadPct: 4, quoteAgeMs: 500 },
      tradingSessionDate: SESSION,
      firstDetectedAtMs: MON - 5_000,
      underlyingAtFirstDetection: 638,
      optionAtFirstDetection: 1.22,
      firstReadyAtMs: MON - 4_000,
      readyExpiresAtMs: MON + 100_000,
      featureSnapshot: { higherHighs: true, higherLows: true, aboveVwap: true },
    },
    {
      getDb: () => d,
      now: () => MON,
      refreshBeforeSend: async (input) => ({
        ...input,
        contract: { ...input.contract, quoteAgeMs: 60_000, providerTimestamp: MON - 60_000 },
      }),
      send: async () => {
        sent += 1;
        return { ok: true, status: 204, messageId: "m1", latencyMs: 5, ambiguous: false, error: null };
      },
    },
    {
      INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
      EARLY_OPTIONS_CALLOUTS_ENABLED: "1",
      OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",
      MARKET_SESSION_GUARD: "shadow",
      ENTRY_QUALITY_GATE: "shadow",
      OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED: "0",
      ENTRY_MAX_QUOTE_AGE_MS: "15000",
    },
  );
  assert.equal(sent, 0, "Discord must not send when refreshed quote is stale");
  assert.ok(["TOO_LATE", "REJECTED"].includes(out.state));
  assert.equal(out.reason, "QUOTE_STALE");
});

test("nav exposes redesigned decision surfaces with OWNER TOOLS", () => {
  const shell = read("components/AxiomShell.tsx");
  assert.match(shell, /label: "AI OPTIONS"/);
  assert.match(shell, /label: "DISCORD"/);
  assert.match(shell, /title: "OWNER TOOLS"/);
  assert.match(read("components/NowPage.tsx"), /Sent today/);
  assert.match(read("components/NowPage.tsx"), /Trade Ready/);
  assert.match(read("components/NowPage.tsx"), /Contract pending verification/);
  assert.match(read("app\/api\/now\/route.ts"), /formatOccContract/);
  assert.match(read("components/MobileBottomNav.tsx"), /"\/alerts"/);
});

test("Quant UI classifies evidence and keeps formulas advisory-only", () => {
  const src = read("app/quant/page.tsx");
  for (const label of ["SUPPORTED FINDING", "EARLY SIGNAL", "DATA QUALITY ISSUE", "HYPOTHESIS"]) {
    assert.match(src, new RegExp(label));
  }
  assert.match(src, /quant-formula-row/);
  assert.match(src, /Nothing applies automatically/);
  assert.match(src, /Required sample/);
  assert.doesNotMatch(src, /Winner capture is weak\.<\/strong>.*No negative finding/s);
});

test("loop uses first-detection price as observed for chase", () => {
  const src = read("lib/research/options/loop.ts");
  assert.match(src, /underlyingAtFirstDetection/);
  assert.match(src, /observedUnderlyingPrice: observedPx/);
});

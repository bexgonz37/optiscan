/**
 * asymmetry-reconstruct-nvda.mjs — reconstruct the production NVDA CALL alerts
 * from persisted case facts plus historical exact-OCC market data.
 *
 * READ ONLY. Issues bounded, accounted Massive requests via the historical
 * client and writes nothing anywhere. Prints the timeline, the derived
 * measures, the timing verdict, and whether ASYM_NOTIFY_V2 would suppress.
 *
 * Usage:
 *   node --experimental-strip-types scripts/asymmetry-reconstruct-nvda.mjs [caseFile.json]
 *
 * caseFile is the JSON body of /api/research/asymmetry/live, so the script can
 * reconstruct a PRODUCTION case from a laptop without database access.
 */
import fs from "node:fs";
import path from "node:path";
import { RequestAccountant, resolveRequestCaps } from "../lib/research/asymmetry/historical/request-accounting.ts";
import { HistoricalCache } from "../lib/research/asymmetry/historical/cache.ts";
import {
  fetchQuoteAtInstant, fetchPremiumCurve, fetchHistoricalBars,
} from "../lib/research/asymmetry/historical/massive-historical.ts";
import {
  classifyTiming, gateWouldSuppress, DEFAULT_TIMING_THRESHOLDS,
} from "../lib/research/asymmetry/timing-classification.ts";
import { decideNotification, DEFAULT_NOTIFICATION_STRENGTH } from "../lib/research/asymmetry/notification-gate.ts";
import { vwapFromBars, momentumPct, localHigh, priceAt } from "../lib/research/asymmetry/reconstruct.ts";

// Load POLYGON_API_KEY from .env.local when not already in the environment.
if (!process.env.POLYGON_API_KEY && !process.env.MASSIVE_API_KEY) {
  const envPath = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}

const snapshotPath = process.argv[2];
if (!snapshotPath || !fs.existsSync(snapshotPath)) {
  console.error("usage: node --experimental-strip-types scripts/asymmetry-reconstruct-nvda.mjs <live-snapshot.json>");
  process.exit(1);
}
const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const sessionDate = snap.sessionDate;
const cases = (snap.activeCases || []).filter((c) => c.symbol === "NVDA" && c.direction === "CALL");
const transitions = snap.recentTransitions || [];

const accountant = new RequestAccountant(resolveRequestCaps(process.env));
const cache = new HistoricalCache();
const deps = { accountant, cache, env: process.env };

const iso = (ms) => (ms == null ? "unavailable" : new Date(ms).toISOString().replace("T", " ").slice(0, 23) + "Z");
const money = (v) => (v == null ? "unavailable" : `$${Number(v).toFixed(2)}`);
const pct = (v) => (v == null ? "unavailable" : `${Number(v).toFixed(2)}%`);

console.log(`\n=== NVDA CALL RECONSTRUCTION — session ${sessionDate} ===`);
console.log(`cases found: ${cases.length}\n`);

for (const c of cases) {
  const occ = c.optionSymbol;
  const first = c.firstDetectedAtMs;
  // The transition sweep that promoted this case is the alert candidate window.
  const highAsymSweeps = transitions
    .filter((t) => t.to_state === "HIGH_ASYMMETRY" && t.occurred_at_ms >= first)
    .map((t) => t.occurred_at_ms)
    .sort((a, b) => a - b);
  const alertAtMs = highAsymSweeps[0] ?? null;

  const fromMs = first - 60 * 60_000;
  const toMs = (alertAtMs ?? first) + 90 * 60_000;

  // NBBO at the two instants that matter — one exact request each, never a
  // truncatable bulk window. Premium SHAPE comes from 1-minute aggregates.
  const capQ = await fetchQuoteAtInstant(occ, first, deps, { symbol: "NVDA" });
  const alertQ = alertAtMs != null ? await fetchQuoteAtInstant(occ, alertAtMs, deps, { symbol: "NVDA" }) : { quote: null, outcome: null };
  const curve = await fetchPremiumCurve(occ, fromMs, toMs, deps, { symbol: "NVDA" });
  const b = await fetchHistoricalBars("NVDA", fromMs, toMs, deps, { multiplier: 1, timespan: "minute", symbol: "NVDA" });
  const bars = b.rows;

  const atCapture = capQ.quote;
  const atAlert = alertQ.quote;
  const firstValid = curve.rows.find((x) => x.c > 0) ?? null;
  // Peak TRADED premium before / across the session, from aggregates.
  const preBars = alertAtMs != null ? curve.rows.filter((x) => x.t >= first && x.t <= alertAtMs) : [];
  const sessBars = curve.rows.filter((x) => x.t >= first);
  const peakOf = (rows) => rows.reduce((acc, r) => (acc == null || r.h > acc.h ? r : acc), null);
  const preEx = { peakAsk: peakOf(preBars)?.h ?? null, peakAskAtMs: peakOf(preBars)?.t ?? null };
  const sessEx = { peakAsk: peakOf(sessBars)?.h ?? null, peakAskAtMs: peakOf(sessBars)?.t ?? null };

  const undCapture = c.underlyingPrice ?? priceAt(bars, first);
  const undAlert = alertAtMs != null ? priceAt(bars, alertAtMs) : null;
  const vwap = alertAtMs != null ? vwapFromBars(bars, alertAtMs) : null;
  const mom5 = alertAtMs != null ? momentumPct(bars, alertAtMs, 5 * 60_000) : null;
  const hi = alertAtMs != null ? localHigh(bars, alertAtMs, first) : null;
  const pull = hi != null && undAlert != null ? ((hi - undAlert) / hi) * 100 : null;

  const entryAsk = c.earlyAsk ?? atCapture?.ask ?? null;
  const askAlert = atAlert?.ask ?? null;
  const chase = entryAsk && askAlert ? ((askAlert - entryAsk) / entryAsk) * 100 : null;
  const spreadAlert = atAlert?.bid != null && atAlert?.ask ? ((atAlert.ask - atAlert.bid) / atAlert.ask) * 100 : null;

  console.log(`──────────────────────────────────────────────────────────────`);
  console.log(`OCC ${occ}   case ${c.fingerprint}`);
  console.log(`state now: ${c.state}   setup: ${c.setupFamily}`);
  console.log(`\nSTAGES`);
  console.log(`  candidate first seen / first capture  ${iso(first)}  und ${money(undCapture)}  ask ${money(entryAsk)}`);
  console.log(`    NBBO at capture (historical)        bid ${money(atCapture?.bid)} / ask ${money(atCapture?.ask)}  stamped ${iso(atCapture?.atMs)}`);
  console.log(`  first traded bar in window            ${iso(firstValid?.t)}  close ${money(firstValid?.c)}`);
  console.log(`  HIGH_ASYMMETRY (alert sweep)          ${iso(alertAtMs)}  und ${money(undAlert)}  bid ${money(atAlert?.bid)} / ask ${money(askAlert)}`);
  console.log(`  peak TRADED premium before alert      ${iso(preEx.peakAskAtMs)}  high ${money(preEx.peakAsk)}`);
  console.log(`  session peak TRADED premium           ${iso(sessEx.peakAskAtMs)}  high ${money(sessEx.peakAsk)}`);

  console.log(`\nDERIVED`);
  console.log(`  capture-to-alert delay        ${alertAtMs != null ? Math.round((alertAtMs - first) / 1000) + "s" : "unavailable"}`);
  console.log(`  quote age at alert            ${atAlert && alertAtMs != null ? Math.round((alertAtMs - atAlert.atMs) / 1000) + "s" : "unavailable"}`);
  console.log(`  premium at capture            ${money(entryAsk)}`);
  console.log(`  premium at alert              ${money(askAlert)}`);
  console.log(`  premium expansion to alert    ${pct(chase)}`);
  console.log(`  peak-to-alert give-back       ${preEx.peakAsk && entryAsk && askAlert && preEx.peakAsk > entryAsk
    ? pct(((preEx.peakAsk - askAlert) / (preEx.peakAsk - entryAsk)) * 100) : "unavailable (no measurable peak gain)"}`);
  console.log(`  underlying move to alert      ${pct(undCapture && undAlert ? ((undAlert - undCapture) / undCapture) * 100 : null)}`);
  console.log(`  5-min momentum at alert       ${pct(mom5)}   ${mom5 == null ? "" : mom5 < 0 ? "(NEGATIVE — rolling over)" : "(positive)"}`);
  console.log(`  VWAP at alert                 ${money(vwap)}  price ${undAlert != null && vwap != null ? (undAlert > vwap ? "ABOVE" : "BELOW") : "unknown"}`);
  console.log(`  local high before alert       ${money(hi)}   pullback ${pct(pull)}`);
  console.log(`  spread at alert               ${pct(spreadAlert)}`);

  const verdict = classifyTiming({
    quoteAgeAtAlertMs: atAlert && alertAtMs != null ? alertAtMs - atAlert.atMs : null,
    premiumChasePctAtAlert: chase,
    entryAskAtCapture: entryAsk,
    askAtAlert: askAlert,
    peakAskBeforeAlert: preEx.peakAsk,
    peakAskSession: sessEx.peakAsk,
    shortWindowMomentumPct: mom5,
    localHighBeforeAlert: hi,
    underlyingAtAlert: undAlert,
    aboveVwapAtAlert: vwap != null && undAlert != null ? undAlert > vwap : null,
    triggerReclaimedThenLost: null,
    unconfirmedAtAlert: false,
    observations: preBars.length,
  }, DEFAULT_TIMING_THRESHOLDS);

  console.log(`\nTIMING VERDICT  ${verdict.verdict}  [${verdict.code}]`);
  console.log(`  ${verdict.rationale}`);
  console.log(`  measures: giveBack=${verdict.measures.giveBackFractionAtAlert} capturedFractionOfPeak=${verdict.measures.capturedFractionOfPeak} pullback=${verdict.measures.pullbackFromLocalHighPct}%`);

  // Replay ASYM_NOTIFY_V2 over the reconstructed evidence, exactly as production
  // would have seen it — including peakAsk, which production could NOT see
  // because forward marks were failing.
  const asProduction = decideNotification({
    state: "HIGH_ASYMMETRY", optionSymbol: occ,
    bid: atAlert?.bid ?? null, ask: askAlert, quoteAtMs: atAlert?.atMs ?? null,
    underlyingPrice: undAlert, spreadPct: spreadAlert, premiumChasePct: chase,
    openInterest: null, contractVolume: null, missingEvidence: c.missingEvidence ?? [],
    trigger: null, invalidation: null, nowMs: alertAtMs,
    entryAskAtCapture: entryAsk, peakAskSinceCapture: null, // marks were empty in prod
  }, DEFAULT_NOTIFICATION_STRENGTH);
  const withMarks = decideNotification({
    state: "HIGH_ASYMMETRY", optionSymbol: occ,
    bid: atAlert?.bid ?? null, ask: askAlert, quoteAtMs: atAlert?.atMs ?? null,
    underlyingPrice: undAlert, spreadPct: spreadAlert, premiumChasePct: chase,
    openInterest: null, contractVolume: null, missingEvidence: c.missingEvidence ?? [],
    trigger: null, invalidation: null, nowMs: alertAtMs,
    entryAskAtCapture: entryAsk, peakAskSinceCapture: preEx.peakAsk, // what marks SHOULD have supplied
  }, DEFAULT_NOTIFICATION_STRENGTH);

  console.log(`\nASYM_NOTIFY_V2 REPLAY`);
  console.log(`  as production saw it (no marks): notify=${asProduction.notify} timing=${asProduction.timing} reason=${asProduction.reason}`);
  console.log(`  with working marks:              notify=${withMarks.notify} timing=${withMarks.timing} reason=${withMarks.reason}`);
  console.log(`  post-hoc verdict implies suppress: ${gateWouldSuppress(verdict.verdict)}`);
  console.log(`\ncoverage: ${curve.rows.length} option 1m bars, ${bars.length} underlying bars, NBBO points ${[atCapture, atAlert].filter(Boolean).length}/2`
    + `${curve.truncated ? " [OPTION CURVE TRUNCATED]" : ""}${b.truncated ? " [UNDERLYING TRUNCATED]" : ""}`
    + `${capQ.outcome?.ok === false ? ` (capture NBBO: ${capQ.outcome.note})` : ""}`
    + `${alertQ.outcome?.ok === false ? ` (alert NBBO: ${alertQ.outcome.note})` : ""}`);
}

console.log(`\n=== REQUEST ACCOUNTING ===`);
console.log(JSON.stringify(accountant.snapshot(), null, 1));

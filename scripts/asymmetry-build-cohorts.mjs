/**
 * asymmetry-build-cohorts.mjs — build historical winner/control cohorts for one
 * underlying and one session, from real exact-OCC market data.
 *
 * READ ONLY. Bounded and accounted: cost is linear in contracts evaluated, so
 * start small and read the accounting before scaling. Writes nothing.
 *
 * Usage:
 *   node --experimental-strip-types scripts/asymmetry-build-cohorts.mjs \
 *     NVDA 2026-07-31 --entry 14:00 --exit 19:45 --max 40
 *
 * Times are UTC HH:MM. Entry and exit are FIXED and identical for every
 * contract, so no outcome information can select them.
 */
import fs from "node:fs";
import path from "node:path";
import { RequestAccountant, resolveRequestCaps } from "../lib/research/asymmetry/historical/request-accounting.ts";
import { HistoricalCache } from "../lib/research/asymmetry/historical/cache.ts";
import {
  buildCohorts, matchControls, reviewMissedWinners, missedWinnerSummary, MINIMUM_SUPPORTED_SAMPLE,
} from "../lib/research/asymmetry/historical/cohort-builder.ts";

if (!process.env.POLYGON_API_KEY && !process.env.MASSIVE_API_KEY) {
  const p = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}

const args = process.argv.slice(2);
const underlying = (args[0] || "NVDA").toUpperCase();
const sessionDate = args[1] || "2026-07-31";
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const at = (hhmm) => Date.parse(`${sessionDate}T${hhmm}:00Z`);
const entryAtMs = at(flag("entry", "14:00"));
const exitAtMs = at(flag("exit", "19:45"));
const maxContracts = Number(flag("max", "40"));
const side = flag("side", null);

const accountant = new RequestAccountant(resolveRequestCaps(process.env));
const cache = new HistoricalCache();

console.log(`\n=== COHORTS — ${underlying} ${sessionDate} ===`);
console.log(`entry ${new Date(entryAtMs).toISOString()}  exit ${new Date(exitAtMs).toISOString()}`);
console.log(`max contracts ${maxContracts}${side ? `  side ${side}` : ""}\n`);

const res = await buildCohorts({
  underlying, sessionDate,
  // Contracts expiring in the two weeks after the session — the window a
  // short-horizon radar actually trades.
  expirationFrom: sessionDate,
  expirationTo: new Date(Date.parse(sessionDate) + 14 * 86400000).toISOString().slice(0, 10),
  side: side || undefined,
  entryAtMs, exitAtMs, maxContracts, minSessionVolume: 1,
}, { accountant, cache, env: process.env });

console.log("BAND COUNTS");
for (const [b, n] of Object.entries(res.bandCounts)) if (n) console.log(`  ${b.padEnd(12)} ${n}`);
console.log("\nUNGRADEABLE REASONS");
for (const [r, n] of Object.entries(res.ungradeableReasons)) console.log(`  ${r.padEnd(30)} ${n}`);

console.log(`\nCOVERAGE  universe=${res.coverage.universeContracts} evaluated=${res.coverage.evaluated}`
  + ` budgetBlocked=${res.coverage.budgetBlocked} truncated=${res.coverage.truncatedCurves}`);
if (res.coverage.providerNotes.length) console.log("  notes:", res.coverage.providerNotes.slice(0, 3).join(" | "));

const fmt = (r) => `${r.occ.padEnd(24)} ${String(r.side).padEnd(4)} entry $${String(r.entryAsk).padEnd(7)}`
  + ` exit $${String(r.exitBid).padEnd(7)} ret ${String(r.finalReturnPct).padStart(8)}%`
  + ` mfe ${String(r.mfePct).padStart(8)}% vol ${r.sessionVolume}`;

console.log(`\nWINNERS (${res.winners.length})`);
for (const r of res.winners.slice(0, 15)) console.log("  " + fmt(r));
console.log(`\nCONTROLS (${res.controls.length}) — sample`);
for (const r of res.controls.slice(0, 8)) console.log("  " + fmt(r));

if (!res.comparison) {
  console.log("\nCOMPARISON: withheld — no control cohort. Winners alone are not a finding.");
} else {
  const c = res.comparison;
  console.log(`\nCOMPARISON  winners=${c.winnerCount} controls=${c.controlCount}`
    + `  sampleSufficient=${c.sampleSufficient} (minimum ${MINIMUM_SUPPORTED_SAMPLE} each)`);
  for (const f of c.features) {
    console.log(`  ${f.feature.padEnd(20)} winner=${String(f.winnerMedian).padStart(9)}`
      + ` control=${String(f.controlMedian).padStart(9)} diff=${String(f.difference).padStart(9)}`);
  }
  console.log(`  ${c.features[0]?.note ?? ""}`);
  const pairs = matchControls(res.winners, res.controls);
  console.log(`\nMATCHED PAIRS: ${pairs.length}`);
  for (const p of pairs.slice(0, 6)) {
    console.log(`  ${p.winner.occ} (${p.winner.finalReturnPct}%) vs ${p.control.occ} (${p.control.finalReturnPct}%)  distance ${p.distance}`);
  }
}

// MISSED-WINNER REVIEW. Optional: pass --captured <live-snapshot.json>, the
// body of /api/research/asymmetry/live, to compare what actually moved against
// what the radar took.
const capturedPath = flag("captured", null);
if (capturedPath && fs.existsSync(capturedPath)) {
  const snap = JSON.parse(fs.readFileSync(capturedPath, "utf8"));
  const cases = (snap.activeCases ?? snap ?? []).map((c) => ({
    optionSymbol: c.optionSymbol, symbol: c.symbol, direction: c.direction,
    notified: undefined, finalReturnPct: null,
  }));
  const reviewed = reviewMissedWinners(res.winners, cases);
  console.log(`\n=== MISSED-WINNER REVIEW (against ${cases.length} captured cases) ===`);
  console.log("  " + JSON.stringify(missedWinnerSummary(reviewed)));
  for (const m of reviewed) {
    console.log(`\n  ${m.occ}  ${m.finalReturnPct}%  (mfe ${m.mfePct}%)  entry $${m.entryAsk}  vol ${m.sessionVolume}`);
    console.log(`    ${m.disposition}${m.capturedInsteadOcc ? ` -> radar took ${m.capturedInsteadOcc}` : ""}`);
    console.log(`    ${m.note}`);
  }
}

console.log("\nLIMITATIONS");
for (const l of res.limitations) console.log(`  - ${l}`);

const snap = accountant.snapshot();
console.log("\n=== REQUEST ACCOUNTING ===");
console.log(`  requests: ${JSON.stringify(snap.requests)}`);
console.log(`  cacheHits=${snap.cacheHits} cacheMisses=${snap.cacheMisses} retries=${snap.retries}`
  + ` 429s=${snap.rateLimited429} failures=${snap.providerFailures}`);
console.log(`  budgetBlocks=${snap.budgetBlocks} ${JSON.stringify(snap.blocksByReason)} circuitOpen=${snap.circuitOpen}`);
const total = Object.values(snap.requests).reduce((a, b) => a + b, 0);
console.log(`  TOTAL ${total} requests for ${res.coverage.evaluated} contracts`
  + ` (${(total / Math.max(1, res.coverage.evaluated)).toFixed(2)} per contract)`);

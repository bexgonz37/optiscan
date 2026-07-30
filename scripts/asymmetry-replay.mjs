/**
 * scripts/asymmetry-replay.mjs — run the High-Asymmetry replay against a real
 * OptiScan database file, offline and read-only.
 *
 * The database is opened READONLY at the sqlite level, so the script physically
 * cannot write to it even if a future edit tried to. It performs SELECTs only,
 * adds no migration, and never contacts a provider, Discord, or any network.
 *
 * Usage:
 *   node --experimental-strip-types scripts/asymmetry-replay.mjs [options]
 *
 *   --db <path>         database file (default: $ALERT_DB_DIR/optiscan.db,
 *                       else ./data/optiscan.db)
 *   --dates a,b         explicit sessions (default: most recent available)
 *   --sessions N        how many recent sessions to discover (default 5)
 *   --limit N           detail rows to print (default 25)
 *   --identity S        OCC_SESSION_FIRST_OBSERVATION | OCC_SESSION_CLUSTER |
 *                       OCC_SESSION_FINGERPRINT
 *   --at <ms>           evidence horizon, for a reproducible run
 *   --json              print the full result as JSON instead of a summary
 */
import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import Database from "better-sqlite3";
import { runAsymmetryReplayOnDb, replayCoverageSummary } from "../lib/research/asymmetry/replay.ts";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

const args = parseArgs(process.argv);
const dbPath = args.db
  ?? path.join(process.env.ALERT_DB_DIR || path.join(process.cwd(), "data"), "optiscan.db");

if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  console.error("");
  console.error("Point --db at a real OptiScan database to replay it, for example a copy of the");
  console.error("production file. Nothing is written to it: the file is opened readonly.");
  process.exit(2);
}

// readonly: true is the hard guarantee. fileMustExist avoids creating an empty
// database and then reporting "no evidence" about a file we just made.
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const result = runAsymmetryReplayOnDb(db, {
  sessionDates: typeof args.dates === "string" ? args.dates.split(",").map((d) => d.trim()).filter(Boolean) : undefined,
  maxSessions: Number.isFinite(Number(args.sessions)) ? Number(args.sessions) : undefined,
  detailLimit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : 25,
  evaluationAtMs: Number.isFinite(Number(args.at)) ? Number(args.at) : undefined,
  identityStrategy: typeof args.identity === "string" ? args.identity : undefined,
});

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
  db.close();
  process.exit(0);
}

const n = (value) => (value == null ? "—" : String(value));
const line = (label, value) => console.log(`  ${label.padEnd(42)} ${n(value)}`);

console.log(`\nHigh-Asymmetry replay — ${dbPath}`);
console.log(`Read-only: ${result.readOnly}   writes: ${result.writesPerformed}   identity: ${result.identityStrategy}`);
console.log(`Evidence horizon: ${new Date(result.evaluationAtMs).toISOString()}`);

console.log("\nSessions");
line("available in database", result.sessionsAvailableInDb.length ? result.sessionsAvailableInDb.join(", ") : "none");
line("replayed", result.sessionsWithData.length ? result.sessionsWithData.join(", ") : "none");

console.log("\nData coverage");
const c = result.coverage;
line("total observations", c.totalObservations);
line("observations without a contract", c.observationsWithoutContract);
line("distinct exact-OCC contracts", c.distinctOccContracts);
line("distinct candidate detections", c.distinctCandidateDetections);
line("distinct trading sessions", c.distinctTradingSessions);
line("distinct symbols", c.distinctSymbols);
line("with fresh exact-OCC ask entry", c.candidatesWithFreshAskEntry);
line("with subsequent fresh bid marks", c.candidatesWithSubsequentFreshBidMarks);
line("with MFE evidence", c.candidatesWithMfeEvidence);
line("with MAE evidence", c.candidatesWithMaeEvidence);
line("with premium-chase baseline", c.candidatesWithPremiumChaseBaseline);
line("GRADEABLE", c.gradeableCandidates);
line("ungradeable", c.ungradeableCandidates);

console.log("\nGradeable by horizon");
for (const [horizon, count] of Object.entries(c.gradeableByHorizon)) line(horizon, count);

console.log("\nExclusion reasons");
for (const [reason, count] of Object.entries(c.exclusions)) line(reason, count);

console.log("\nOutcome counts");
for (const [label, count] of Object.entries(result.report.outcomeCounts)) line(label, count);

console.log("\nPremium-chase distribution");
for (const [bucket, count] of Object.entries(result.report.premiumChaseDistribution)) line(bucket, count);

console.log("\nDuplicate-detection audit");
const d = result.duplicateAudit;
line("contracts examined", d.contractsExamined);
line("contracts with >1 observation", d.contractsWithMultipleObservations);
for (const [gapMs, count] of Object.entries(d.contractsWithMultipleClustersByGapMs)) {
  line(`contracts splitting at ${Number(gapMs) / 60000}m gap`, count);
}
line("contracts with >1 thesis fingerprint", d.contractsWithMultipleFingerprints);
line("rows carrying a fingerprint", `${d.rowsCarryingFingerprint} of ${d.totalRows}`);
line("candidates with vacuous premium chase", d.candidatesWithVacuousPremiumChase);
for (const [strategy, count] of Object.entries(d.candidateCountByStrategy)) line(`candidates under ${strategy}`, count);
line("recommendation", d.recommendation);
console.log(`  reason: ${d.recommendationReason}`);

if (result.rows.length) {
  console.log("\nReplay rows");
  for (const row of result.rows) {
    console.log(`  ${row.symbol.padEnd(6)} ${n(row.occSymbol).padEnd(22)} ${row.label.padEnd(22)} ` +
      `entry=${n(row.entryAsk)} peak=${n(row.peakVerifiedBid)} mfe=${n(row.mfePct)} mae=${n(row.maePct)} ` +
      `chase=${row.premiumChaseBucket}${row.exclusionReason ? ` excluded=${row.exclusionReason}` : ""}`);
  }
}

if (result.warnings.length) {
  console.log("\nWarnings");
  for (const warning of result.warnings) console.log(`  - ${warning}`);
}

console.log("\nKnown unsourced fields (no persisted source yet)");
console.log(`  ${result.knownUnsourcedFields.join(", ")}`);
console.log("\nNOT subscriber performance. NOT predictions. Zero gradeable candidates means");
console.log("evidence is absent, not that a strategy performed at zero.\n");

db.close();

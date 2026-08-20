/**
 * Encoding regression guard.
 *
 * `nightly-research.ts` shipped `**OWNER DISCORD ALERTS** <U+00E2 U+20AC U+201D> the alerts you
 * received` to Discord: an em dash whose UTF-8 bytes had been read as CP1252 and re-encoded,
 * so the file literally stored U+00E2 U+20AC U+201D where U+2014 belonged. 955 such runs
 * existed across four files -- most of them the `──` section rules in doc comments, which is
 * how the damage spread unnoticed: nobody reads a comment for encoding.
 *
 * The detector below is structural rather than a list of known-bad strings. Mojibake is
 * always a CP1252 lead character followed by CP1252 renderings of UTF-8 continuation bytes,
 * so any NEW sequence of the same shape fails this test without anyone having to add it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".next", ".git", "graphify-out", "out", "dist", "coverage"]);
const EXT = /\.(ts|tsx|mjs|js|jsx|md)$/;

/** CP1252 renderings of UTF-8 lead bytes 0xC2-0xF0 -- how a mojibake run always begins. */
const LEAD = /[ÂÃâãåïð]/;

/** CP1252 renderings of UTF-8 continuation bytes 0x80-0xBF. */
const CONTINUATION = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);
const isContinuation = (cp) => CONTINUATION.has(cp) || (cp >= 0x0080 && cp <= 0x00bf);

export function findMojibake(text) {
  const chars = [...text];
  const hits = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (!LEAD.test(chars[i])) continue;
    let j = i + 1;
    while (j < chars.length && isContinuation(chars[j].codePointAt(0))) j += 1;
    if (j > i + 1) {
      hits.push({
        seq: chars.slice(i, j).join(""),
        codepoints: chars.slice(i, j).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`).join(" "),
        context: chars.slice(Math.max(0, i - 40), j + 10).join(""),
      });
      i = j - 1;
    }
  }
  return hits;
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

// Written as escapes, never as literal characters: a guard whose fixtures are themselves
// mojibake would fail its own tree scan below, which is exactly what happened first time.
/** What an em dash (U+2014) became. */
const BROKEN_EM_DASH = String.fromCharCode(0x00E2, 0x20AC, 0x201D);
/** What a box-drawing rule (U+2500) became -- 937 of the 955 damaged runs. */
const BROKEN_RULE = String.fromCharCode(0x00E2, 0x201D, 0x20AC);

test("the detector recognises the exact damage that shipped", () => {
  assert.equal(
    findMojibake(`OWNER DISCORD ALERTS ${BROKEN_EM_DASH} the alerts you actually received`).length,
    1,
  );
  // Two damaged characters are two runs: each starts with its own lead byte, and a lead
  // byte is never a continuation byte, so adjacent damage is counted, not merged.
  assert.equal(findMojibake(`// ${BROKEN_RULE}${BROKEN_RULE} registry`).length, 2);
  // And it round-trips: encoding the run as CP1252 and reading it as UTF-8 gives the
  // character that belonged there.
  assert.equal(Buffer.from([0xe2, 0x80, 0x94]).toString("utf8"), "—");
  assert.equal(Buffer.from([0xe2, 0x94, 0x80]).toString("utf8"), "─");
});

test("the detector does not fire on correctly encoded text", () => {
  for (const clean of [
    "OWNER DISCORD ALERTS — the alerts you actually received",
    "── the mirror ───────────",
    "🔬 SPY CALL · OWNER WATCH · OWNER_ONLY",
    "⛔ SPY CALL · STOPPED / CLOSED",
    "café naïve Ærø",
    "plain ascii only",
  ]) {
    assert.deepEqual(findMojibake(clean), [], `false positive on: ${clean}`);
  }
});

test("no source file contains mojibake", () => {
  const offenders = [];
  for (const file of sourceFiles(ROOT)) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const hits = findMojibake(text);
    if (hits.length) {
      offenders.push(`${relative(ROOT, file)}: ${hits.length} (${hits[0].codepoints} in "${hits[0].context.trim()}")`);
    }
  }
  assert.deepEqual(offenders, [], `mojibake found:\n${offenders.join("\n")}`);
});

test("recap copy emitted to Discord uses ASCII separators", async () => {
  const { formatNightlyResearchSections } = await import("../lib/research/options/nightly-research.ts");
  const empty = {
    ran: true, sessionDate: "2026-08-20", productionBehaviorChanged: false,
    experimentFrozen: true, experimentFrozenMessage: "", experimentStatus: "PROPOSED",
    statusChanged: false,
    owner: {
      sessionDate: "2026-08-20", lane: "OWNER_VALIDATION_PAPER", openings: 0, paperMirrors: 0,
      closed: 0, open: 0, ungradable: 0, realizedWins: 0, realizedLosses: 0, winRate: null,
      expectancyPct: null, medianRealizedReturnPct: null, profitFactor: null,
      profitFactorWithoutTopWinner: null, bestWinnerPct: null, worstLossPct: null,
      callCount: 0, putCount: 0, immediateFailures: 0, profitGivenBack: 0,
      withoutTrajectoryEvidence: 0, stopLeakage: 0, heldOvernight: 0, overnightGaps: 0,
      byStrategy: [], byPathLabel: {}, independentSessions: 0, sessions: [],
      mirrorRate: null, unavailableMetrics: [],
    },
    delivery: null,
    scoreboard: {
      experimentId: "LHC_SELECT_V1", baselineAdmits: 0, experimentAdmits: 0, baselineOnly: 0,
      experimentOnly: 0, closedOutcomes: 0, openOutcomes: 0, sessionsObserved: 0,
      opportunitiesEvaluated: 0, honestSummary: "nothing yet", winnersRejected: [],
    },
    verdict: { verdict: "INSUFFICIENT_EVIDENCE", reason: "no outcomes" },
    findingsWritten: 0, outcomesRefreshed: 0,
    ownerSelectionStrength: null, ownerSelectionStrengthFrozen: true, exitRisk: null,
  };
  const message = formatNightlyResearchSections(empty).join("\n");
  assert.deepEqual(findMojibake(message), [], "recap copy must never carry mojibake");
  // The separators that were double-encoded are gone from emitted copy entirely, so a
  // future encoding slip has nothing in this formatter to damage.
  assert.ok(!message.includes("—"), "no em dash in emitted recap copy");
  assert.ok(!message.includes("·"), "no middle dot in emitted recap copy");
  assert.match(message, /\*\*DELIVERED TO YOU\*\* -- /);
});

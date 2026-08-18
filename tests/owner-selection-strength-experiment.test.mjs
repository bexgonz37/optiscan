/**
 * OWNER_SELECTION_STRENGTH_GATE_V1 — the frozen rule, its arms, and the ways it must be
 * allowed to lose.
 *
 * The load-bearing test in this file is not that the rule separates winners from losers. It
 * is that a callout with NO frozen strength never lands in the reject arm — because the
 * finding this experiment was built from ("<75: n≈26, PF 0.167") turned out to be
 * "<75 OR unmeasured", and half of it was 13 trades the rule cannot judge at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSelectionStrength,
  simulate,
  definitionHash,
  armStats,
  EXPERIMENT_ID,
  EXPERIMENT_MODE,
  SELECTION_STRENGTH_FLOOR,
} from "../lib/research/options/owner-selection-strength-experiment.ts";
import {
  OWNER_SELECTION_STRENGTH_GATE_V1,
  OWNER_SELECTION_STRENGTH_GATE_V1_DEFINITION_HASH,
  checkOwnerSelectionStrengthFrozen,
  EXPERIMENT_REGISTRY,
  findExperiment,
  EXPERIMENT_STATUSES,
} from "../lib/research/options/experiment-registry.ts";
import {
  deriveVerdict,
  MIN_CLOSED_PROSPECTIVE_OUTCOMES,
  MIN_INDEPENDENT_SESSIONS,
} from "../lib/research/options/owner-selection-strength-scoreboard.ts";

let id = 0;
function row(strength, returnPct, over = {}) {
  return {
    opportunityCaseId: `oc_${++id}`,
    sessionDate: "2026-08-20",
    symbol: "TEST",
    optionSymbol: "O:TEST260821P00100000",
    side: "PUT",
    strategyKey: "lower_high_continuation",
    selectionStrength: strength,
    realizedReturnPct: returnPct,
    occExact: true,
    ...over,
  };
}

// ── the rule ─────────────────────────────────────────────────────────────────

test("the floor admits at exactly 75 and rejects just below it", () => {
  assert.equal(SELECTION_STRENGTH_FLOOR, 75);
  assert.equal(evaluateSelectionStrength({ selectionStrength: 75 }).verdict, "ADMIT");
  assert.equal(evaluateSelectionStrength({ selectionStrength: 74.999 }).verdict, "REJECT");
  assert.equal(evaluateSelectionStrength({ selectionStrength: 100 }).verdict, "ADMIT");
  assert.equal(evaluateSelectionStrength({ selectionStrength: 0 }).verdict, "REJECT");
});

test("a MISSING strength is UNEVALUABLE, never a rejection", () => {
  const d = evaluateSelectionStrength({ selectionStrength: null });
  assert.equal(d.verdict, "UNEVALUABLE");
  assert.notEqual(d.verdict, "REJECT");
  assert.match(d.reason, /excluded from both arms/);
});

test("a corrupt score is UNEVALUABLE — bad data must not flatter the filter", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 101]) {
    assert.equal(
      evaluateSelectionStrength({ selectionStrength: bad }).verdict,
      "UNEVALUABLE",
      `${bad} must not be treated as a low score`,
    );
  }
});

test("no decision can authorize anything", () => {
  const d = evaluateSelectionStrength({ selectionStrength: 90 });
  assert.equal(d.productionBehaviorChanged, false);
  assert.equal(d.mode, "SHADOW_ONLY");
  assert.equal(EXPERIMENT_MODE, "SHADOW_ONLY");
});

// ── the freeze ───────────────────────────────────────────────────────────────

test("the rule definition is frozen at its recorded hash", () => {
  const c = checkOwnerSelectionStrengthFrozen();
  assert.equal(c.frozen, true, c.message);
  assert.equal(definitionHash(), OWNER_SELECTION_STRENGTH_GATE_V1_DEFINITION_HASH);
});

test("the hash tracks BEHAVIOUR — it is recomputed from probes, not from source text", () => {
  // Both boundary sides and both invalid tails are probed, so a moved floor or a changed
  // treatment of a missing score cannot survive the hash.
  const h = definitionHash();
  assert.equal(h.length, 32);
  assert.equal(h, definitionHash(), "the hash must be deterministic");
});

test("the experiment is registered without disturbing LHC_SELECT_V1", () => {
  assert.ok(EXPERIMENT_REGISTRY.length >= 2);
  assert.ok(findExperiment("LHC_SELECT_V1"), "V1 of the other experiment must survive registration");
  const e = findExperiment(EXPERIMENT_ID, 1);
  assert.ok(e);
  assert.equal(e.definitionHash, OWNER_SELECTION_STRENGTH_GATE_V1_DEFINITION_HASH);
  assert.equal(e.mode, "SHADOW_ONLY");
});

test("SUBSCRIBER_APPROVED is not a status any experiment can reach", () => {
  assert.ok(!EXPERIMENT_STATUSES.includes("SUBSCRIBER_APPROVED"));
  const text = JSON.stringify(OWNER_SELECTION_STRENGTH_GATE_V1);
  assert.ok(!/SUBSCRIBER_APPROVED/.test(text));
});

test("the frozen record separates the SHA that made the evidence from the SHA that froze the rule", () => {
  assert.equal(OWNER_SELECTION_STRENGTH_GATE_V1.evidenceSha, "0774e62ea821ef4bc9a82482ad4a4e95e856651d");
  assert.notEqual(OWNER_SELECTION_STRENGTH_GATE_V1.creationSha, OWNER_SELECTION_STRENGTH_GATE_V1.evidenceSha);
});

test("the frozen record admits it has no validation block rather than inventing one", () => {
  assert.deepEqual([...OWNER_SELECTION_STRENGTH_GATE_V1.validationSessions], []);
  assert.ok(OWNER_SELECTION_STRENGTH_GATE_V1.robustnessCaveats.some((c) => /IN-SAMPLE/.test(c)));
});

test("prospective evidence starts AFTER every session the rule was read from", () => {
  const dev = [...OWNER_SELECTION_STRENGTH_GATE_V1.developmentSessions].sort();
  assert.ok(
    OWNER_SELECTION_STRENGTH_GATE_V1.prospectiveStartDate > dev[dev.length - 1],
    "an in-sample session must never be able to count as prospective evidence",
  );
});

// ── the arms ─────────────────────────────────────────────────────────────────

test("UNEVALUABLE rows are in NEITHER arm, and are not charged as rejected losses", () => {
  const s = simulate([
    row(90, 50), row(90, -40),           // evaluable, admitted
    row(50, -40),                        // evaluable, rejected
    row(null, -40), row(null, 30),       // unmeasured — the rule cannot judge these
  ]);
  assert.equal(s.coverage.evaluable, 3);
  assert.equal(s.coverage.unevaluable, 2);
  assert.equal(s.baseline.n, 3, "the baseline arm sees only what the rule can decide");
  assert.equal(s.shadow.n, 2);
  assert.equal(s.rejected.n, 1, "the unmeasured loss must not appear as a rejection");
  assert.equal(s.unevaluable.n, 2);
  assert.equal(s.lossesRejected.length, 1);
  assert.equal(s.winnersRejected.length, 0, "the unmeasured winner must not be charged to the rule");
});

test("both arms are measured on the SAME population — never 41 against 67", () => {
  const rows = [row(90, 10), row(90, -10), row(50, -50), row(null, -80)];
  const s = simulate(rows);
  assert.equal(s.baseline.n, s.shadow.n + s.rejected.n);
  assert.equal(s.baselineAllClosed.n, 4, "the all-closed figure is still reported, for context");
  assert.notEqual(s.baseline.n, s.baselineAllClosed.n);
});

test("a mirror on the wrong contract is censored, counted, and never priced", () => {
  const s = simulate([row(90, 500, { occExact: false }), row(90, 10)]);
  assert.equal(s.coverage.censoredNoExactContract, 1);
  assert.equal(s.coverage.exactContractCoverage, 0.5);
  assert.equal(s.shadow.n, 1);
  assert.equal(s.shadow.bestWinnerPct, 10, "a different strike's return is not this decision's return");
});

test("an open trade contributes nothing — it is not a 0% outcome", () => {
  const s = simulate([row(90, null), row(90, 20)]);
  assert.equal(s.coverage.closedCallouts, 1);
  assert.equal(s.shadow.n, 1);
});

test("winners rejected are reported unconditionally, with the trade that was lost", () => {
  const s = simulate([row(60, 120, { symbol: "AAPL" }), row(90, -10)]);
  assert.equal(s.winnersRejected.length, 1);
  assert.equal(s.winnersRejected[0].symbol, "AAPL");
  assert.equal(s.winnerValueForgonePct, 120);
  assert.equal(s.winnerRetentionRate, 0, "the rule kept none of the one winner it could judge");
});

test("tail dependence is exposed: a result carried by one trade says so", () => {
  const s = simulate([row(90, 300), row(90, -20), row(90, -20), row(50, -30)]);
  assert.ok(s.shadow.profitFactor > 1);
  assert.equal(s.shadow.profitFactorExBestWinner, 0, "removing the only winner must collapse it to 0");
  assert.equal(s.shadow.bestWinnerShareOfGains, 1);
});

test("armStats reports a lane with no losses as an undefined profit factor, not infinity", () => {
  const a = armStats([10, 20, 30]);
  assert.equal(a.profitFactor, null);
  assert.equal(a.winners, 3);
});

test("session robustness counts sessions the rule made worse", () => {
  const s = simulate([
    // Session A: the rule drops the loser and keeps the winner.
    row(90, 40, { sessionDate: "2026-08-20" }), row(50, -40, { sessionDate: "2026-08-20" }),
    row(90, -10, { sessionDate: "2026-08-20" }),
    // Session B: the rule drops the WINNER and keeps the loser.
    row(50, 40, { sessionDate: "2026-08-21" }), row(90, -40, { sessionDate: "2026-08-21" }),
    row(90, 5, { sessionDate: "2026-08-21" }),
  ]);
  assert.equal(s.perSession.length, 2);
  assert.equal(s.sessionsWorse, 1, "a session the rule hurt must be counted as hurt");
  assert.equal(s.perSession.find((p) => p.sessionDate === "2026-08-21").winnersRejected, 1);
});

test("composition is reported by strategy and side — a strength floor may be a direction filter", () => {
  const s = simulate([
    row(50, -30, { side: "CALL" }), row(50, -30, { side: "CALL" }), row(90, 20, { side: "PUT" }),
  ]);
  const calls = s.bySide.find((c) => c.key === "CALL");
  assert.equal(calls.rejected, 2);
  assert.equal(calls.shadow, 0);
});

// ── the verdict ──────────────────────────────────────────────────────────────

const gate = (met, n = 30, sessions = 6) => ({
  met, closedOutcomes: n, requiredClosedOutcomes: MIN_CLOSED_PROSPECTIVE_OUTCOMES,
  independentSessions: sessions, requiredIndependentSessions: MIN_INDEPENDENT_SESSIONS,
  shortfall: met ? null : "not enough",
});
const window_ = (sim) => ({ label: "PROSPECTIVE", fromSessionDate: null, toSessionDate: null, closedOutcomes: sim.coverage.evaluable, independentSessions: 6, rejectedSessionDates: [], simulation: sim });

test("a thin sample that looks excellent still reports INSUFFICIENT_EVIDENCE", () => {
  const sim = simulate([row(90, 200), row(50, -50)]);
  const v = deriveVerdict(window_(sim), gate(false, 2, 1));
  assert.equal(v.verdict, "INSUFFICIENT_EVIDENCE");
});

test("the evidence floor is 20 outcomes over 5 independent sessions, unlowered", () => {
  assert.equal(MIN_CLOSED_PROSPECTIVE_OUTCOMES, 20);
  assert.equal(MIN_INDEPENDENT_SESSIONS, 5);
});

test("a shadow arm no better than baseline FAILS — the stated disproof condition", () => {
  // The rule rejects a WINNER and keeps the losers: shadow must not beat baseline.
  const rows = [row(50, 90), row(90, -30), row(90, -30), row(90, 10)];
  const v = deriveVerdict(window_(simulate(rows)), gate(true));
  assert.equal(v.verdict, "FAILED");
  assert.match(v.reason, /disproof/);
});

test("an advantage that vanishes without its best winner is WEAKENING, not PROMISING", () => {
  const rows = [row(90, 400), row(90, -50), row(90, -50), row(50, -55), row(50, -55)];
  const v = deriveVerdict(window_(simulate(rows)), gate(true));
  assert.equal(v.verdict, "WEAKENING");
  assert.match(v.reason, /carried by one trade/);
});

test("a real, tail-independent improvement is PROMISING and says it is not a recommendation", () => {
  const rows = [
    row(90, 40), row(90, 45), row(90, 50), row(90, -20), row(90, -20),
    row(50, -60), row(50, -60), row(50, -60),
  ];
  const v = deriveVerdict(window_(simulate(rows)), gate(true));
  assert.equal(v.verdict, "PROMISING");
  assert.match(v.reason, /not a recommendation/);
});

test("no verdict is ever an approval", () => {
  const rows = [row(90, 40), row(90, 45), row(90, -20), row(50, -60), row(50, -60)];
  for (const met of [true, false]) {
    const v = deriveVerdict(window_(simulate(rows)), gate(met));
    assert.ok(!/APPROV/i.test(v.verdict));
  }
});

// ── authority boundary, enforced against the source ──────────────────────────

test("neither experiment module can write to the database or call a provider", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const f of [
    "lib/research/options/owner-selection-strength-experiment.ts",
    "lib/research/options/owner-selection-strength-scoreboard.ts",
  ]) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), "utf8");
    for (const forbidden of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bfetch\s*\(/]) {
      assert.ok(!forbidden.test(src), `${f} must not contain ${forbidden}`);
    }
  }
});

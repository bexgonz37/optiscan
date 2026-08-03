# AI Learning System

Status: ADVISORY ONLY

## Purpose

Analyze completed evidence and produce research proposals without modifying live trading or alert decisions.

## Safety

- AI cannot override deterministic gates.
- Recommendations remain advisory.
- Research failures cannot block live delivery.

## Deterministic grading now has a real population (2026-08-02)

Every learning claim the radar can make depends on having outcomes for
contracts it did NOT act on. Until 2026-08-02 it did not have them, for two
compounding reasons — both now fixed, and neither of them an AI problem.

**1. The graded population was self-selecting.** The repo believed historical
option quotes were unentitled, so the only marks that existed were forward marks
on captured cases. An "outsized" cohort could therefore never contain anything
the system missed, which makes the one comparison that matters structurally
impossible. A probe disproved the belief: `/v3/quotes/{OCC}` serves historical
NBBO back to at least 2023-07-31. `historical/cohort-builder.ts` now builds
winner and control cohorts from real exact-OCC data.

**2. Forward marks were 0.4% usable.** 2,718 `NO_QUOTE` rejections turned out to
be provider-budget exhaustion misfiled as "this contract had no market". Full
trace in [[High-Asymmetry Radar]].

Rules the learning layer inherits, enforced in code rather than by convention:

- Entry is the **ASK**, marks are the **BID**. Never the midpoint — a midpoint
  fill was available to nobody, and using one inflates every result in the study.
- A contract with no executable quote is **UNGRADEABLE**: never a zero, never a
  loss, never silently dropped. Counting it flat biases every rate to the middle.
- **No winners without controls.** `compareCohorts` returns `null` when no
  control cohort exists, because every feature of a winner is also a feature of
  the many contracts that shared it and went nowhere.
- Below 20 per cohort, every feature difference is labelled descriptive-only.
  No p-value is produced at any sample size.
- Entry and exit instants are **fixed and identical** for every contract, so no
  outcome information can select them.
- A winner the radar missed is classified by CAUSE. `SIBLING_CONTRACT_CAPTURED`
  (right underlying, right side, wrong expiry) is a contract-SELECTION gap and
  argues for nothing about the notification gates; `NEVER_CAPTURED` is a
  detection gap. Collapsing the two is how gates get loosened for no reason.

Threshold changes remain proposals only. `asymmetry_notify_decisions` stores the
gate's inputs beside the thresholds in force, so any candidate value can be
re-run over the real population with no provider call and no production change —
which is how a threshold earns a change, rather than from one memorable example.

No AI participates in capture, grading, paper entry, or any trading decision.

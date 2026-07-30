# Current Task Packet

Task ID: high-asymmetry-replay-blocked-on-data

Worktree: `C:\Users\bexgo\Downloads\optiscan-asymmetry`
Branch: `feature/high-asymmetry-radar`

> This is a **separate Git worktree**. Another session monitors production from
> `optiscan-main`. Nothing here touches that checkout, `main`, or any deploy.

## Where this branch stands

- `58cc4e9` — Phase 1 research foundation.
- This commit — Phase 2 replay apparatus: coverage audit, duplicate-detection
  audit, historical-example import contract, source-priority ranking, read-only
  replay orchestrator, GET-only replay endpoint, offline CLI, 35 more tests.
- Everything remains shadow-only. No live wiring, no Discord, no Twitter, no
  Railway change, no environment variable, **no migration**, no writes.

## The blocking fact

**The replay has not been run against real evidence.** This worktree has no
database: `data/` is empty and there is no `.env.local`. The production
database lives on the Railway volume. Every cohort number is therefore
unmeasured, and no number is reported anywhere in code or docs.

The apparatus is finished and one command away from producing them:

```
node --experimental-strip-types scripts/asymmetry-replay.mjs --db <copy-of-optiscan.db>
```

The file is opened `readonly: true, fileMustExist: true`.

## What was established without data

1. **Outcome marks exist only for paper trades.** `options_paper_marks` is keyed
   by `trade_id`, so a candidate that never became an alert can never be graded.
   The OUTSIZED cohort can currently only contain contracts already alerted on
   — the exact population the radar is meant to be compared against. **This is
   the binding constraint, not any missing feature.**
2. **Premium chase is vacuous under the Phase 1 identity.** The candidate is the
   first observation, so the earliest valid quote is its own and `chasePct` can
   only be 0 or UNKNOWN. Counted as `candidatesWithVacuousPremiumChase`.
3. **A cross-session mark could pass freshness.** Marks were validated against
   their own timestamp, so a next-day quote looked fresh. Caught by a Phase 2
   test and fixed in `outcomes.ts` and `coverage-audit.ts`.
4. **`thesis_fingerprint` is delivery-only.** `loop.ts` never writes it, so the
   fingerprint identity is available only for contracts that reached delivery.

## Next task

1. **Run the replay against a copy of the production database** and read the
   real coverage: how many candidates reach `evidenceComplete`, how many get any
   usable mark, and the exclusion breakdown. Everything below depends on that.
2. Decide from the measured exclusion counts whether the binding constraint is
   what the source audit predicts (missing marks for non-alerted candidates).
3. Only then source new fields, in the ranked order: forward outcome marks
   first, then IV and gamma (already fetched, zero extra API cost), then the
   `/v2/aggs`-derived and backfillable relative-volume family.
4. Do not change the candidate identity until the duplicate audit has run on
   real rows and reported a recommendation other than `INSUFFICIENT_EVIDENCE`.

## Load these notes

- ../02 Components/High-Asymmetry Radar.md
- ../02 Components/safety.md
- ../02 Components/Market Data.md
- ../02 Components/Opportunity Lifecycle.md

## Do not load

- unrelated UI history
- unrelated scripts
- old social recap notes
- full repository history

## Production truth (from `main` — DO NOT overwrite, DO NOT act on here)

Recorded for context only; this branch neither verifies nor changes it.

- Local `main`, `origin/main`, and **deployed production** are all `0be1530`.
  Railway deployment `5682002117` for that exact SHA reached `success`.
- Production health verified: `schemaOk: true`, `schemaMissing: []`,
  `missingLegacyColumns: []`, `lifecycle.active: true`.
- `PROFESSIONAL_WATCHLIST_ENABLED` is **unset**; the endpoint reports
  `enabled: false` and no professional publication has occurred. **No Railway
  variable was changed.**
- The professional Watchlist has only been observed **declining to run**;
  observing the first 18:00 ET planning window is owned by the `optiscan-main`
  session, not by this branch.

## Stop conditions

- do not wire live alerts, Discord publication, Twitter generation, subscriber
  messaging, or automatic contract buying
- do not change a Railway variable or add an environment variable
- do not push, merge, or deploy this branch
- do not access, modify, or switch branches in the `optiscan-main` checkout
- do not tune a threshold, rank candidates, or change the candidate identity
  before the replay has produced measured counts
- do not report a cohort number that no replay produced
- do not let a screenshot or claimed figure become price evidence
- do not claim any candidate will produce a large gain
- research capture must never block scanner, paper linkage, or Discord delivery

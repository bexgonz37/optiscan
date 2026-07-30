# Current Task Packet

Task ID: high-asymmetry-radar-phase-1

Worktree: `C:\Users\bexgo\Downloads\optiscan-asymmetry`
Branch: `feature/high-asymmetry-radar`

> This is a **separate Git worktree**. Another session monitors production from
> `optiscan-main`. Nothing here touches that checkout, `main`, or any deploy.

## Feature-branch state (this branch only)

- Phase 1 of the High-Asymmetry Radar is complete and committed **locally**.
  Not pushed, not merged, not deployed.
- Everything added is shadow-only research infrastructure:
  evidence model, deterministic outcome labels, shadow candidate states,
  premium-chase analysis, cohort comparison, a read-only loader, a token-gated
  GET-only diagnostics endpoint, and 52 focused tests.
- **No production behaviour changed.** No live path imports the new module; the
  scheduler, scanner, delivery, callout, paper, and notification code are
  untouched. No new environment variable, no feature flag, no Railway change.
- Validation on this branch: focused tests 52/52; full suite 2549 pass, 0 fail,
  1 pre-existing skip; `npx tsc --noEmit --incremental false` clean;
  `npm run build` compiled with `/api/research/asymmetry` present;
  `git diff --check` clean.
- See [[../02 Components/High-Asymmetry Radar]] for the full contract.

## What is still unproven on this branch

- **The radar has never run against real data.** Every test uses synthetic
  fixtures. No production or historical cohort has been replayed.
- **No cohort exists, so no comparison means anything yet.** Cohort sizes are
  zero until `options_research_observations` and `options_paper_marks` are
  replayed for real sessions.
- **The largest evidence gaps have no source at all** — stock volume, relative
  volume versus the same time of day, volume acceleration, IV and IV change,
  gamma, relative strength, sector/market alignment, confirmed catalysts,
  compression, and prior underlying move. They are correctly reported as
  missing, but a comparison over mostly-missing features cannot support a
  conclusion. This is why no threshold was tuned.
- Whether `options_research_observations` actually accumulates enough rows per
  session to form cohorts is unmeasured.

## Next task on this branch

1. Replay real sessions read-only through `loadAsymmetryCohortOnDb` and read
   `GET /api/research/asymmetry` for actual coverage numbers — specifically how
   many candidates reach `evidenceComplete` and how many get any usable mark.
2. Decide from measured coverage, not from intuition, which unsourced field is
   worth sourcing first.
3. Only then consider Phase 2. Phase 2 must not begin while every compared
   cohort is under the minimum sample.

## Production truth (from `main` — DO NOT overwrite, DO NOT act on here)

These facts belong to the `main` branch and the deployed production system. They
are recorded for context only; this branch neither verifies nor changes them.

- Local `main`, `origin/main`, and **deployed production** are all `0be1530`.
  Railway deployment `5682002117` for that exact SHA reached `success`.
- Production health verified: `schemaOk: true`, `schemaMissing: []`,
  `missingLegacyColumns: []`, `lifecycle.active: true`.
- All four existing research endpoints respond in production: professional
  Watchlist, earlier-entry, loss-protection, session-audit.
- `PROFESSIONAL_WATCHLIST_ENABLED` is **unset**; the endpoint reports
  `enabled: false` and no professional publication has occurred. **No Railway
  variable was changed.**
- The professional Watchlist has only been observed **declining to run**; its
  build/screen/dedupe/publish behaviour in production remains untested, and the
  observation of the first 18:00 ET planning window is owned by the
  `optiscan-main` session, not by this branch.

## Load these notes

- ../02 Components/High-Asymmetry Radar.md
- ../02 Components/safety.md
- ../02 Components/Market Data.md
- ../02 Components/Opportunity Lifecycle.md
- ../02 Components/watchlist.md

## Do not load

- unrelated UI history
- unrelated scripts
- old social recap notes
- full repository history

## Stop conditions

- do not wire live alerts, Discord publication, Twitter generation, subscriber
  messaging, or automatic contract buying
- do not change a Railway variable or add an environment variable
- do not push, merge, or deploy this branch
- do not access, modify, or switch branches in the `optiscan-main` checkout
- do not tune a threshold from imagined examples or from a cohort under the
  minimum sample
- do not claim any candidate will produce a large gain
- do not stage unrelated untracked files, graphify-out/, or workspace.json
- research capture must never block scanner, paper linkage, or Discord delivery

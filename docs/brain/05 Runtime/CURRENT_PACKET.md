# Current Task Packet

Task ID: push-and-verify-watchlist-stack

## Truthful current state

- Branch `main`. Ten local commits ahead of `origin/main` (`efaf2be`). Nothing
  has been pushed or deployed.
- Parts 1 and 2 (earlier-entry research, loss protection) are COMPLETE as
  shadow research. Do not rebuild them.
- Part 3 professional Watchlist: CORE at `9c2d1c8`, INTEGRATION in the commit
  after it. Scheduler wiring, private Discord publication with copy screening
  and deduplication, premarket evidence gating and plan identity, the trigger
  boundary, and read-only diagnostics are all implemented and tested.
- Gates on this checkpoint: 2500/2500 tests, tsc clean, build clean,
  `git diff --check` clean, migrations additive and repeat-safe.
- `PROFESSIONAL_WATCHLIST_ENABLED` is unset (OFF), so production behaviour is
  unchanged. No new environment variable was introduced.
- **Nothing has been observed end-to-end with live data.** No production
  verification exists for any part of this stack.

## Next task

Push the local stack and verify it on Railway — deployment and observation, not
new features.

Order of work:

1. Push `main` to `origin`. Confirm Railway builds and `/api/healthz` reports
   the new commit with `db=true`, `schemaOk=true`, `schemaMissing=[]`.
2. Verify the deploy is inert: with the flag unset, confirm the scheduler still
   runs the legacy plan and that `GET /api/research/watchlist/professional`
   reports `enabled: false` with no professional runs.
3. Only then, enable `PROFESSIONAL_WATCHLIST_ENABLED=1` (owner decision —
   requires explicit approval, it is a Railway variable change) and watch one
   18:00 ET window. Confirm from diagnostics: rows considered, rows published,
   copy-screen result, dedupe behaviour on the following beat, and that the
   legacy plan still published normally.
4. Then wire live trigger detection into `processWatchlistTrigger`, and add real
   sources for momentum, confirmed catalysts, and premarket levels. Until each
   has a real source it must contribute nothing, never a fabricated name.

## Load these notes

- ../02 Components/safety.md
- ../02 Components/watchlist.md
- ../02 Components/delivery.md
- ../02 Components/deployment.md

## Do not load

- unrelated UI history
- unrelated scripts
- old social recap notes
- full repository history

## Required validation

- focused Watchlist and integration tests
- full test suite
- TypeScript
- production build
- git diff check
- migration repeat-safety
- curated diff review

## Stop conditions

- do not push on failing validation
- do not change a Railway variable without explicit owner approval
- do not stage unrelated untracked files or graphify-out/
- do not alter live formulas, thresholds, stops, targets, or authority
- a Watchlist trigger never delivers on its own
- do not claim production success until Railway is actually verified

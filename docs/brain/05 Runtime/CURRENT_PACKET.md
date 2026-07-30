# Current Task Packet

Task ID: observe-first-watchlist-window

## Truthful current state

- Local `main`, `origin/main`, and **deployed production** are all `0be1530`.
- Railway deployment `5682002117` for that exact SHA reached `success`.
  Confirmed by SHA, not by assuming the newest deployment.
- Production health verified: `schemaOk: true`, `schemaMissing: []`,
  `missingLegacyColumns: []`, `lifecycle.active: true`. No migration failure,
  no startup crash, no secret leakage.
- All four research endpoints respond in production: professional Watchlist,
  earlier-entry, loss-protection, session-audit.
- `PROFESSIONAL_WATCHLIST_ENABLED` is **unset**; the endpoint reports
  `enabled: false` and no professional publication has occurred. **No Railway
  variable was changed.**
- The legacy Watchlist and scheduler paths are intact and running.

## What is still unproven

- The professional Watchlist has only been observed **declining to run**. Its
  build, screen, dedupe, and publish behaviour in production is untested.
- The deploy landed outside every planning window, so no window has elapsed.
- Live trigger detection is not wired; no outcome rows exist.
- Momentum, confirmed-catalyst, and premarket-level sources are still absent.

## Next task

Observe the first real planning window with the flag still OFF, then decide.

1. After the next 18:00 ET window passes, re-read
   `GET /api/research/watchlist/professional`. With the flag off, expect
   `lastOvernightRun` to become a recorded run with `outcome: "DISABLED"` —
   that is the proof the scheduler wiring reaches the professional path at all.
   If it stays null, the wiring is not being reached and must be diagnosed
   before anything is enabled.
2. Confirm in the same window that the legacy plan still published normally.
3. Only then consider enabling `PROFESSIONAL_WATCHLIST_ENABLED=1`. That is a
   **Railway variable change and requires explicit owner approval.** Enable it
   for one window and read back rows considered, rows published, copy-screen
   result, and dedupe behaviour on the following beat.
4. Then wire live trigger detection into `processWatchlistTrigger` and add real
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

## Stop conditions

- do not change a Railway variable without explicit owner approval
- do not enable the feature flag as part of routine verification
- do not stage unrelated untracked files, graphify-out/, or workspace.json
- do not alter live formulas, thresholds, stops, targets, or authority
- a Watchlist trigger never delivers on its own
- do not claim production success without direct evidence

# Current Task Packet

Task ID: decide-professional-watchlist-enablement

## Truthful current state

- Local `main`, `origin/main`, and **deployed production** are all `df9c01c`.
- Railway deployments verified by SHA (not by recency): `5682002117` for
  `0be1530` and `5682083394` for `df9c01c`, both `success`.
- Health: `schemaOk: true`, `schemaMissing: []`, `missingLegacyColumns: []`,
  `lifecycle.active: true`. No migration failure, no startup crash, no secret
  leakage.
- **Scheduler wiring is PROVEN.** In the 18:00 ET window on 2026-07-30 the
  professional job ran at 18:01:10 ET and recorded `outcome: DISABLED`,
  `reason: "PROFESSIONAL_WATCHLIST_ENABLED is not set"`, all counters zero,
  `errors: []`. The path is reached and declines at the flag gate.
- Nothing was published by the professional path: `recentPublications: []`,
  `overnightPlan: null`, no copy-screen or publication failure.
- Legacy plan ran normally in the same window: `overnight-v2-2026-07-30`,
  5 published rows, 64 held, `lastError: null`, and its Discord message
  delivered at 18:01:11 ET.
- `PROFESSIONAL_WATCHLIST_ENABLED` remains unset. **No Railway variable has been
  changed at any point.**

## What is still unproven

- The professional path has never **built or published** in production. Only its
  reachability and its disabled-decline are proven.
- The 08:30 ET premarket window has not been observed; `lastPremarketRun` is
  null.
- Live trigger detection is not wired; no outcome rows exist.
- Momentum, confirmed-catalyst, and premarket-level sources are still absent, so
  even when enabled the overnight plan draws only on the static universe plus
  daily bars.

## Next task — an owner decision, not an engineering step

The verification ladder has one rung left before enablement, and enabling is a
**Railway variable change requiring explicit owner approval.**

1. **Optional, zero-risk:** observe the 08:30 ET premarket window to confirm
   `lastPremarketRun` also records `DISABLED`. This proves the second window is
   wired, symmetrically with the first. Costs nothing but a day.
2. **The enable decision (owner only).** Setting
   `PROFESSIONAL_WATCHLIST_ENABLED=1` turns on a path that will, in the next
   planning window, fetch daily bars and option chains for up to 60 symbols and
   publish a message to the owner/private Watchlist Discord channel. It cannot
   reach subscribers. Before enabling, decide whether the missing momentum /
   catalyst / premarket sources make a static-universe-only plan worth sending.
3. **After enabling, verify in one window:** rows considered, rows published,
   copy-screen result, `payloadHash`, and that a repeat beat reports
   `SUPPRESSED_UNCHANGED`. Confirm the legacy plan still published beside it.
4. Only then wire live trigger detection into `processWatchlistTrigger` and add
   real momentum, catalyst, and premarket sources. Until each has a real source
   it must contribute nothing, never a fabricated name.

## Load these notes

- ../02 Components/safety.md
- ../02 Components/watchlist.md
- ../02 Components/delivery.md
- ../02 Components/deployment.md

## Stop conditions

- do not change a Railway variable without explicit owner approval
- do not enable the feature flag as part of routine verification
- do not stage unrelated untracked files, graphify-out/, or workspace.json
- do not alter live formulas, thresholds, stops, targets, or authority
- a Watchlist trigger never delivers on its own
- do not claim production success without direct evidence
- when computing ET, use Node's ICU — this shell has no tzdata and silently
  ignores `TZ`, returning UTC labelled GMT

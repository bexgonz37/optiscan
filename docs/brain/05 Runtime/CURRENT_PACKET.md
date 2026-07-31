# Current Task Packet

Task ID: high-asymmetry-live-intake

## Active position

- Repo: `C:\Users\bexgo\Downloads\optiscan-asymmetry` (separate worktree)
- Branch: `feature/high-asymmetry-radar`
- Local HEAD: the private-notify commit (this checkpoint)
- `origin/main`: `0b67ba8` — this branch is NOT pushed and NOT merged
- Deployed production commit: `0b67ba8` (served from `optiscan-main`; nothing
  on this branch is deployed)

> Another workstream owns `optiscan-main`. Nothing here touches that checkout,
> `main`, or any deployment.

## Completed this checkpoint

- `lib/research/asymmetry/private-notify.ts` — owner-private notification path,
  code-complete and inert. Five gates: flag, dedicated webhook, subscriber-
  collision refusal, early-states-only, noise control.
- `tests/high-asymmetry-private-notify.test.mjs` — 17 focused tests.

## Verified locally

- Focused: 17/17 pass
- Full suite: **2604/2604** pass, 0 fail, 0 skipped
- `npx tsc --noEmit --incremental false`: clean
- `npm run build`: compiled successfully
- `git diff --check`: clean
- No migration added, no environment variable created

## Verified in production

**Nothing.** This branch is not pushed, not merged, not deployed. The only
production-derived fact below is the replay result, measured from a read-only
snapshot taken by the `optiscan-main` workstream.

## Feature status

| Feature | Status |
| --- | --- |
| Evidence / states / outcomes / cohorts / replay apparatus | RESEARCH_ONLY |
| Replay executed against real production data | LIVE_AND_VERIFIED |
| Owner-private notification path | BUILT_DISABLED |
| Live candidate-stream intake | MISSING |
| Forward outcome tracking (1/3/5/10/15/30/60m) | MISSING |
| End-of-day Quant evidence summary | MISSING |
| Private diagnostics endpoint | MISSING |
| Subscriber SEND authority | MISSING (permanently, by design) |

## What remains unproven

- The private path has never sent a message. It is a formatter with gates; its
  behaviour against a real webhook is untested.
- The radar does not observe live candidates — nothing calls it.
- `options_research_observations` is EMPTY in production (0 rows), so no cohort,
  premium-chase, or outcome number exists. An empty table is absent evidence,
  not a measured result and not strategy performance.

## Replay result (measured 2026-07-30, supersedes "never run")

A consistent read-only snapshot (1,357,881,344 bytes, `integrity_check: ok`,
130 tables) was replayed. Zero gradeable candidates, because the observation
table is empty. Cause verified, not assumed: the writer arrived in `1bde178`,
an ancestor of the deployed commit but NOT of the prior baseline `efaf2be`, and
reached production at 16:41 ET — 41 minutes after the close and 42 minutes
after the last candidate row at 15:59 ET. No options session has run with it
live. Surrounding tables are full by comparison: 145,505 paper marks, 632 paper
trades, 868 options alerts, 35,936 candidates.

## Feature flags

- Disabled: `HIGH_ASYMMETRY_PRIVATE_ENABLED` (unset)
- Unset: `HIGH_ASYMMETRY_PRIVATE_WEBHOOK`

Neither has been created or set. Both are required before the path can emit.

## Known blockers

1. **No owner-private webhook exists.** The path is inert until one is
   provisioned. That is a Railway variable change requiring explicit owner
   approval — deliberately not done.
2. **No captured evidence** until the first options session runs with the
   capture writer live.
3. Outcome marks exist only for contracts that became paper trades
   (`options_paper_marks` is keyed by `trade_id`), so the gradeable population
   is still limited to already-alerted contracts. Unchanged by this checkpoint.

## Exact next bounded checkpoint

Wire live shadow intake: call the radar from the existing candidate stream
AFTER exact-OCC selection and BEFORE subscriber delivery, capturing the evidence
fields already modelled. Persist via the existing additive research table.
Intake must be flag-gated, must not alter any live SEND decision, and a capture
failure must never block the scanner or Discord delivery.

## Stop conditions

- do not push, merge, or deploy this branch
- do not create or set any Railway variable
- do not send a Discord message from this path
- do not promote any threshold into a production gate
- do not access, modify, or switch branches in `optiscan-main`
- do not tune a threshold or change candidate identity before the replay has
  produced measured counts
- do not report a cohort number that no replay produced
- do not describe infrastructure as active behaviour: this is a built, disabled
  path, not a running radar

## Relevant notes

- [[../02 Components/High-Asymmetry Radar]]
- [[../02 Components/safety]]

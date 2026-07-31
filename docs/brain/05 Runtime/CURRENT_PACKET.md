# Current Task Packet

Task ID: high-asymmetry-merge-and-observe

## Active position

- Repo: `C:\Users\bexgo\Downloads\optiscan-asymmetry` (separate worktree)
- Branch: `feature/high-asymmetry-radar`
- Local HEAD: the full-graph commit (this checkpoint)
- `origin/main`: `49b2174` — this branch is NOT pushed and NOT merged
- Deployed production commit: `49b2174` (served from `optiscan-main`; nothing
  on this branch is deployed)

> Another workstream owns `optiscan-main`. Nothing here touches that checkout,
> `main`, or any deployment.

## Completed this checkpoint

- `lib/research/asymmetry/private-notify.ts` — owner-private notification path,
  code-complete and inert. Five gates: flag, dedicated webhook, subscriber-
  collision refusal, early-states-only, noise control. 17 focused tests.
- `lib/research/asymmetry/live-intake.ts` — admission core that admits EARLIER
  and with FEWER hard gates than the subscriber pipeline; incomplete evidence is
  labelled, not rejected. 13 focused tests. **Not wired to anything yet.**

## Verified locally

- Focused: 17 private-notify + 13 live-intake + 17 runtime-edge + 20 graph-acceptance
- Full suite: **2654/2654 green, twice consecutively.** The previously flaky
  timing test passed on both runs; no test was quarantined or weakened.
- `tsc` clean, build clean, `git diff --check` clean, no destructive DDL.
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
| Live intake admission core | BUILT_DISABLED |
| **Live call site in options/loop.ts** | **LOCAL_ONLY** |
| **Shadow-case persistence (5 tables)** | **LOCAL_ONLY** |
| State-transition runner + notifier wiring | MISSING |
| Forward-mark scheduler + runner | MISSING |
| Outcome aggregation | MISSING |
| Forward outcome tracking (1/3/5/10/15/30/60m) | LOCAL_ONLY |
| End-of-day Quant review (scheduled) | LOCAL_ONLY |
| AI advisory on measured results | LOCAL_ONLY |
| Private diagnostics endpoint | LOCAL_ONLY |
| Executed against a live candidate | MISSING |
| Subscriber SEND authority | MISSING (permanently, by design) |

## What remains unproven

- The private path has never sent a message. It is a formatter with gates; its
  behaviour against a real webhook is untested.
- The radar now HAS a production caller, but it is local-only and disabled: it
  has never executed against a live candidate. Zero cases have ever been written.
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

- Disabled: `HIGH_ASYMMETRY_CAPTURE_ENABLED` (unset) — gates capture, marks,
  transitions, and the EOD review. Unset means the whole radar does no work.
- Disabled: `HIGH_ASYMMETRY_PRIVATE_ENABLED` (unset)
- Unset: `HIGH_ASYMMETRY_PRIVATE_WEBHOOK`

None has been created or set. Capture is deliberately separate from
notification: the radar can collect silently without surfacing anything.

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

Merge and deploy DISABLED, then observe. In order:

1. Merge current `main` into this branch, rerun full validation.
2. Merge to `main`, push, deploy with ALL High-Asymmetry variables unset.
3. Verify in production: health green, schema green, normal alerts unaffected,
   `/api/research/asymmetry/live` returns 200 with `enabled: false`, and zero
   private or subscriber messages sent.
4. Only then request approval for the variables below.

The graph is connected but has NEVER RUN against a live candidate. Everything
about its live behaviour is unproven.

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

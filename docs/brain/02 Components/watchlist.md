# Watchlist

Status: professional plan **DEPLOYED_UNPROVEN** (flag off, never built or
published in production) · legacy plan **LIVE_AND_VERIFIED** · next-session
copy **LIVE_AND_VERIFIED** as of `be68a12`

## Copy correctness fix — `be68a12` (2026-07-31)

The 2026-07-30 18:01 ET message published SPCX as a PUT while describing it as
a "0.6% prior-session decline". It had closed **up** 0.61%. The direction was
correct — price 113.09 against VWAP 115.90, i.e. 2.4% below VWAP — but
`plainThesis()` took the bearish branch and discarded the sign with
`Math.abs()`. Any name closing up while below VWAP was described backwards.

Fixed, copy only:

- Wording now follows the **sign of the move**, never the trade direction, and
  the VWAP relationship is stated as its own separate fact. The result explains
  the classification instead of contradicting it: *"rose 0.6% on the session …
  closed 2.4% below prior-session VWAP $115.90"*.
- `"Hold above X and reclaim it"` was self-contradictory. Which instruction
  applies now depends on where price actually closed relative to the level.
- Row restructured so today's evidence and tomorrow's requirement are never in
  one sentence: Today / Why watched / Needs after the open / Invalid if /
  Careful / Catalyst, one disclaimer at the end.
- Invalidation reads as a condition, not an instruction to the reader.

Direction, ranking, selection, the publication gate, and the five-row cap are
untouched; a test asserts each still holds. Rank and lifecycle status were
briefly dropped while restructuring and were restored — neither is internal
vocabulary and neither was in scope to remove.

Verified from a deterministic fixture. **No Discord message was sent.** The
next real send is the 18:00 ET window.

## Purpose

A concise, deterministic daily options plan that names real technical setups and
the exact price levels that decide them, before they move.

## Checkpoints

- `9c2d1c8` — professional Watchlist CORE (setup families, universe, publication
  gate, lifecycle states, trigger lifecycle, outcome tracking, Discord format,
  quant findings, store, bounded runner, read-only API, UI cards).
- This phase — integration: scheduler wiring, private Discord publication with
  copy screening and deduplication, premarket refresh identity and evidence
  gating, the trigger boundary, and read-only diagnostics.

## What this integration phase completed

- **Scheduler.** `overnightResearchJob` now runs two contained steps: the
  legacy alert-derived plan FIRST (renamed `legacyOvernightResearchJob`, body
  unchanged), then `professionalWatchlistJob`. Neither can affect the other —
  the legacy early-returns cannot skip the professional path, and a professional
  fault cannot block or delay the legacy plan. A legacy failure still surfaces
  as the job's failure, preserving existing `runJob` semantics.
- **Windows.** The professional path claims `next_session_watchlist` and
  `premarket_watchlist_update` only. `market_open_revalidation` stays
  legacy-only.
- **Publication.** `professional-publication.ts` is the single path to Discord:
  FLAG → BUILD → SCREEN → DEDUPE → SEND. It never throws.
- **Copy screening.** `screenWatchlistCopy` runs before the send call;
  rejected copy is recorded and never delivered.
- **Deduplication.** Payload-hash log per trading day + phase. Only a `SENT`
  row suppresses, so a failure or rejection never blocks a corrected retry. An
  unreadable log fails CLOSED (skip) rather than risking a double-send.
- **Premarket evidence.** A premarket extreme moves a published trigger only
  with a named source and a past, fresh (≤30 min) observation time. Unsourced,
  undated, future-dated, and stale extremes leave the daily level standing and
  are reported in `diagnostics.premarketEvidenceExcluded`. Freshness anchors to
  the observation time, never to `now`.
- **Plan identity.** A premarket update carries `derivedFromPlanVersion` naming
  the overnight plan it refreshes, or null when there is none — never invented.
- **Trigger boundary.** `trigger-integration.ts` evaluates a crossing, records
  the research outcome, and returns a HANDOFF. It imports nothing from delivery,
  notifications, callouts, scanner, paper, or bearish modules and contains no
  send call — both enforced by test. A trigger cannot create a subscriber alert.
- **Diagnostics.** `GET /api/research/watchlist/professional` exposes the last
  overnight and premarket runs, rows considered/published/withheld/rejected,
  duplicate suppression, publication outcome, failure reason, and flag state.
  No webhook, token, URL, or raw Discord config is exposed.

## Production verification (2026-07-30, deployed commit `df9c01c`)

### Scheduler wiring PROVEN in the first 18:00 ET window

The 18:00–18:10 ET `next_session_watchlist` window on 2026-07-30 was observed
live. `professionalWatchlistJob` **was reached** and recorded:

```
ranAtMs   1785448870183  (= 18:01:10 ET)
phase     OVERNIGHT_PLAN
outcome   DISABLED
reason    PROFESSIONAL_WATCHLIST_ENABLED is not set
flagEnabled false
rowsConsidered 0 · rowsPublished 0 · rowsWithheld 0
rowsRejectedByCopyScreen 0 · copyViolations []
duplicateSuppressed false · payloadHash null · errors []
```

This is the evidence the previous checkpoint was missing: the scheduler really
does reach the professional path, and with the flag off it declines at the flag
gate before any build, provider call, screen, dedupe, or send.

`schedulerRuns` advanced 1 → 15 over ~70 minutes (~5.2 min/run), matching the
5-minute `overnightResearchMs` cadence against a 10-minute window.

### Nothing was published by the professional path

- `recentPublications: []` — a professional send always writes a `SENT` row with
  a payload hash and message id. None exists.
- `overnightPlan: null` — the runner persists a plan *before* publishing, so no
  professional plan was even built.
- No copy-screen failure and no publication failure occurred
  (`rowsRejectedByCopyScreen: 0`, `copyViolations: []`, `errors: []`).

### Legacy plan ran normally in the same window

- `planVersion: overnight-v2-2026-07-30`, **5 published rows**, 64 held as
  `needsMoreData`, `runs: 8`, `lastError: null`.
- A legacy Watchlist Discord message was delivered at 18:01:11 ET to the
  Watchlist webhook (`sent24h: 3`, `failed24h: 0`, `suppressed24h: 0`).
  Attribution is unambiguous: both paths share that webhook, but the
  professional publication log is empty and no professional plan was built, so
  the send can only have come from the legacy job.
- Note: the legacy plan now publishes rows again. The long-standing
  "0 qualified rows / VWAP blocker" state recorded in older notes has cleared.

### Other checks

- `enabled: false`; **no Railway variable was changed** (no CLI, no token, no
  mechanism available or used).
- `outcomes` reports a zero cohort with `isSubscriberPerformance: false`.
- `safety` renders `advisoryOnly: true`, `productionBehaviorChanged: false`.
- 0 credential-pattern hits across every response checked.

## Truthful remaining limitations

- **The professional path has still never BUILT or PUBLISHED in production.** It
  has been proven reachable and proven to decline while disabled. Its live
  behaviour with the flag ON — universe fetch, provider budget, setup detection,
  copy screening, dedupe, and the actual send — remains entirely unproven.
- **The premarket window has not been observed.** `lastPremarketRun` is still
  null; the 08:30 ET window has not occurred since deploy.
- **Live trigger detection is not wired.** `processWatchlistTrigger` exists and
  is tested, but no live price feed calls it yet, so no outcome rows are
  produced in production.
- **Momentum, confirmed catalysts, and premarket levels have no live source.**
  `liveProfessionalWatchlistDeps` deliberately omits them; until each has a real
  source it contributes nothing rather than a fabricated name. In practice the
  overnight plan currently draws only on the static universe plus daily bars.
- **Daily-bar mapping is UTC-date based** in the live deps, which is adequate
  for daily aggregates but has not been validated against a DST boundary.
- The legacy alert-derived plan still publishes independently; the two are not
  reconciled and may both post when both are enabled.

## Feature-flag state

`PROFESSIONAL_WATCHLIST_ENABLED` — **unset (OFF)**. Only the literal `"1"`
enables it. While unset there is no build, no provider call, no write, and no
send. Publication additionally requires the already-provisioned
`OWNER_RESEARCH_DISCORD_ENABLED=1` and the existing watchlist webhook; this
phase introduced **no new environment variable** and needs no Railway change.

## Safety

Research only. Cannot send a subscriber alert, select a contract, or change
scanner, authority, delivery, or paper behaviour. Watchlist outcomes are never
subscriber results without a verified canonical SEND with exact-OCC evidence.

# Watchlist

Status: CORE + INTEGRATION COMPLETE LOCALLY — FLAG OFF, NOT DEPLOYED

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

## Truthful remaining limitations

- **Never observed end-to-end with live data.** Every result above is from
  tests and local builds. Nothing has been deployed or verified on Railway.
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

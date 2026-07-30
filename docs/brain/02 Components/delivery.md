# Delivery

Status: LIVE DETERMINISTIC PATH

## Purpose

Handles options callout formatting, delivery decisions, Discord delivery,
deduplication, and paper linkage.

## Publication boundary

There are two distinct outbound paths, and they must not be confused.

**1. Canonical subscriber SEND path** — the only path that may deliver a
tradable options alert. It owns bearish-gate authority, exact-OCC contract
selection, frozen entries/stops/targets, deduplication, paper linkage, and
subscriber-result attribution. Unchanged by the Watchlist work.

**2. Owner/private research publication** — `sendOwnerResearchNotify` to the
`watchlist` destination, gated by `OWNER_RESEARCH_DISCORD_ENABLED=1`. The
professional Watchlist publishes here and ONLY here, under kinds
`next_session_watchlist` and `premarket_watchlist_update`. It never routes to
the subscriber `options` webhook (asserted by test).

### Watchlist → delivery rules

- A Watchlist TRIGGER IS NOT TRADE READY. It is an OFFER.
- A triggered row reaches subscribers only by passing the seven revalidation
  checks and then the canonical SEND path, which may still reject it.
- `lib/research/watchlist/trigger-integration.ts` imports no delivery,
  notification, callout, scanner, paper, or bearish module and contains no send
  call. Enforced by test — a trigger structurally cannot deliver.
- Every professional Watchlist message passes `screenWatchlistCopy` before the
  send call. Rejected copy is recorded and never delivered.
- Publication is deduplicated by payload hash per trading day and phase. Only a
  `SENT` row suppresses a repeat; a failure or rejection never blocks a retry.
- No overnight or premarket message may contain an exact OCC contract.

## Safety

Research capture and Watchlist publication failures must never block Discord
delivery or paper linkage. The professional publication path never throws: every
failure is returned as a result and recorded in scheduler diagnostics.

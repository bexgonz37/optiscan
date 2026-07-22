# OPTIONS_SESSION_AUTOMATION

How the options scanner decides *when* and *how fast* to run — automatically, with no command at the
open. Source of truth: `lib/trading-session.ts` (`marketSession`, `isMarketHoliday`) and the session
cadence in `lib/research/options/monitor.ts`.

## Session detection (automatic)

`marketSession(nowMs)` returns one of `premarket | regular | afterhours | closed` in **ET**:

- **Weekends** (Sat/Sun) → `closed`.
- **Full-day exchange holidays** → `closed`. Baked-in NYSE/Nasdaq closures, extendable without a deploy
  via `MARKET_HOLIDAYS=YYYY-MM-DD,YYYY-MM-DD`.
- **04:00–09:30 ET** → `premarket`; **09:30–16:00 ET** → `regular`; **16:00–20:00 ET** → `afterhours`;
  otherwise `closed`.
- Listed-options regular hours = the `regular` equity session (`marketOpenForOptions`).

## Cadence (automatic, per session)

`sessionCadence()` picks the interval by tier + session (all env-overridable):

| | Tier 1 | Tier 2 |
|---|---|---|
| regular | `OPTIONS_TIER1_INTERVAL_MS` (15 s) | `OPTIONS_TIER2_INTERVAL_MS` (60 s) |
| premarket | `OPTIONS_TIER1_PREMARKET_MS` (30 s) | `OPTIONS_TIER2_PREMARKET_MS` (120 s) |
| afterhours | `OPTIONS_TIER1_AFTERHOURS_MS` (30 s) | `OPTIONS_TIER2_AFTERHOURS_MS` (120 s) |

## Stale option quotes outside options hours

Outside `regular`, listed-option quotes and 1-minute bars are stale/absent. Stage-1.5 detects this
(`f.stale`) and **rejects safely** before any chain fetch, incrementing `stage15Stale`. This is why a
closed-market cycle yields 0 candidates and empty feature distributions — expected, not a bug (see the
Tier-1 diagnostic and `OPTIONS_RECOVERY_RUNBOOK.md`).

## Premarket / after-hours forming setups

The monitor still runs in `premarket`/`afterhours` (slower cadence) so underlying momentum can be
observed. Because listed-option paper requires a real two-sided quote, a **real-option paper entry only
opens in the `regular` session** (`loop.ts` guards `input.session === "regular"`). A setup seen forming
premarket is simply re-scanned each cycle; when the market opens and fresh option quotes arrive, the next
regular-session cycle evaluates it and can open paper — **no command at the open**.

## Automatic re-evaluation at the open

There is no pending-queue to drain manually. The monitor re-scans Tier-1/Tier-2 every cadence; the moment
bars/quotes become fresh (`f.stale` flips false), evaluation resumes and distributions populate. The
grader independently refreshes quotes for any still-open position. Test `3.` proves the stale→fresh
transition changes evaluation with no intervention; test `4.` proves weekend/holiday sessions are a safe
no-candidate no-op.

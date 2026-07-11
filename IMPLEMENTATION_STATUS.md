# OptiScan — Implementation Status

_Last updated: 2026-07-10. Working repo: `~/Downloads/optiscan-main`, branch `main`._

This file is the resume point. Read it + the task list before making changes.
Do **not** repeat Phase 1, redo timestamp normalization, re-enable bearish
actionable alerts (`BEARISH_ACTIONABLE` stays off), or add the Self-Improvement
Lab / an embedded LLM.

## Verification baseline (green)

| Check | Result |
|---|---|
| `npm test` | **423 pass**, 0 fail, 0 skip (385 baseline + 38 new) |
| `npx tsc --noEmit` | clean |
| `npm run build` | compiles, 20/20 static pages |

## Preserved Phase-1 guarantees (unchanged)

Central timestamp normalization (`lib/timestamps.ts`), ns/µs/ms/s handling,
`Invalid time value` fix, session-aware freshness thresholds
(`FRESHNESS_EXTENDED_MULTIPLIER`), provider health independent of stale symbols,
stale data blocks actionable alerts/paper entries, bearish actionable callouts
disabled by default (`lib/bearish-gate.ts`), all provider calls via metered
`polyFetch`, lib→lib relative `.ts` imports.

## Phase status

- **Phase 1 — Stabilization**: ✅ committed (`87e11f5`).
- **Phase 2 — Market Data Health UX**: ✅ DONE.
  - `app/data/page.tsx` rewritten: status bar (session, provider, scanner,
    freshness, Discord, database), provider-connection card kept **separate**
    from per-symbol staleness, per-kind freshness table with real max ages,
    human-readable "why blocked" reasons, rate-limit + coverage, DB health,
    raw JSON behind an on-demand disclosure (never shown by default).
  - `GET /api/system/overview` — one read-only aggregate (no provider calls).
  - `lib/data-freshness.ts` — added `describeBlockingSample`,
    `describeSymbolActionability`, `kindLabel`, `sessionLabel`. Thresholds come
    from `maxAgeSecondsFor(kind, session)` — never duplicated in UI.
- **Phase 3 — Discord Delivery UI**: ✅ DONE (built alongside Phase 2).
  - `components/DiscordDeliveryPanel.tsx` — ledger table (status, alert id,
    ticker, setup, channel, created/sent, retries, failure reason), retry +
    test buttons, recent successes/failures. Recap shows **NOT CONFIGURED**
    without counting as a failure. No webhook URLs/secrets in the frontend.
  - `lib/alert-store.ts` `listDiscordDeliveries` now LEFT JOINs `alerts` for
    ticker/setup. Uses existing `/api/discord/*` routes.
- **Phase 4 — Shared Layout System**: ✅ DONE.
  - `components/ui/Shell.tsx` (PageContainer, PageHeader, ResponsiveGrid, Card,
    StatusBadge, LoadingState, EmptyState — always explains _why_ — ErrorState,
    KeyValue, DetailsDisclosure) + `components/ui/Table.tsx` (SimpleTable,
    internal x-scroll, empty-state fallback).
  - `app/shared-ui.css` — one shared stylesheet (imported in `app/layout.tsx`),
    reuses existing tokens; no fixed-height blanks, no absolute layout, wide
    content scrolls internally, reduced-motion aware.
  - **Import note:** `@/components/ui` resolves to the legacy file
    `components/ui.tsx`, NOT the `ui/index.ts` barrel. Import new primitives by
    direct path: `@/components/ui/Shell`, `@/components/ui/Table`.
- **Opportunity lifecycle persistence**: ✅ core DONE (feeds Phase 6).
  - `lib/opportunity-lifecycle.ts` — pure states/transitions/hysteresis/stable
    ordering (10 states, runtime-tested).
  - `lib/opportunity-store.ts` — SQLite persistence (`opportunities` table in
    `lib/db.ts`), upsert-by-`(ticker,setup_type,trading_day)`.
  - `lib/opportunity-map.ts` — tape→signal mapping; bearish demoted to
    research-only unless `BEARISH_ACTIONABLE=1`.
  - Scanner tick ingests top movers (throttled `OPP_INGEST_MS`, disable via
    `OPPORTUNITY_TRACKING=0`). `GET /api/opportunities` returns grouped buckets.

- **Phase 5 — Simplified Navigation**: ✅ DONE.
  - `components/AxiomShell.tsx` NavRail = the target 8 primary items
    (Command Center, Options Callouts, Watchlist, Paper Trading, Performance,
    Research & Backtesting, System Health, Settings) + TOOLS (Swing Research,
    Guide). `/quant` relabelled "Research & Backtesting".
  - New `app/watchlist/page.tsx` (monitored symbols / live tape, read-only over
    `/api/scanner/live`) and `app/performance/page.tsx` (alert stats +
    `/api/paper/trades`, live outcomes only, no fabricated history).
  - `/stocks` now redirects to `/watchlist`; `/now`, `/scanner`, `/review`
    redirects preserved — no dead links.

- **Phase 6 — Command Center**: ✅ DONE.
  - `components/CommandCenter.tsx` is the new home (`app/page.tsx`): status bar
    (session, provider, freshness, scanner, Discord, paper) + calm sections —
    Actionable Now, Near Trigger, Developing Setups, Open Paper Trades, Extended
    or Invalidated, Recent Alerts. Reads persisted `/api/opportunities` buckets
    (stable, hysteresis-smoothed order — no per-tick re-ranking, no animation);
    every empty section explains why. Read-only (no trading/provider calls).
  - The full live scanner is **preserved** at `/scanner` (was the old home);
    `/now` redirects there. Shell full-bleed "live" chrome now keys on
    `/scanner`, so `/` uses the standard calm page header.
  - Duplicate page `<PageHeader>`s removed from System Health / Watchlist /
    Performance — the shell's `pgtop` is the single page-title source.

## Verification (Phase 7) — DONE

- Full suite, `tsc`, and production build all green (table above).
- Drove the production server (`npm run start`, scanner disabled for a stable
  UI) and screenshotted Command Center, System Health, Watchlist, and
  Performance at 1440/1024 — all render correctly (target 8-item nav, status
  bars, calm sections, human-readable blocking reasons, live-data track record).
- The browser window is clamped to ~1528px in this environment, so true
  768/390 screenshots aren't possible via resize. Instead verified responsiveness
  programmatically: constrained each page's content column to 390/768/1024 and
  measured overflow — **0px page-level horizontal overflow on all four primary
  pages at every width**. The only wide element is `.ui-table-scroll`, which
  scrolls internally by design (page body never scrolls horizontally).

## Later phases (explicitly out of scope now)

Centralized contract selection · bearish-strategy rebuild · paper-trading
rebuild · historical-data adapter · statistical prediction models ·
Self-Improvement Lab · optional embedded LLM.

## New tests

`tests/opportunity-lifecycle.test.mjs` (14), `tests/opportunity-persistence.test.mjs`
(6), `tests/system-health.test.mjs` (9), `tests/navigation.test.mjs` (4),
`tests/command-center.test.mjs` (5).

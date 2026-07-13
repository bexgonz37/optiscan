# OptiScan — Implementation Status

_Last updated: 2026-07-10. Working repo: `~/Downloads/optiscan-main`, branch `main`._

This file is the resume point. Read it + the task list before making changes.
Do **not** repeat Phase 1, redo timestamp normalization, re-enable bearish
actionable alerts (`BEARISH_ACTIONABLE` stays off), or add the Self-Improvement
Lab / an embedded LLM.

## Verification baseline (green)

| Check | Result |
|---|---|
| `npm test` | **707 pass**, 0 fail (547 + 38+20+15+33+20 P1–P5 + 15 P6 + 19 P7) |
| `npx tsc --noEmit` | clean |
| `npm run build` | compiles, all static pages |

_(Earlier revisions of this file undercounted tests; the true baseline before
setup-fingerprinting was 547.)_

## Quant roadmap progress + RESUME POINT

Autonomous quant-roadmap execution (commit each phase green + pushed to `main`):

| Phase | Status | Commit |
|---|---|---|
| P1 — Setup fingerprinting + authoritative outcomes | ✅ pushed | `4cb1dc6` |
| P2 — Trustworthy statistics + evidence engine | ✅ pushed | `9a4fd2c` |
| P3 — Market context + regime foundation | ✅ pushed | `e172640` |
| P4 — Validated probability-model foundation (inactive: no data) | ✅ pushed | `96df168` |
| P5 — Modular specialized strategy agents | ✅ pushed | `29a86d6` |
| P6 — Advanced options callouts (desktop + Discord) | ✅ pushed | `616f16a` |
| P7 — Controlled continuous learning + drift | ✅ pushed | `3c7b890` |
| P8 — Live experimental probability mode | ✅ pushed | `f8409b8` |
| P9 — Controlled code-improvement agent | ✅ pushed | (this commit) |

**ROADMAP COMPLETE (P1–P9).** `main` clean, 745 tests green, tsc clean, build
green. Reusable substrate in place: `contract-selector`,
`data-freshness`, `trade-explanation`/`paper-explain`, `paper-engine`,
`setup-fingerprint` + `outcome-store`, `setup-statistics` + `statistics-store`
(evidence engine), `market-context` (+ store), `model-registry` (probability,
currently `INACTIVE_INSUFFICIENT_DATA`), `bearish-gate`, `paper-risk`,
`paper-capital`, `opportunity-lifecycle`. P5 should define ONE shared normalized
agent-result interface + a deterministic runtime, wrap these services (do NOT
duplicate them), implement the bullish/put-research horizon agents (0DTE, 1–5,
6–10, 11–35, 36–90 + momentum stock; puts RESEARCH_ONLY), shared service agents
(market-data, context, contract-selection, risk-veto, execution, performance,
missed-opportunity, research/learning, explanation), and a Supervisor/Orchestrator
that dedups, resolves overlapping horizons, applies risk vetoes + lifecycle
hysteresis, and ranks the best candidate per ticker/horizon/direction. Risk +
hard gates always outrank agent agreement.

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

## Centralized Options Contract Selection — DONE (2 commits)

**Commit A — `lib/contract-selector.ts` + `tests/contract-selector.test.mjs`.**
One pure, deterministic selection service. Configurable strategy profiles
(`zero_dte_momentum`, `swing_position`, `near_money_context`). Structured
success/rejection results (`RejectionCode` + `blockedByGate` counts + human
reason). Stable `optionSymbol` tie-break. Session-aware chain staleness
(`maxAgeSecondsFor("options_chain", session)`) **and** per-contract staleness —
a fresh chain never rescues an individually stale contract. Liquidity / spread /
delta / DTE / price / mid gates. No fabricated data; no silent illiquid fallback.
Legacy selectors (`rankZeroDteContracts`, `contractEntryGate`, `nearTheMoneyPair`,
`pickSwingContract`) are thin wrappers delegating here; `SWING_*` thresholds have
one source.

**Commit B — call-site migration.**
- `lib/position-callout.ts` → full adoption of `selectContract("swing_position")`
  with structured rejection logging.
- `app/api/options/[ticker]/route.ts` → additive centralized `selection` verdict
  per side (research display; puts surfaced but never actionable).
- `lib/scanner-loop.ts`, `lib/alert-capture.ts`, `lib/swing-score.ts`,
  `lib/zero-dte-context.ts` → their ranking/gate now routes through the one
  central implementation via the Commit-A delegation (behavior preserved; the
  delicate capture/emission tiering is intentionally unchanged).

**Bearish safety (unchanged authority):** the selector may select/score/display a
put for research but **never** marks it `actionable`. `BEARISH_ACTIONABLE` stays
off, and `lib/bearish-gate.ts` (`gateBearishAction`) remains the final authority
for any bearish actionability downstream. No env override enables bearish here.

**Selection vs. actionability** are distinct: "best available research contract"
(may fail gates → `researchOnly`) vs. "safe + actionable" (passes all gates,
non-put, actionable session).

**Paper trading** still inherits the alert-time contract (unchanged this phase).
**TODO (paper-trading rebuild):** revalidate the contract through
`selectContract` immediately before entry (freshness/spread can drift between
alert and fill) — belongs to that phase, not here.

## Desktop + Discord Trade Explainability — DONE (5 commits)

One shared, deterministic explanation object drives both the desktop dashboard
(Simple/Advanced) and Discord. No LLM, no fabricated data, no DB migration —
explanations are derived at read/render time from already-verified fields.

**A — `lib/trade-explanation.ts` + tests.** The ONE pure builder
(`buildTradeExplanation`): `plainSummary`, `whyNow`, `contractSummary`,
`riskSummary`, `selectedBecause`, `rejectedBecause`, `wouldImproveIf`,
`invalidatedIf`, `supportingMetrics`, `glossaryTerms`, `evidenceStatus`,
`evidenceSummary`, `actionabilityStatus`, `advanced{}`. No DB, no provider I/O,
no `@/`, no wall-clock in output. A put/bearish idea can NEVER be `ACTIONABLE`
(display guard on top of the selector + `lib/bearish-gate.ts`); evidence gating
surfaces numeric win rate/expectancy only for an ESTABLISHED (strong) sample.

**B — `lib/explanation-adapters.ts` + additive API wiring.** Impure gathering
(`explanationForSelection` / `explanationForOpportunity` / `explanationForAlert`,
the alert adapter tolerating both DB-row and notify shapes). Read-only evidence
lookup of `setup_statistics` (never recomputed). `GET /api/opportunities`,
`/api/options/:ticker`, and `/api/alerts` each attach `explanation` additively.

**C — Desktop Simple/Advanced.** `hooks/usePresentationMode.ts` (localStorage,
default **simple**, persists across pages) + `components/TradeExplanationCard.tsx`
(the one renderer; Advanced is additive — expandable raw-metrics disclosure with
glossary InfoTips). Command Center toolbar toggle + opportunity cards; ChartPanel
reality-check surfaces the same per-side selection explanation. Both modes render
the EXACT SAME object — the mode only selects which fields show.

**D — One combined Discord alert.** `formatExplanationDiscord` merges the
explanation body into the existing BUY embed, preserving color/author/footer/
timestamp, role-mention content, and structured metric fields; adds a compact
`Advanced` line + a `Status` field. `notifyNewAlert` merges into the SINGLE
payload — freshness gate, ledger states, language guard, dedup window, and the
`${alertId}:${webhook}:buy` idempotency key are all unchanged (exactly one send).

**Bearish safety (unchanged):** `BEARISH_ACTIONABLE` stays off; the explanation
layer describes puts/research only and never authorizes a bearish actionable
alert. `lib/bearish-gate.ts` remains the final authority.

**Deferred to the paper-trading rebuild:** pre-entry contract revalidation
through `selectContract` immediately before a fill — the explanation may describe
the alert-time contract but never claims it is still tradable (a note flags
possible drift). No paper-trading logic was changed this phase.

**Deferred to setup-fingerprinting / statistical outcome tracking:** real
`evidenceStatus` beyond `NOT_TRACKED` for opportunities, and comparable
per-fingerprint win rate / expectancy / profit factor. This phase only surfaces
already-valid `setup_statistics`, gated so weak samples are never shown as proof.

**New tests:** `tests/trade-explanation.test.mjs` (19),
`tests/explanation-adapters.test.mjs` (9), `tests/presentation-mode.test.mjs` (5),
`tests/explanation-discord.test.mjs` (6).

## Paper-Trading Rebuild with Pre-Entry Revalidation — DONE (5 commits)

Realistic, auditable paper fills on top of the centralized selector +
explanation layer. Additive DB migration only (column-existence-guarded
`ALTER TABLE ADD COLUMN` + `CREATE TABLE/INDEX IF NOT EXISTS`, repeat-safe);
legacy `status` stays authoritative and every historical row remains readable
through one derived mapping.

**1 — Shared execution + event infrastructure.** `lib/paper-fill-model.ts`
(conservative, deterministic fills: long entries at ask + bounded slippage capped
at the limit — never the mid; exits at bid − slippage; reject one-sided / crossed
/ stale / wide-spread / missing quotes; partials structurally supported but
disabled). `lib/paper-capital.ts` (buying-power reservation, max position $, max
concurrent, duplicate-contract exposure, per-strategy daily cap).
`lib/paper-events.ts` (21 typed lifecycle events with deterministic idempotency
keys `pe:{tradeId}:{eventType}:{disc}`, `INSERT OR IGNORE`). Derived
`ORDER_STATES` / `POSITION_STATES` alongside legacy `status`. New `paper_events`
table + additive `paper_trades` columns (states, strategy, gates, immutable
alert-time + pre-entry snapshots, drift, fill assumptions, fees/slippage).

**2 — Pre-entry revalidation (no substitution).** `lib/paper-revalidation.ts`
re-checks the SPECIFIC alert-time contract against a fresh chain by running it
back through the ONE `selectContract` as a single-contract pool (spread /
liquidity / delta / DTE / freshness / bearish policy reused, never duplicated).
`revalidatedContract` is ALWAYS the alert-time symbol or `null` — a vanished /
identity-changed / out-of-profile / stale contract rejects the entry and
preserves the original; it never selects a different contract. Substitution is
explicitly deferred.

**3 — Options paper-trading rebuild.** `lib/paper-entry.ts` +
`lib/paper-explain.ts` (pure) wired into `lib/paper-engine.ts`: explicit
candidate → validation → pending → fill → open → exit. Entry revalidates then
fills only from the conservative model, persisting the immutable pre-entry
snapshot + drift + fees/slippage/assumptions. A stale/missing mark keeps the
position OPEN (typed event, no fabricated exit, no terminal ERROR for a
temporary quote gap). Exits settle at intrinsic value (expiry) or bid − slippage;
an unfillable exit quote keeps the position open. Deterministic explanation reuses
`rejectionToPlain`.

**4 — Momentum-stock rebuild (verified fills, long only).**
`lib/paper-stock.ts` (pure) replaces instant tape-price entries with the same
verified-quote model. Real NBBO is plumbed additively through
`parseSnapshotTickers` + the scanner tape (zero extra API calls). Decision 8: the
rebuilt path NEVER opens a short/bearish stock paper position while bearish
actionability is disabled — long only. Decision 7: extended-hours entries only
when explicitly permitted (`PAPER_STOCK_EXTENDED_HOURS=1`) AND a fresh valid
two-sided quote fills through the extended-slippage rules; the tape price is never
a guaranteed fill. Capital gate + typed events + immutable snapshots throughout.

**5 — API / dashboard / docs.** `GET /api/paper/trades` exposes per-trade
`orderState` / `positionState`, strategy, gates, entry/exit costs, immutable
alert-time + pre-entry snapshots, drift, fill assumptions, and a deterministic
`explanation`; adds a recent `events` feed and `?tradeId=` per-trade event log.
The desktop paper page surfaces the states, revalidation/drift, fill costs, close
reason, and a lifecycle-events panel (no unrelated redesign). No Discord
paper-trade alerts this phase.

**Bearish safety (unchanged):** `BEARISH_ACTIONABLE` stays off; puts may be
selected / researched / explained / displayed but never create an actionable
bearish paper trade, and no short stock paper entry is created through the
rebuilt path. `lib/bearish-gate.ts` remains the final authority — no test / env /
hidden override.

**Deferred (explicitly not started this phase):** contract SUBSTITUTION on
revalidation failure · Discord paper-trade alerts · setup fingerprinting ·
statistical calculations / expectancy / prediction models · specialized agents ·
Self-Improvement Lab · embedded LLM · live-broker / real-money execution ·
partial fills (no verified market depth).

**New tests:** `tests/paper-fill-model.test.mjs` (13),
`tests/paper-capital.test.mjs` (8), `tests/paper-events.test.mjs` (8),
`tests/paper-revalidation.test.mjs` (11), `tests/paper-entry.test.mjs` (15),
`tests/paper-stock.test.mjs` (14).

## Setup Fingerprinting + Authoritative Outcomes — DONE (Phase 1 of the quant roadmap)

Deterministic, versioned setup fingerprints + a fee-aware authoritative outcome
layer. Additive migration only (new tables + guarded `paper_trades` columns).
The legacy `quant.ts` gross-P&L `trade_outcomes`/`setup_statistics` layer is left
operational and untouched (reconciliation deferred to the statistics phase).

**Pure — `lib/setup-fingerprint.ts` (+16 tests).** `buildFingerprint` produces a
stable `sf{version}_{16hex}` id from a FIXED, SORTED dimension set, hashing only
bucket labels (never raw floats). `FINGERPRINT_VERSION=1` is baked into the
canonical payload AND the id. Casing-normalized, NaN/Infinity→NA with
`dataQualityReasons`, deterministic across property order / restarts / processes.
Look-ahead safe by construction: the input type only exposes entry-time fields —
exit price/reason/P&L/MFE/MAE/future timestamps have no channel in. Stores both
the opaque id and the sorted human-readable canonical dimensions. `strategyVersion`
is a case-insensitive registry dimension so a strategy-meaning change is distinct.

**Pure — `lib/trade-outcome.ts` (+13 tests).** `gradeOutcome` grades WIN / LOSS /
BREAKEVEN / UNGRADABLE on NET realized P&L after fees. Slippage is already embedded
in the fill price and is NOT double-counted (net = gross − fees). A positive gross
that goes negative net is a LOSS. Deterministic configurable breakeven tolerance
(`OUTCOME_BREAKEVEN_TOLERANCE_DOLLARS`, default $0.50). Missing entry/exit/qty/times
→ one UNGRADABLE record with structured reasons (never dropped). R-multiple uses
the immutable `risk_amount`. `terminalKind` maps status→STOP/TARGET/…

**Impure — `lib/outcome-store.ts` (+`outcome-store.test.mjs`, real-DB functional).**
`freezeFingerprintOnDb` writes the fingerprint ONCE (COALESCE guard) + upserts
`setup_fingerprints` (INSERT OR IGNORE). `generateOutcomeOnDb`/`syncOutcomesOnDb`
create exactly one `paper_trade_outcomes` row per FILLED+TERMINAL trade
(UNIQUE(paper_trade_id) + existence check) — restart/re-sweep idempotent. Only
filled trades are graded; rejected/failed-reval/unfilled/cancelled/bearish-research
never reach the gate. `nbboDiagnostic()` is read-only count reporting. DB core is
handle-injectable so it is unit-tested against real better-sqlite3.

**DB (`lib/db.ts`).** New `setup_fingerprints`, `paper_trade_outcomes`
(CREATE IF NOT EXISTS); guarded `paper_trades` ALTERs: `fingerprint_id`,
`fingerprint_version`, `fingerprint_dimensions_json`, `strategy_version`. Additive,
repeat-safe, backward compatible. Legacy `trade_outcomes` untouched.

**Wiring.** `paper-engine.ts` freezes the fingerprint at the actual option AND stock
fill, and runs `syncPaperOutcomes` idempotently each sweep; `listPaperTrades` and
`/api/paper/trades` expose per-trade `fingerprintId`/`fingerprintDimensions`/`outcome`
additively (plus `?diag=nbbo`). `paper-explain.ts` states the setup fingerprint, the
gross→net cost impact, the grade, data-quality reasons, and an explicit
insufficient-evidence note — deterministic, no statistics, no LLM.

**NBBO finding.** Parser mapping is correct (`lastQuote.p/P/t`). Runtime stock NBBO
availability **cannot be proven from the repository** (no committed fixture / DB is
runtime state). `nbboDiagnostic` reports honest counts; `runtimeNbboProven` is true
only once a real verified stock fill exists.

**Bearish safety (unchanged):** `BEARISH_ACTIONABLE` stays off; puts never create an
actionable graded outcome; `lib/bearish-gate.ts` remains final authority. No new
env/test/route/hidden override.

**Deferred to the statistics phase:** win rate / expectancy / profit factor / Wilson
intervals / rolling windows per fingerprint; evidence states beyond a single-outcome
note; reconciling/retiring the legacy gross-P&L layer; activating a trustworthy
market-regime dimension.

## Trustworthy Statistics + Evidence Engine — DONE (Phase 2 of the quant roadmap)

Authoritative statistics computed ONLY from the Phase-1 `paper_trade_outcomes`
layer (never the legacy gross-P&L `trade_outcomes`). Additive migration.

**Pure — `lib/setup-statistics.ts` (+16 tests).** `summarizeOutcomes` computes
graded sample size, ungradable count, data-quality coverage, wins/losses/breakevens,
win rate + **Wilson 95% interval**, avg winner/loser, payoff ratio, profit factor,
expectancy ($ and R), gross/net P&L, total fees, recorded slippage, avg/median hold,
MFE/MAE, max drawdown (ordered equity curve), consecutive win/loss streaks, and
rolling 20/50/100 windows. UNGRADABLE rows are EXCLUDED from performance math but
counted for coverage. Explicit configurable evidence states: `NOT_TRACKED` (0),
`INSUFFICIENT_HISTORY` (1–19), `EARLY_EVIDENCE` (20–99), `ESTABLISHED_EVIDENCE`
(≥100 graded AND ≥20 wins AND ≥20 losses AND ≥95% coverage). A high win rate on a
thin sample is NEVER established.

**Impure — `lib/statistics-store.ts` (+`statistics-store.test.mjs`).** Enriches each
outcome with its frozen fingerprint dimensions and aggregates by fingerprint /
strategy / strategy-version / instrument / selector-profile / session / direction /
tod / dte / delta / spread / rel-vol / vwap / move-classification cuts. Idempotent
`refreshStatistics` materializes `authoritative_statistics` (UNIQUE per
group×version, watermark = max outcome id, upsert-in-place — no double counting).

**DB (`lib/db.ts`).** New `authoritative_statistics` cache (statistics + fingerprint
+ strategy versions, watermark, evidence state). Additive, repeat-safe. Legacy
`setup_statistics`/`trade_outcomes` untouched but no longer sourced for trustworthy
claims.

**Reconciliation.** `explanation-adapters.ts` evidence now reads
`authoritative_statistics` (read-only), mapping evidence state → the explanation
vocabulary; numeric win rate/expectancy surface ONLY for `ESTABLISHED_EVIDENCE`.
The legacy gross-P&L `setup_statistics` read is removed from the evidence path
(deprecated, not deleted). `GET /api/performance/statistics` refreshes + returns the
overall block and cuts; the Performance dashboard shows evidence state, sample count,
win-rate CI, results-after-costs, expectancy, profit factor, drawdown, and per-cut
rows — with explicit "not enough evidence" empty states and a no-guarantee
disclaimer.

**Deferred to prediction modeling (Phase 4):** turning these statistics into a
calibrated probability; the legacy `setup_statistics`/`trade_outcomes` full retirement.

## Market Context + Regime Foundation — DONE (Phase 3 of the quant roadmap)

Deterministic, versioned Market Context Agent. Additive migration.

**Pure — `lib/market-context.ts` (+12 tests).** `buildMarketContext` derives
`spyTrend`/`qqqTrend` (UP/DOWN/FLAT/UNKNOWN via a configurable threshold),
`vwapState`, `riskState` (RISK_ON/RISK_OFF/MIXED/UNKNOWN from SPY+QQQ agreement),
`structure` (TRENDING/CHOPPY/UNKNOWN — trending only when VWAP agrees with the
trend), `volatility` (LOW/ELEVATED/HIGH/UNKNOWN), `freshness`, and `conflictFlags`.
`MARKET_CONTEXT_VERSION=1` stamped on every snapshot. HONEST BY DESIGN: any
dimension without real, fresh data is UNKNOWN with a reason code and never counts
as directional confirmation; the mislabeled legacy `market_regime` is NOT trusted.

**Impure — `lib/market-context-store.ts` (+3 tests).** Gathers SPY/QQQ from the
EXISTING scanner tape (no new provider calls; freshness verified via
`actionableFreshness`) — index dimensions activate only when present AND fresh.
No trustworthy VIX feed is wired, so volatility stays UNKNOWN (not guessed).
Persists the exact context snapshot used (append-only; never back-fills old rows).

**DB (`lib/db.ts`).** New append-only `market_context_snapshots`. Additive,
repeat-safe. **Fingerprints are NOT expanded** with context fields — a future
fingerprint schema change requires its own new fingerprint version.

**API.** `GET /api/market/context` builds + persists + returns the current context.

## Validated Probability-Model Foundation — DONE (Phase 4 of the quant roadmap)

Complete probability-model infrastructure. **Current live status:
`INACTIVE_INSUFFICIENT_DATA`** — there are no graded outcomes yet, so no model is
trained/activated. This is truthful, not a failure: the full pipeline exists and
activates automatically once the data thresholds are met. Additive migration.

**Pure — `lib/model-features.ts` (+8 tests).** Leak-free feature extraction from a
STRICT entry-time whitelist (fingerprint dims + entry numerics + context), one-hot
over fixed vocabularies with explicit missing indicators, `FEATURE_SCHEMA_VERSION=1`,
deterministic sorted schema. Exit/realized/future fields have no channel in.

**Pure — `lib/logistic-model.ts` (+8 tests).** Interpretable L2-regularized logistic
regression; fixed zero-init + fixed full-batch gradient steps ⇒ reproducible.
Standardization baked into the model; schema-mismatch predictions fall back to the
base rate (never a guess). Serialize/restore.

**Pure — `lib/model-evaluation.ts` (+11 tests).** Brier (+ base-rate Brier), log loss,
ROC-AUC (only when both classes present), calibration bins + ECE, confusion at a
documented threshold. **Temporal validation only:** `chronologicalSplit` +
`walkForwardFolds` (expanding train window, test always follows train — no leakage).

**Impure — `lib/model-registry.ts` (+6 tests).** Assembles the chronological,
leak-free training set from graded outcomes + frozen fingerprint dims + entry
numerics; enforces conservative ACTIVATION GATES (≥200 graded, ≥40 wins, ≥40 losses,
≥50 chronological holdout, ≥95% feature coverage — all configurable). Champion/
challenger: a challenger is promoted ONLY if it beats the naive base-rate model out
of sample, stays calibrated (ECE ≤ 0.15), has both classes in holdout, and does not
worsen the champion's Brier/log-loss; the prior champion is RETIRED (kept for
rollback, never deleted). Versioned model registry + evaluation history + prediction
audit tables. `predictFor` returns null (⇒ "Model inactive") unless a validated
champion exists AND the feature schema matches — never a placeholder percentage, and
never a trade authorization. The functional test seeds synthetic outcomes as TEST
SCAFFOLDING ONLY to exercise the gate/promotion path; production fabricates nothing.

**DB (`lib/db.ts`).** New `model_registry`, `model_evaluations`,
`model_prediction_audit`. Additive, repeat-safe.

**API.** `GET /api/model/status` (`?train=1` runs a gated train/evaluate pass).

**Hard-gate precedence (unchanged):** a probability can never override stale-data
blocks, session rules, contract validation, liquidity/spread/risk/capital limits,
bearish safety, or selector rejection.

## Modular Specialized Strategy Agents — DONE (Phase 5 of the quant roadmap)

One shared, deterministic, auditable agent runtime. Reuses every existing service;
duplicates none. Additive (new selector profiles + strategy-version keys only).

**Pure — `lib/agents/types.ts` (+ tests).** The ONE normalized `AgentResult`
contract (agentId/version, strategy/version, ticker, direction, horizon, dteRange,
candidateStatus, lifecycleStatus, score, verifiedInputs, requiredConditions,
selectorProfile, selectedContract, passed/failedGates, evidence, statistics
snapshot, modelStatus, probability, actionability, researchOnly, reasons,
improvement/invalidation conditions, freshness, marketContext, riskVerdict,
timestamp) + `resultKey` + `STATUS_RANK`.

**Pure — `lib/agents/horizon-agent.ts` (+9 tests).** `evaluateHorizonAgent`
consumes gathered, verified inputs (a `selectContract` result, freshness, context,
evidence, model, risk) and emits a normalized result. **A hard gate always
outranks a favorable selection or a model probability** (stale ⇒ DATA_STALE/BLOCKED;
no contract ⇒ NO_VALID_CONTRACT; risk-fail ⇒ WATCH/BLOCKED). **Puts are ALWAYS
research-only**, even if a selection is marked actionable; model probability only
attaches to a bullish active model.

**Pure — `lib/agents/registry.ts` + `supervisor.ts` (+6 tests).** 10 horizon agents
(5 bullish call + 5 put research over 0DTE/1–5/6–10/11–35/36–90) reusing centralized
selector profiles, plus the long-only momentum stock agent. The Supervisor dedups to
ONE canonical result per (ticker,direction,horizon), re-enforces the risk veto,
applies lifecycle hysteresis (never holding a hard-gate status), ranks
deterministically, and preserves every contributing result for audit — it **never
makes a blocked setup actionable because agents agree** and never lets a probability
override a hard gate.

**Impure — `lib/agents/services.ts` + `runtime.ts` (+5 source-spec tests).** The
shared service agents (Market Data, Market Context, Performance/Outcome, Model,
Risk [fails closed], Missed-Opportunity [counterfactual research only — never a
graded outcome], Explanation, Quality-Control) are thin wrappers that DELEGATE to
`data-freshness`, `market-context-store`, `statistics-store`, `model-registry`,
`paper-risk`, `paper-explain`, `outcome-store`. The runtime gathers a fresh chain
(metered provider), runs all agents through the pure evaluator, and supervises. It
writes no trades and fabricates no fills.

**Selector (`contract-selector.ts`).** Additive centralized horizon profiles
`short_dated_call` (1–5), `weekly_call` (6–10), `multiweek_call` (11–35),
`leaps_research_call` (36–90) — all gate logic still lives in one `selectContract`.

**API.** `GET /api/agents?ticker=SPY` returns the canonical set + all contributors +
audit + context + QC.

## Advanced Desktop + Discord Callouts — DONE (Phase 6 of the quant roadmap)

Canonical callouts across every horizon, built from the Supervisor's deduped
results. No DB migration.

**Pure — `lib/callouts/callout.ts` (+5 tests).** `buildCallout` renders ONE
callout per canonical agent result with all specified fields; expectancy/profit
factor surface ONLY for an established sample; probability only when the model
legitimately permits it; puts always carry a research-only warning and are never
actionable. `BANNED_PHRASES` + `containsBannedLanguage` forbid guarantee/"easy
money"/etc.

**Pure — `lib/callouts/dedup.ts` (+7 tests).** Deterministic emission gating:
exactly one message per (opportunity, status) via a stable idempotency key
(`callout:{ticker|dir|horizon}:{status}`); unchanged status ⇒ suppress (no
minor-oscillation spam); only material transitions (developing→near→actionable→
extended/invalidated, no-contract→valid, stale→fresh, model transitions) emit an
update; non-emittable statuses (stale/no-contract) show on desktop but never
Discord; cooldown window.

**Pure — `lib/callouts/discord-format.ts` (+3 tests).** Embed in the required
order (header→why→trigger→contract→risk→evidence→model→advanced→disclaimer),
research-only/non-guarantee language, probability hidden when inactive; a final
banned-language guard redacts non-compliant text.

**Impure — `lib/callouts/runtime.ts` + `/api/callouts` + `app/callouts/page.tsx`.**
Ties agents→callouts→dedup with per-process prior state. **Discord AUTO-SEND is
gated off by default** (`AGENT_CALLOUT_DISCORD=1`) — the existing alert Discord
ledger is untouched, payloads are preview-ready with idempotency keys, and no
delivery is fabricated (recorded blocker: no test webhook, so live agent-callout
Discord is opt-in). New "Horizon Callouts" desktop surface with horizon/direction/
status filters (additive TOOL_NAV entry; no unrelated page redesign).

## Bounded Continuous Learning + Drift Monitoring — DONE (Phase 7 of the quant roadmap)

Deterministic, auditable, reversible learning loop over authoritative outcomes.
Additive migration (`learning_runs`, `drift_snapshots`, guarded `model_registry.health`).

**Pure — `lib/learning/retrain-policy.ts` (+7 tests).** `shouldRetrain` bounds a
retrain to: ≥25 new graded outcomes since the last trained watermark, ≥24h since the
last attempt, both classes present, ≥95% coverage, and a moved watermark (no repeat
training). Configurable/versioned.

**Pure — `lib/learning/drift.ts` (+8 tests).** `classifyDrift` → HEALTHY / WATCH /
DEGRADED / MODEL_STALE / DATA_DRIFT / PERFORMANCE_DRIFT / INSUFFICIENT_DATA from
coverage, stale-data & contract-rejection frequency, model age, and base-vs-current
Brier / win-rate / ECE — with reason codes. Pure diagnosis only.

**Impure — `lib/learning-store.ts` (+4 tests).** `runLearningCycleOnDb` refreshes,
decides a bounded retrain (delegating to the Phase-4 registry — champion/challenger,
rollback preserved), records every attempt/skip/promotion/rejection in `learning_runs`,
snapshots drift, and flags a degraded champion `health='WARNING'` (never inactivating
blindly, never bypassing a hard gate). Deterministic human-review recommendations are
generated but NEVER auto-applied. A source-spec test asserts it writes only to
`learning_runs`/`drift_snapshots`/`model_registry.health` — never a threshold, risk
limit, setting, or source file.

**API + dashboard.** `GET /api/learning?run=1` runs one bounded cycle; the new
Research & Learning desktop page shows model readiness, drift state, outcome counts,
the retrain/drift audit trail, data-quality blockers, and recommendations.

## Live Experimental Probability Mode — DONE (Phase 8 of the quant roadmap)

Three explicit, user-facing model states so a real-but-limited dataset can produce
a *research-only* probability without ever masquerading as validated. Additive
migration only (guarded `model_registry.tier`); no historical rewrite.

**The three states (`lib/model-experimental.ts`, PURE, +6 tests).**
- `ACTIVE_VALIDATED` — strict production thresholds met (≥200 graded, ≥40W/≥40L,
  ≥50 holdout, ≥95% coverage, calibrated). Plain probability.
- `ACTIVE_EXPERIMENTAL_RESEARCH_ONLY` — a real two-class dataset exists (≥30 graded,
  ≥8W/≥8L, ≥10 holdout, both classes, beats base rate out of sample) but the
  validated bar is not met. Every such prediction carries the exact label
  **EXPERIMENTAL — LIMITED DATA — RESEARCH ONLY** and is explicitly "not a validated
  probability".
- `INACTIVE_NO_TRAINABLE_DATA` — not enough trustworthy data; **no probability shown**,
  fall back to **SETUP SCORE — NOT A PROBABILITY** (the deterministic contract score).

**Tiered promotion (`lib/model-registry.ts`, +9 registry tests).**
`checkActivationTier` decides VALIDATED / EXPERIMENTAL / NONE from the live rows.
`trainAndEvaluateOnDb` runs two promotion tracks: VALIDATED → `status='CHAMPION'`
(`tier='VALIDATED'`); EXPERIMENTAL → `status='EXPERIMENTAL_CHAMPION'`
(`tier='EXPERIMENTAL'`), each gated on beating the naive base rate, tier-appropriate
ECE calibration, both classes out of sample, and improving on the prior champion of
the SAME tier. A validated champion always supersedes (retires) a standing
experimental one; an experimental champion NEVER displaces a validated one and never
claims the `ACTIVE_CHAMPION` status. Prior champions are retired (kept for rollback),
never deleted. `predictForOnDb` returns `{ proba, state, tier, experimental }` and
flags every experimental prediction research-only.

**Safety invariants (unchanged, enforced by test).** Experimental probability is
purely informational: actionability is still decided solely by the contract-selection
/ freshness / session / liquidity / risk gates in the horizon agent, so an
experimental (or any) probability can NEVER create `ACTIONABLE_NOW`, bypass data
freshness, override risk/capital controls, enable bearish actionability, or trigger
live execution. Callout test "experimental probability never flips a callout to
actionable on its own" locks this in. Puts remain RESEARCH_ONLY; `bearish-gate.ts`
untouched; no brokerage SDK imported.

**Surfaced everywhere.** `lib/callouts/callout.ts` adds `modelLabel` +
`probabilityIsExperimental`; `lib/callouts/discord-format.ts` renders the EXPERIMENTAL
label with "not a validated probability" for experimental predictions and the SETUP
SCORE fallback when inactive (banned-language guard still applies). `lib/agents/services.ts`
`modelAgent` now reports the three states. `GET /api/model/status` returns
`state`/`tier`/`experimental` + an experimental disclaimer; the Research & Learning
dashboard shows the state badge, the EXPERIMENTAL banner, sample (W/L · holdout), and
the "not validated because…" reason.

**Current live state:** `INACTIVE_NO_TRAINABLE_DATA` — there are no graded paper
outcomes yet, so neither tier can activate. Recorded blocker, not fabricated data.

## Controlled Code-Improvement Agent — DONE (Phase 9 of the quant roadmap)

A propose-only agent that NEVER edits code or trading rules autonomously. It
produces immutable, classified improvement proposals; it has no git/merge/push
path. Additive migration only (`improvement_proposals`, write-once by content id).

**Pure — `lib/improvement/proposal.ts` (+11 tests).** Immutable, frozen
`ImprovementProposal` with a deterministic content id (`impN_<16hex>`), per-category
risk + auto-merge policy (LOW test_coverage/documentation/dead_code/type_safety →
auto-merge-eligible; MEDIUM refactor/performance/dependency/config → review; HIGH
risk_policy/strategy_logic/execution_path; forbidden bearish_enablement/
live_execution/safety_policy). Hard guards force **forbidden + HIGH** whenever a
target hits a `SAFETY_PROTECTED_PATH` (bearish gate, paper-risk, the agent's own
policy/store) or a live-execution/brokerage marker, or the title/rationale carries a
forbidden intent (enable bearish, live/real-money, bypass risk, force-push,
self-approve, override veto) — so a mislabeled change can never slip through.

**Pure — `lib/improvement/policy.ts` (+8 tests).** `decideDisposition` with strict
safety-first precedence: forbidden → **BLOCKED**; HIGH → **HUMAN_REVIEW_REQUIRED**
(never self-approved); no automation → **READY_FOR_CODING_AGENT**; LOW + eligible +
automation + auto-merge both enabled → **AUTO_MERGE_ELIGIBLE**; otherwise
**HUMAN_REVIEW_REQUIRED**. `ABSOLUTE_PROHIBITIONS` (never force-push, never
self-approve high-risk, never enable bearish/live execution, never touch the risk/
bearish/safety-policy guardrails) are unoverridable by any config.

**Pure — `lib/improvement/audit.ts` (+1 test).** `proposalsFromAudit` derives
LOW-risk test-coverage proposals ONLY from real, checkable facts (untested modules),
skipping safety-protected paths. No fabricated rationale.

**Impure — `lib/improvement-store.ts` (+5 tests, incl. source-spec).** Write-once
proposal ledger (INSERT OR IGNORE by content id ⇒ history never rewritten). Records
disposition at record time; `improvementStatusOnDb` reports the honest agent state
(INACTIVE_NO_AUTOMATION / ACTIVE_PROPOSE_ONLY / ACTIVE_AUTO_MERGE_LOW_RISK) with
recorded blockers. A source-spec test asserts the store's only write target is
`improvement_proposals` and that it contains no `child_process`/`git push`/`spawn`
side effects.

**Runtime + API + dashboard.** `lib/improvement/runtime.ts` scans `lib/*.ts` for
untested modules and records proposals (the only side effect). `GET /api/improvement`
(`?audit=1` runs one audit) returns state, prohibitions, counts, and the ledger. The
new `/improvement` desktop page shows the agent state, prohibitions, disposition
counts, and the immutable proposal table.

**Current live state:** `INACTIVE_NO_AUTOMATION` — no coding-agent / GitHub
automation is configured (`IMPROVEMENT_AUTOMATION!=1`), so nothing is branched,
merged, or pushed; eligible proposals are surfaced as READY_FOR_CODING_AGENT. Branch
protection / required reviews on `main` must be configured **manually** in GitHub —
this agent does not assume, request, or depend on those permissions. Isolated work
branches follow `auto-improve/<category>/<compact-utc>` when a coding agent picks a
proposal up.

## Later phases (explicitly out of scope now)

Bearish-strategy rebuild · contract substitution on revalidation failure ·
historical-data adapter · statistical prediction models · specialized strategy
agents (each = a selector profile) · Self-Improvement Lab · optional embedded
LLM · live-broker / real-money execution.

## New tests

`tests/opportunity-lifecycle.test.mjs` (14), `tests/opportunity-persistence.test.mjs`
(6), `tests/system-health.test.mjs` (9), `tests/navigation.test.mjs` (4),
`tests/command-center.test.mjs` (5).

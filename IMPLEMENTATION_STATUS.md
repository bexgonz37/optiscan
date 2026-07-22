# OptiScan — Implementation Status

_Last updated: 2026-07-18. Working repo: `~/Downloads/optiscan-main`, branch `main`._

## ⚠️ CANONICAL WORKING DIRECTORY (read first, every session)

- **Canonical working repo: `C:\Users\bexgo\Downloads\optiscan-main`** (branch `main`).
- **Canonical remote source of truth: `github.com/bexgonz37/optiscan.git` → `origin/main`.**
  Railway deploys from GitHub `main`, so `origin/main` is authoritative.
- **Always `git fetch` and confirm `origin/main` before resuming.** Fast-forward the
  canonical repo to `origin/main` first; never work from a stale copy.
- **Never select another OptiScan folder based only on modification date.** Recency of
  file mtimes is NOT a signal of which copy is canonical.
- **`C:\Users\bexgo\optiscan_audit` is a temporary safety/WIP copy, NOT the canonical
  repo.** Its unmerged momentum/options WIP is preserved on branch
  `wip/momentum-options-investigation` (+ patch/bundle in `~/optiscan_wip_backup/`);
  that WIP is superseded by `a91aaae` and must not be reapplied blindly.
- **`C:\Users\bexgo\optiscan` is OBSOLETE (143 commits behind) and must not be used.**
- Do not delete the alternate folders yet; just do not work in them.

This file is the resume point. Read it + the task list before making changes.
Do **not** repeat Phase 1, redo timestamp normalization, or add the Self-Improvement
Lab / an embedded LLM.

## 🧠 ANALOG ENGINE REBUILD — active roadmap (resume tracker)

Authoritative design: artifact **"The Analog Engine — Quantitative Blueprint."** Build map,
cost review, and blocker register: `docs/ANALOG_ENGINE_BUILD.md`. Baseline `40e68b7`.
Build order A→I; **Phase D is a mandatory evidence gate** (beat all baselines out-of-sample
or stop + bounded remediation). Every new capability OFF by default; production unchanged.

- ✅ **Phase A — Episode schema + forward labels** (commit pending). The unit of historical
  memory + the structural anti-look-ahead guard. Additive tables `setup_episodes` (Zone-A
  decision-time context; `max_feature_as_of_ms` must be ≤ t0) and `episode_labels` (Zone-B
  forward outcomes; `label_as_of_ms` must be > t0). Pure modules `lib/research/episode/{schema,
  leakage,labels,store}.ts`: deterministic episode key; leakage validators (reject any Zone-A
  block with asOf > t0, reject any label using data ≤ t0); side-aware underlying labels + an
  honestly-flagged `MODELED_OPTION` Greeks/Taylor reprice (never a real fill); OnDb store that
  REFUSES leaky episodes/non-forward labels and is idempotent (UNIQUE keys). Flag
  `EPISODE_CAPTURE_ENABLED` (OFF); live wrapper is a hard no-op and is NOT wired (Phase C replay
  is the primary writer). Gates: focused 15/15 · full 1496/1496 · tsc 0 · build 0. Tests:
  `tests/analog-episode.test.mjs`, `tests/analog-episode-store.test.mjs`.
- ✅ **Phase B — Evaluation harness + baselines** (commit pending). The scientific spine, built
  BEFORE the recommender. `lib/research/eval/{types,metrics,baselines,harness}.ts` (pure) +
  additive `eval_runs`/`eval_results`. Metrics: expectancy, hit-rate, profit-factor, Brier, ECE,
  reliability curve, paired bootstrap lift-CI. Baselines: random, always-trade, velocity, simple
  rule, trainable logistic, broker-visible. Harness: expanding walk-forward splits, purge+embargo
  (removes training labels overlapping the test period), strict OOS evaluate, compareToBaseline,
  beatsAllBaselines (the Phase-D predicate). **Acceptance PROVEN:** finds a true signal over random
  (lift CI &gt; 0), reports NO significant lift on a no-signal dataset, and finds no spurious lift
  of a linear signal over a logistic baseline. Gates: focused 10/10 · full 1506/1506 · tsc 0 ·
  build 0. Tests: `tests/analog-eval.test.mjs`.
- ✅ **Phase C — Historical replay → episode seeding** (commit pending). `lib/research/episode/seed.ts`:
  pure core turns historical bars → leakage-proof Episodes + Phase-A UNDERLYING labels — event-driven
  candidate moments (same intake shape on history, bars[0..i] only, no hindsight), per-symbol
  refractory dedup, ATR/range/rvol/velocity feature blocks (asOf = t0), honest missing markers for
  data unavailable in replay (regime/sector/breadth/options/catalyst → null + `missing`, never
  fabricated), horizon labels only when forward bars actually REACH the horizon end. Flag-gated live
  driver `runReplaySeed` (HISTORICAL_REPLAY_ENABLED + EPISODE_CAPTURE_ENABLED; **caller supplies a
  survivorship-free universe** — never fabricated) reuses `replay_runs` checkpoint + adjusted `/v2/aggs`;
  persists via the Phase-A store (idempotent, refuses leaky rows). **No schema change** (reuses Phase-A
  + replay tables). Gates: focused 9/9 · full 1515/1515 · tsc 0 · build 0. Tests: `tests/analog-seed.test.mjs`
  (determinism, leakage, candidate/dedup, restart-idempotency, no fabricated MODELED_OPTION labels,
  flag-off no-op). **Blocked/inactive (documented, no fabrication):** auto point-in-time universe
  reconstruction (needs reference list endpoint + entitlement); replay MODELED_OPTION labels (needs
  historical Greeks — not entitled). Provider/scale audit in `docs/ANALOG_ENGINE_BUILD.md`.
- ✅ **Phase D — Tier-1 analog engine + live-data operator tooling** (commits `e83cbf5` + pending).
  Engine (`lib/research/analog/{similarity,engine,report}.ts`): transparent z-score + ridge
  correlation-aware + outcome-weighted metric; comparability pre-filter → outcome-weighted kNN →
  forward-return distribution → sample/dispersion/contradiction penalties → abstention; wired as a
  `Scorer` into the Phase-B harness (`beatsAllBaselines`). Durable versioned report + verdict
  (additive `analog_eval_reports`): survivorship/synthetic ⇒ EXPLORATORY_ONLY (never GO); GO needs
  beating EVERY baseline OOS + calibration + coverage on a real, survivorship-free library.
  Live-data tooling: `lib/research/episode/universe.ts` (fallback hierarchy: provider-PIT →
  user-dated file → current-symbols=EXPLORATORY; never silently uses today's list), `runReplaySeed`
  guardrails (kill switch `EPISODE_SEED_KILL`, safe-default dry-run, `maxSymbols` cap, rate limit,
  pre-flight estimate), token-gated admin routes `GET /api/research/entitlement` (secret-safe
  reference-endpoint probe) + `GET|POST /api/research/seed` (bounded seed job, dry-run default),
  and the Railway runbook (A–G) in `docs/ANALOG_ENGINE_BUILD.md`. Gates: full 1538/1538 · tsc 0 ·
  build 0. Tests: `tests/analog-engine.test.mjs` (13), `tests/analog-universe.test.mjs` (11).
  **NOT real-market evidence yet:** engine validated on synthetic episodes only; the *live go/no-go*
  awaits the OWNER running the seed on Railway over a survivorship-free universe (see runbook).
  If, on real data, it shows no OOS lift → STOP + bounded remediation; do NOT tune to a positive backtest.
- ✅ **Phase E — Options mapping + recommendation card + real Phase-D runner** (commit pending).
  `lib/research/reco/contract.ts` maps the analog thesis to the CURRENT real chain with hard gates
  (chain_unavailable / chain_stale / event_risk / no_expiration / spread / open_interest / volume /
  no_two_sided_quote) — abstains with a reason, never fabricates a contract; puts are RESEARCH_ONLY
  unless `bearishActionable()` (default OFF). `card.ts` builds the full card from `AnalogScorer.explain()`
  evidence (ticker / CALL-or-PUT / exact contract / bid-ask-spread / entry range / targets / invalidation /
  hold / confidence / analog count / effective sample / median outcome / dispersion / closest winner+loser /
  regime relevance / abstention reason / MODELED-vs-OBSERVED disclosure). `recommend.ts` orchestrates +
  idempotent persist. **Real Phase-D runner**: `lib/research/analog/evaluate.ts` (`runPhaseDEvalOnDb`)
  reads seeded episodes, flattens Zone-A blocks to numeric features, runs `beatsAllBaselines` over
  purged walk-forward splits, and writes the GO/REMEDIATE/STOP report; provenance is `real_seeded` only
  when every replay run is survivorship-free (else EXPLORATORY_ONLY). Token-gated route
  `app/api/research/evaluate/route.ts` (POST run / GET latest). Additive `recommendations` table.
  Verdict logic refined: beating every baseline OOS but missing a calibration/coverage gate is
  **REMEDIATE** (signal present, remediate), STOP is reserved for *no* OOS lift. Tests:
  `tests/analog-reco.test.mjs`, `tests/analog-evaluate.test.mjs` (synthetic PLUMBING only — NOT presented
  as real-market evidence). Green: 1555 tests, tsc 0, build 0.
- ✅ **Phase E.1 — seed-run observability hardening** (commit pending). Root-caused a misleading
  success: a Railway smoke seed reported `ran:true / symbolsDone:3 / COMPLETED` with **zero** provider
  calls and zero episodes. Two defects: (1) `runReplaySeed` never wrote `provider_calls` back to the run
  row, incremented `symbolsDone` unconditionally, and hard-coded status `COMPLETED`; (2) provider errors
  were swallowed (`fetchHistoricalStockBars`/`fetchCandles` catch → empty bars + discarded note), and the
  adapter passed `multiplier` while `fetchCandles` reads `resolution` (silently fetching 5-min, never
  1-min). Fixes: attempted-vs-succeeded call counts tracked + persisted; per-symbol status
  (OK/NO_DATA/PROVIDER_ERROR/NO_PROVIDER) + secret-safe note; run status now
  COMPLETED/COMPLETED_NO_DATA/PARTIAL/FAILED/PAUSED (zero attempted calls on a non-dry run ⇒ FAILED, never
  a bare COMPLETED); `symbolsDone` counts only symbols that returned data; provider notes sanitized
  (apiKey/Bearer stripped); bounded one-symbol `diagnostic` mode (real fetch, writes nothing); `resolution`
  bug fixed so 1-minute bars are actually fetched. `runReplaySeed` now takes injectable `{db, fetchBars}`
  deps for testing. Additive `replay_runs` columns (`provider_calls_attempted`, `symbols_with_data`,
  `per_symbol_json`); seed status route exposes them. Test `tests/analog-seed-observability.test.mjs`
  reproduces the exact zero-call condition. Green: 1564 tests, tsc 0, build 0.
- ✅ **Phase E.2 — full date-range coverage (5,000-bar cap fix)** (commit pending). A live 3-symbol
  smoke seed returned exactly 5,000 bars per symbol — Polygon `/v2/aggs` truncates at its per-page cap and
  the adapter never followed `next_url` (Jan 2–31 2024 = 21 trading days ≈ 8,190 regular-session 1-min
  bars, ~20k with extended hours). Fix: `fetchHistoricalStockBars` now splits the requested range into
  deterministic 30-day windows (`replayDateWindows`), fetches each with Polygon's 50k per-call limit
  (additive `limit` passthrough on `fetchCandles`, default unchanged), deduplicates bars by timestamp
  across chunks, and sorts ascending. It reports `chunks`, `rangeComplete`, `truncated`, `firstBarMs`,
  `lastBarMs`, and per-chunk detail. Incomplete/truncated coverage (a failed chunk or a cap-hit) is a new
  per-symbol `INCOMPLETE` status that makes the run **PARTIAL**, never a bare COMPLETED. Default
  `providerCallBudget` now scales with chunk count (was `symbols.length`, which would have stopped a
  multi-chunk seed after one symbol). Tests: `tests/analog-replay-chunking.test.mjs` (>5,000 bars via
  chunking, window boundaries, cross-chunk dedup, missing-middle-chunk → incomplete, cap→truncated,
  budget/quota interruption → PARTIAL + idempotent resume). Green: 1573 tests, tsc 0, build 0.
- ✅ **Phase E.3 — asynchronous seed-job model** (commit pending). `POST /api/research/seed` ran the
  whole replay synchronously in the request, so a 10-symbol / 6-month pilot (~60 rate-limited provider
  calls) hung past the Railway gateway timeout and never returned. New model (`lib/research/episode/
  seed-jobs.ts`): `POST` for a real seed now `createSeedRun` (inserts a QUEUED `replay_runs` row,
  idempotent per deterministic `experiment_id`) and fires `runSeedWorker` **un-awaited**, returning
  `{runId, status:QUEUED, statusUrl}` immediately. The background worker processes one symbol per step,
  persists progress after every chunk (via a `fetchHistoricalStockBars` `onChunk` callback) and every
  symbol, and lives in the server process so a **client disconnect** never stops it. `GET
  /api/research/seed/:runId` returns progress (symbols total/done/with-data, current symbol, chunks,
  calls attempted/succeeded, episodes, labels, errors, per-symbol detail, elapsed + reliable ETA) and
  **re-kicks an orphaned run after a server restart**. Statuses QUEUED/RUNNING/PAUSED/PARTIAL/FAILED/
  COMPLETED/CANCELED; runs are resumable (symbol-level checkpoint) and idempotent (episode
  INSERT OR IGNORE); `POST :runId {action}` supports cancel / pause / resume; `resumeInterruptedSeedRuns`
  recovers after restart. Dry-run and the one-symbol diagnostic stay synchronous (fast). All provenance /
  survivorship / quota (budget) / flag / kill-switch rules preserved. Additive `replay_runs` progress
  columns (episodes_captured, labels_captured, symbols_total, symbols_done, chunks_completed,
  current_symbol, cancel_requested, started_at_ms). Tests: `tests/analog-seed-jobs.test.mjs` (immediate
  create, background progression, client disconnect, resume-after-interruption, duplicate submission,
  quota→PARTIAL + continuation, partial-symbol failure, final COMPLETED, cancel, pause/resume). Railway
  note: the hang was request-duration (synchronous replay exceeding the proxy timeout), not memory; the
  async model removes long-lived requests entirely. Green: 1584 tests, tsc 0, build 0.
- ✅ **Phase E.4 — out-of-process seed worker (API stays responsive)** (commit pending). The E.3
  "async" worker was still fire-and-forget INSIDE the Next web process: better-sqlite3 is synchronous
  and `seedSymbolOnDb` (candidate detection + hundreds of inserts over tens of thousands of bars) is
  CPU-bound, so it monopolized the single main-thread event loop — `GET /api/research/seed/:runId` and
  `/api/health` timed out (curl: 0 bytes in 20s) while a seed ran. Also GET re-kicked the worker inline.
  Fix: replay now runs in a **separate Node worker process** (`worker/seed-worker.ts`, run via
  `node --experimental-strip-types`), spawned + supervised from the web process by
  `lib/research/episode/seed-worker-manager.ts` (idempotent per process; respawn on exit; only when
  replay flags are on). The web process ONLY inserts a QUEUED row (POST), reads persisted state (GET —
  pure read, no inline work, no resume), and writes control flags (cancel/pause/resume). The worker
  claims jobs via a **lease** (`claimNextSeedRun`); an expired lease (crashed/restarted worker) is
  reclaimed on the next poll and the run resumes from its checkpoint. WAL (already on) lets the web
  process read while the worker writes. DB writes are single short statements — no transaction/lock
  spans a symbol, chunk, network call, or sleep. Structured JSON logs (`seed-log.ts`, `SEED_LOG=1`)
  around claim/start/done, provider call start/end, rate sleep, checkpoint write, API request start/end,
  and event-loop lag (sampled on the web thread). Additive `replay_runs` lease columns (lease_owner,
  lease_until_ms, heartbeat_ms); `engines.node >= 22.6.0`; `npm run worker` script. Tests
  (`tests/analog-seed-worker.test.mjs`) spawn the REAL worker process and prove: event-loop lag stays
  <250ms and status-read p95 <50ms while the worker burns CPU; lease claim + stale-lease reclaim/resume;
  client disconnect; cross-process cancel. **Railway proof is the operator's to run** (I cannot deploy):
  local integration tests prove the mechanism; deploy + the p50/p95 latency script (in the chat) prove
  it on Railway. Green: 1590 tests, tsc 0, build 0.
- ✅ **Phase E.5 — crash-safe worker spawn (fix the total Railway outage)** (commit pending). E.4's
  worker spawn wedged the WHOLE web process on Railway (every route, incl. /api/health, returned 0 bytes).
  Root cause: (1) `next.config` `output:"standalone"` prunes `worker/seed-worker.ts` (never imported, only
  referenced by path) from the image, so `spawn(... worker/seed-worker.ts)` failed with ENOENT; (2) the
  child had no `'error'` handler, so the ENOENT surfaced as an **uncaught exception that crashed the web
  process** → re-spawn on the next request → web-level crash loop → total outage. Fixes: worker spawn is
  now **opt-in** (`OPTISCAN_ENABLE_SEED_WORKER=1`, default OFF → default deploy is always healthy),
  **non-fatal** (`child.on('error')` + try/catch everywhere; a spawn failure never reaches the request
  loop), **self-disabling** (crash-loop ceiling of 5 with exponential backoff), **non-recursive** (child
  runs with `OPTISCAN_PROCESS_ROLE=seed-worker` and never spawns another), and **pre-flight checked**
  (worker file must exist + Node must support `--experimental-strip-types`). Spawn is deferred off the
  request path (`setImmediate`). GET status is now a **pure read** (no worker-ensure, no resume).
  `outputFileTracingIncludes` ships `worker/**` + the seed `lib/**` into the standalone build (verified:
  the whole chain lands in `.next/standalone`). Worker logs role/pid/ppid/node/journal_mode/busy_timeout
  at startup. Pure decision `seedWorkerSpawnDecision` + `nodeSupportsStripTypes` are unit-tested
  (`tests/analog-seed-worker-manager.test.mjs`); `ensureSeedWorker` is a proven safe no-op when disabled.
  RECOVERY: deploy this commit (worker off by default) → /api/health returns → then set
  `OPTISCAN_ENABLE_SEED_WORKER=1` with replay flags on for a controlled worker enable. Green: 1598 tests,
  tsc 0, build 0.
- ✅ **Phase E.6 — stale-run cancellation reconciliation** (commit pending). A recovered/legacy run
  (`episode_seed_1784662810251`: RUNNING, cancel_requested=true, symbols_total=0, started_at=null) stayed
  RUNNING forever: `cancelSeedRun` only set the flag and relied on a worker to observe it, but
  `claimNextSeedRun` EXCLUDES `cancel_requested=1` rows — so no worker ever advanced it to finalize →
  deadlock. Fixes: `cancelSeedRun` now finalizes **CANCELED immediately when the run is not actively
  leased** (QUEUED, or RUNNING with an expired/absent lease), clearing lease ownership; a live-leased run
  still defers to the worker's cooperative stop. New `reconcileStaleSeedRuns` sweeps RUNNING rows with no
  active lease: cancel_requested → CANCELED, unresumable (empty/missing symbol plan) → FAILED with an
  explicit reason. It runs in the worker poll (before any claim), at server boot, and via an admin
  `POST /api/research/seed {action:"reconcile"}` (works even when the worker is disabled). `advanceSeedRun`
  now checks cancellation before recovery, before the provider call, and (via a new `checkAbort` passed to
  the chunked fetch) at every chunk boundary — so **no provider call happens after cancel is persisted**;
  every CANCELED transition clears the lease. GET stays a pure read. Tests
  (`tests/analog-seed-cancel.test.mjs`): cancel before claim, during the provider call, during the
  rate-limit gap, of an expired-lease run, of a malformed legacy row, repeated cancel, worker-restart
  after cancel, and no-calls-after-cancel — plus reconcile leaves a live-leased run untouched. Green: 1607
  tests, tsc 0, build 0. OPERATOR: deploy, then `POST {action:"reconcile"}` (or `cancel` each runId) to
  finalize `episode_seed_1784662810251` and `episode_seed_1784663885317_2dtq8n`.
- ✅ **Phase E.7 — Node 22 production image (enables the worker)** (commit pending). Production is a
  Dockerfile build (`railway.json` builder=DOCKERFILE, `CMD ["node","server.js"]` = Next standalone), and
  it was pinned to `node:20-bookworm-slim`. Node 20 has no `--experimental-strip-types`, so the seed
  worker could never run in prod (E.5's guard kept the web healthy but left the worker permanently
  disabled). Fix: bumped the single base stage to `node:22-bookworm-slim`; all stages (`deps`, `builder`,
  `runner`) derive from `base`, so the whole multi-stage build is Node 22 (verified: no `node:20` remains).
  New guard test `tests/prod-image-node-version.test.mjs` parses the Dockerfile and FAILS the build if any
  `FROM node:` base is < 22.6 (trip-wire against a silent regression), and cross-checks `nodeSupportsStripTypes`
  + `package.json engines`. Confirmed: local Node 22.23 runs `--experimental-strip-types`; the standalone
  build still contains `worker/seed-worker.ts` + the whole seed `lib` chain; the worker role guard and
  crash-loop protections (E.5) are unchanged and green. Start command / Railway config untouched. Green:
  1611 tests, tsc 0, build 0. NOTE: the worker still only spawns when `OPTISCAN_ENABLE_SEED_WORKER=1`
  (+ replay flags) is set on Railway; not enabling it keeps prod exactly as-is.
- ✅ **Phase E.8 — elapsedMs freeze (progress metrics fix)** (commit pending). First successful Railway
  production seed (`episode_seed_1784669431399_ep7dcl`: COMPLETED, 3/3 symbols, 6/6 calls, 113 episodes,
  761 labels, API stayed responsive). Display bug: `getSeedRunProgress` computed `elapsedMs = nowMs -
  startedAtMs`, so for a settled run it grew on every poll (a 29s run read as 108s when polled ~79s after
  completion). No mixed clocks / stale-lease — both timestamps are `Date.now()` on one host; the bug was
  using poll-time instead of completion-time. Fix: for terminal/PAUSED runs `elapsedMs = updatedAtMs -
  startedAtMs` (true duration, frozen); while RUNNING it stays live (`nowMs - startedAtMs`). ETA unchanged
  (RUNNING-only). Tests reproduce the exact production timestamps and assert elapsed no longer grows on
  later polls. The successful seed result stands. Green: 1613 tests, tsc 0, build 0.
- 🟡 **Phase F — forward paper validation + two-speed alerts** (COLLECTING_DATA; infrastructure shipped,
  commit pending). Complete, flag-gated-OFF infrastructure under `lib/research/forward/`; produces no
  evidence yet and never claims live edge/latency from synthetic data. Pieces: **capture** (immutable
  `forward_recommendations`, idempotent, decision-time only) + **grade** (`forward_outcomes`, side-aware,
  forward-only, look-ahead-refused) with strategy buckets (bullish/bearish × call/put/stock ×
  0DTE/short/longer) and Phase-D backtest comparison. **Two-speed pipeline** (`twospeed.ts`):
  `evaluateEarlyWatch` takes ONLY fast deterministic inputs (its type can't reference
  analog/model/news) → EARLY_WATCH; `resolveConfirmation` → CONFIRMED/CANCELED/TOO_LATE/EXPIRED; bearish
  routed through `bearish-gate.ts`, puts research-only. **Latency** (`latency.ts`, one-clock stamps):
  event→trigger, trigger→early-watch, event→Discord, event→confirmation at p50/p90/p95/max +
  failure/retry/too-late/canceled/late-entry rates + a `heavyWorkOnCriticalPath` counter (must be 0).
  **Freshness** (`freshness.ts`): recheck price/zone/chase/age before delivery → TOO_LATE instead of a
  stale entry. **Report** (`report.ts` + read-only `GET /api/research/forward`): sample size, win/exp by
  strategy, drawdown, calibration, backtest-vs-forward, latency dist, stale/late/canceled, outages,
  Discord reliability, and an explicit `missingEvidence[]`; status COLLECTING_DATA until real samples
  accrue. Flags `FORWARD_CAPTURE_ENABLED`, `TWO_SPEED_ALERTS_ENABLED` (both OFF). Additive tables
  (repeat-safe, verified). Doc `docs/PHASE_F_FORWARD_VALIDATION.md` incl. the commercial-readiness gaps.
  Tests: `forward-pipeline`, `forward-capture-grade`, `forward-report`. Green: 1629 tests, tsc 0, build 0.
  **NOT DONE — evidence still missing (do not advance to Phase G):** measured production EARLY_WATCH p50/p95,
  heavy-work-off-path proof in prod, forward sample size per bucket, and every commercial-readiness gap.
- 🟡 **Broad Discovery + Analog Shadow Bridge** (SHADOW-ONLY, flag-gated OFF; commit pending). Audited
  the live discovery universe (`docs/CURRENT_LIVE_DISCOVERY_AUDIT.md`): curated ~230 (`universe.js`) +
  bounded whole-market broad sweep ($0.50–$50 / +10% / ≥500k, `scanner-loop.ts`); news/earnings/options/
  sympathy are NOT discovery sources; no PIT/broad historical universe. Built shadow infra (NOT wired to
  the live loop, NO alerts, NO threshold changes): **discovery** (`discovery/eligibility.ts` strict
  exclusions — OTC/warrant/right/unit/preferred/halted/low-price/low-$vol/stale + options gates only when
  entitled; `discovery/discover.ts` source-attributed merge + summarize). **Analog shadow**
  (`shadow/analog-bridge.ts`): decision-time snapshot (episode-library keys) → `AnalogScorer.explain` →
  records comparable count/similarity/forward-return dist/confidence/dispersion/abstention/agree-vs-live/
  lookup latency as `ANALOG_SHADOW_ONLY`; cannot block/alert/override/actionize (isolated on error).
  **Market context** (`context/market-context.ts`): prospective regime/index-trend/vol/sector/breadth/
  catalyst/earnings/session/liquidity/IV with a **look-ahead guard that throws** + `missing[]` (no
  backfill). **Earliness** (`shadow/earliness.ts`): fraction-of-move-complete, breakout distance, time
  lead, MFE/MAE, price-improvement-vs-momentum + 3-lane comparison. Additive repeat-safe tables
  (`discovery_shadow`, `analog_shadow`, `market_context_shadow`); read-only `GET /api/research/shadow`.
  Flags `BROAD_DISCOVERY_SHADOW_ENABLED`, `ANALOG_LIVE_SHADOW_ENABLED`, `MARKET_CONTEXT_CAPTURE_ENABLED`
  (all OFF). Docs: CURRENT_LIVE_DISCOVERY_AUDIT, BROAD_DISCOVERY_SHADOW_PLAN, ANALOG_SHADOW_BRIDGE (incl.
  AI safe-design), FIVE_YEAR_CORPUS_CAPACITY_PLAN (tiered cost/runtime/bias). Tests: `discovery-shadow`,
  `analog-shadow-bridge`. Green: 1643 tests, tsc 0, build 0. **Analog remains NON-actionable; no hard
  gate weakened; no production seed.** Safe to enable ONLY for data collection.
- 🟡 **Shadow runtime wiring + earnings/options-activity sources + AI shadow** (SHADOW-ONLY, flags OFF;
  commit pending). Resolved the wiring gap: the shadow `record*` hooks previously had NO live caller
  (only the read-only route), so enabling flags recorded nothing. Now `scanner-loop.ts refreshDiscovery`
  ends with a **guarded fire-and-forget** `enqueueShadowCycle({nowMs, quotes})` (try/catch, never awaited)
  onto a **bounded queue** (`shadow/queue.ts`: concurrency + max-depth backpressure + dedup by
  symbol|source|event|10s-bucket + per-task timeout + full error isolation + depth/dropped/latency
  metrics; a task never runs during `submit`). It cannot block/alert/delay/suppress or change any
  actionable decision. New discovery sources (real-data, abstain-safe): **earnings**
  (`discovery/earnings.ts` — today/BMO/AMC/upcoming/post-earnings/gap/abnormal-premarket-vol, confirmed-
  vs-estimated, **stale-date rejection**; NOTE the earnings *feed* is not wired server-side yet, so the
  classifier is inert until a calendar provider supplies rows) and **options-activity**
  (`discovery/options-activity.ts` — vol/OI, vol-vs-baseline, call/put skew, per-contract liquidity/
  spread/zero-bid/DTE, multi-strike; abstains on stale-chain/spread/zero-bid/insufficient/no-provenance;
  `flowClassification` is ALWAYS `unclassified_no_trade_data` — never "institutional/sweep"). Per scope:
  **news/sector-sympathy/per-user-watchlists are NOT discovery sources** (news stays enrichment-only).
  **AI shadow** (`lib/ai/shadow.ts`, `AI_SHADOW_ENABLED` OFF): AI_SHADOW_ONLY advisory classification for
  comparison only — schema-validated + deterministically post-validated (rejects foreign tickers +
  institutional-flow claims w/o provenance = hallucination), bounded queue, timeout, injected model call
  (HARD no-op without a caller → no accidental spend), latency/token/cost/abstain/hallucination metrics.
  Additive repeat-safe tables (`earnings_shadow`, `options_activity_shadow`, `ai_shadow`); dashboard
  `GET /api/research/shadow` now returns queue + earnings/options/AI metrics + flag state. Flags:
  `BROAD_DISCOVERY_SHADOW_ENABLED`, `ANALOG_LIVE_SHADOW_ENABLED`, `MARKET_CONTEXT_CAPTURE_ENABLED`,
  `AI_SHADOW_ENABLED` (all OFF). Tests: `shadow-runtime-wiring`, `discovery-sources`, `ai-shadow` (12+
  required cases). Green: 1664 tests, tsc 0, build 0. **No hard gate weakened, no alert made actionable,
  Analog + AI NOT actionable, puts RESEARCH_ONLY, no production seed, no discovery source auto-enabled.**
- 🟡 **Options product distinction + provider/AI/analog audits** (bounded step; commit pending). Audited
  the options pipeline (`docs/OPTIONS_PIPELINE_AUDIT.md`): options fire from the SAME `shouldTrigger()`
  momentum on `ZERO_DTE_UNIVERSE` + promoted names, fetch 0–1→0–5 DTE chains, rank calls+puts via
  `rankZeroDteContracts`; earnings/options-activity do NOT independently introduce candidates; paper
  trades already carry a real OCC `option_symbol` + bid/ask. Shipped (research-only, flags OFF):
  **options strategy catalog** (`lib/research/options/strategy-catalog.ts` — 18 strategies each with own
  trigger/liquidity/DTE/delta/spread/freshness/chase/stop/targets/holding/session/grading, **none
  requires +10%**; tenor buckets kept separate). **Paper-result classification**
  (`options/paper-class.ts` — EQUITY_PAPER / REAL_OPTION_PAPER / MODELED_OPTION_RESEARCH /
  UNDERLYING_PROXY_INVALID, never combined; `realOptionEntryEligible` gate). **Analog scorer loader**
  (`analog/load.ts` — fits from the stored corpus, cached, abstains WITH the exact reason when unfit;
  wired into the shadow cycle so analog shadow is never inert-silent). **AI model adapter**
  (`lib/ai/shadow-model.ts` — authoritative-only prompt + injected Anthropic caller; zero spend by
  default). Added 5 flags (`EARNINGS_DISCOVERY_ENABLED`, `OPTIONS_ACTIVITY_DISCOVERY_ENABLED`,
  `EARLY_OPTIONS_DETECTION_ENABLED`, `REAL_OPTION_PAPER_ENABLED`, `STRATEGY_IMPROVEMENT_LAB_ENABLED`) —
  all OFF. **Audits (docs):** OPTIONS_PIPELINE_AUDIT, STOCK_VS_OPTIONS_ARCHITECTURE, OPTIONS_STRATEGY_CATALOG,
  TODAY_OPTIONS_LATENCY_AUDIT (SQL method — can't read prod logs), MISSED_OPTIONS_OPPORTUNITIES,
  REAL_OPTIONS_PAPER_AUDIT, EARNINGS_PROVIDER_AUDIT (**no server-side earnings feed — BLOCKED until a
  paid calendar is wired**), OPTIONS_ACTIVITY_PROVIDER_AUDIT (snapshot supports vol/OI + skew, NEVER
  flow), FIVE_YEAR_ENTITLEMENT_AND_CORPUS_PLAN (historical options NOT entitled → option outcomes stay
  MODELED), AI_OPTIONS_SHADOW_DESIGN, CONTROLLED_OPTIONS_ROLLOUT (flag classification). Tests:
  `options-catalog-paper`. Green: 1671 tests, tsc 0, build 0. **Stock +10% rule untouched; nothing
  actionable; puts RESEARCH_ONLY; no real-money execution; no new Discord behavior; no production seed;
  no improvement claimed.**
- 🟡 **Independent Options discovery + single callout + real-option paper** (research/paper-only, flags
  OFF; commit pending). The Options scanner no longer needs the stock-radar `shouldTrigger()` or a +10%
  move. New `lib/research/options/`: **discovery.ts** (Tier-1 core list SPY/QQQ/IWM/NVDA/TSLA/AMD/AMZN/
  META/AAPL/MSFT/GOOGL/AVGO/NFLX/HOOD + Tier-2 broad-optionable gate so IREN/ASTS/RKLB/etc. enter without
  the core list; `activeSignals` early triggers that fire on forming setups, not completed moves;
  `selectOptionsStrategy` scores all 18 catalog strategies, records rejections, picks the strongest +
  direction + DTE; puts RESEARCH_ONLY unless BEARISH_ACTIONABLE). **callout.ts** (ONE message per play;
  FORMING/READY/SENT/REJECTED/TOO_LATE/EXPIRED; `formatCallout` = the exact public format; freshness/
  chase recheck → TOO_LATE, no message; underlying chase gate separated from the option premium band).
  **paper.ts** (real-option paper: conservative executable fill — 60% toward ask, never naive mid —
  option-price P&L ×100, classified REAL_OPTION_PAPER via `paper-class`; exit toward bid; separate
  `options_paper_trades` table). **loop.ts** (fire-and-forget orchestrator: deterministic path FIRST,
  AI/analog shadow AFTERWARD off the critical path; never calls the stock radar or sends Discord;
  isolated). **report.ts** + read-only `GET /api/research/options` (DISTINCT from the stock radar; split
  by strategy/side/DTE/core-vs-broad; real-option vs modeled never combined). Flags:
  `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED`, `EARLY_OPTIONS_CALLOUTS_ENABLED`, `REAL_OPTION_PAPER_ENABLED`
  (all OFF). Additive repeat-safe tables (`options_candidates`, `options_paper_trades`). Docs:
  INDEPENDENT_OPTIONS_DISCOVERY, OPTIONS_CALLOUT_RUNTIME_FLOW, REAL_OPTIONS_PAPER_EXECUTION,
  OPTIONS_LATENCY_AND_FRESHNESS, OPTIONS_FLAG_ROLLOUT. Tests: `options-discovery-loop`. Green: 1682
  tests, tsc 0, build 0. **Stock radar untouched; nothing actionable; puts RESEARCH_ONLY; no public
  Discord wired/auto-enabled; no real-money execution; no improvement claimed.** Public callout DELIVERY
  is intentionally NOT wired (formatter only) — a gated, approved delivery layer is a later step.
- 🟡 **Independent options monitoring tick wired to live data (paper/shadow only)** (commit pending).
  `loop.ts` is now driven by a dedicated in-process loop `lib/research/options/monitor.ts` (started from
  `ensureServerBoot` via `live-deps.ts`), SEPARATE from the stock radar — no `shouldTrigger()`, no +10%,
  no Discord. **Boundary decision:** in-process interval loop (not a child process) — the tick is light
  periodic provider+DB work, so a worker would only re-add seed-worker fragility. **Staged funnel:** ONE
  cheap underlying batch snapshot/cycle (Stage 1 rejects most) → option chain fetched only for justified
  symbols (Stage 2) → `runOptionsCandidate` records candidate + gated real-option paper; AI/analog
  shadow run AFTERWARD off the critical path. Guards: bounded concurrency (`OPTIONS_MAX_CONCURRENCY`),
  provider budget/min + throttle counters, per-symbol + per-strategy cooldowns, circuit breaker on
  provider failure, dedup, no-overlap, fixed-width workers (no unbounded promises). Session-aware
  cadences; premarket/AH create FORMING candidates but **real-option paper opens only in the regular
  session with a fresh quote** (never a stale prior-session quote), gated by dedup + max-concurrent +
  per-symbol exposure (`canOpenRealOptionPaper`). Health that never fails web health when disabled.
  `GET /api/research/options` extended with monitor metrics/health + active paper positions.
  **What's active:** nothing by default (all flags OFF). **Active when enabled:**
  `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED` → observe + record candidates; `REAL_OPTION_PAPER_ENABLED` →
  real-option paper (regular hours). `EARLY_OPTIONS_CALLOUTS_ENABLED` unused/unwired (no Discord).
  Feature-limited live Stage-1 (snapshot + day-change acceleration) → intentionally sparse until per-
  symbol rvol/VWAP/level/options-activity enrichment (next step). Docs: OPTIONS_MONITORING_RUNTIME,
  OPTIONS_PROVIDER_BUDGET, OPTIONS_SESSION_BEHAVIOR, OPTIONS_PAPER_COLLECTION_RUNBOOK,
  OPTIONS_RUNTIME_ROLLOUT. Tests: `options-monitor` (15 requirements). Green: 1694 tests, tsc 0, build 0.
  **Railway flags OFF; safest order INDEPENDENT→REAL_OPTION_PAPER→(later, approved) callouts; rollback =
  unset flag; stock radar untouched; puts RESEARCH_ONLY; no real-money; no public Discord; no improvement
  claimed. Evidence still required before public delivery: forward REAL_OPTION_PAPER sample + measured
  production latency + a gated approved delivery layer.**
- 🟡 **Options monitor feature enrichment (Stage 1.5 + chain features + earliness)** (commit pending).
  The independent options monitor now enriches candidates with decision-time features instead of
  snapshot-only. `lib/research/options/features.ts` (PURE, no look-ahead): from compact 1-min bars —
  rvol (+ volume-surge proxy when no baseline), VWAP + distance, HOD/LOD + proximity, nearest
  resistance/support, trend slope, momentum, velocity + acceleration, realized-vol + expansion, ATR%,
  compression/expansion, gap + continuation-vs-fade, staleness. `chain-features.ts`: call/put vol,
  vol/OI, cross-strike/expiration, NTM concentration, IV, spread dist, zero-bid rate, best-by-DTE +
  abstain-safe abnormal flag (NEVER institutional/sweep). **Staged funnel** in `monitor.ts`: Stage 1
  (cheap batch snapshot, 1 call) → Stage 1.5 (bars→features for survivors; stale bars reject) → Stage 2
  (chain only when a strategy is plausible OR options-activity independently escalates) → Stage 3
  (detailed quote for the shortlisted contract). Provider cost tracked by stage; earliness phase
  (early/during/late) + fraction-of-move recorded; the full enriched decision-time snapshot stored in
  `feature_snapshot_json` (exactly what AI/analog shadow consume — no future data). `GET
  /api/research/options` extended with stage counts, provider-by-stage, rvol/VWAP/compression
  distributions, earliness, escalations. Additive repeat-safe columns (guarded ALTER + base SCHEMA).
  Docs: OPTIONS_FEATURE_ENRICHMENT, OPTIONS_STAGE_FUNNEL, OPTIONS_STRATEGY_FEATURE_MAP,
  OPTIONS_EARLINESS_METRICS, OPTIONS_PROVIDER_COST_MODEL, ENRICHED_OPTIONS_ROLLOUT. Tests:
  `options-enrichment` (+ existing options tests updated). Green: 1703 tests, tsc 0, build 0. **Active:
  nothing by default (all flags OFF). Paper/shadow only; stock radar untouched; puts RESEARCH_ONLY; no
  real money; no public Discord; no earliness/edge claimed. Safest order: INDEPENDENT →
  OPTIONS_ACTIVITY → REAL_OPTION_PAPER → (later) analog/AI shadow. Blockers before public Discord: forward
  REAL_OPTION_PAPER sample + measured latency + earnings feed + richer level/context feeds + a gated
  approved delivery layer.**
- 🟡 **Gated private-beta options Discord delivery** (commit pending). `lib/research/options/delivery.ts`
  sends exactly ONE message to `DISCORD_WEBHOOK_OPTIONS` (reusing the approved `postToDiscord`) when BOTH
  `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1` AND `EARLY_OPTIONS_CALLOUTS_ENABLED=1`, a candidate is READY
  with a real OCC contract, and freshness/spread/chase/dedup all pass. Honest states (READY /
  SEND_ATTEMPTED / SENT / SEND_FAILED / TOO_LATE / REJECTED / EXPIRED) — **SENT only after a successful
  Discord response**; row claimed as SEND_ATTEMPTED before the request; idempotent `alertId`
  (symbol|strategy|contract|5-min bucket); no duplicate after an ambiguous timeout (retries exhausted);
  bounded retry+backoff (never on timeout/HTTP); kill switch `OPTIONS_CALLOUTS_KILL`; message carries
  `PAPER/BETA TEST — NOT FINANCIAL ADVICE`. **Puts stay RESEARCH_ONLY** → suppressed from Discord and
  counted (bearish-gate authority preserved, not weakened). Linked to the exact same OCC real-option
  paper entry. Wired fire-and-forget from `runOptionsCandidate` (isolated; a Discord failure never blocks
  the monitor). Additive repeat-safe `options_alerts` table (webhook secret NEVER stored/logged/exposed).
  `GET /api/research/options` extended with delivery metrics; token-gated `POST {action:"transport_test"}`
  sends a synthetic connectivity message (no ticker/contract, no paper/perf record). Docs:
  OPTIONS_DISCORD_PRIVATE_BETA, OPTIONS_DELIVERY_STATE_MACHINE, OPTIONS_DISCORD_ROLLOUT,
  OPTIONS_PRIVATE_BETA_RUNBOOK. Tests: `options-delivery` (14 cases). Green: 1716 tests, tsc 0, build 0.
  **All flags OFF in code; NOT auto-enabled; stock radar untouched; no real money; no real callout sent
  during implementation.** Railway activation: set `DISCORD_WEBHOOK_OPTIONS`, transport-test, then
  `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1` + `REAL_OPTION_PAPER_ENABLED=1`, then
  `EARLY_OPTIONS_CALLOUTS_ENABLED=1`. Rollback = unset the flag / `OPTIONS_CALLOUTS_KILL=1`.
- 🟡 **Options Tier-1 rejection diagnostic (evidence-only) + zero-Stage-2 root cause** (commit pending).
  Investigated the production report (14 scanned / 14 Stage-1 pass / 14 enriched / 0 candidates / 0
  Stage-2 / all distributions n=0). **Root cause (proven, not a threshold problem):** in `monitor.ts`,
  `stage15Enrich` increments before the stale check and distributions are recorded ONLY for NON-STALE
  symbols — so `stage15Enrich=14` + distributions `n=0` + `stage2=0` + `rejected=14` means **every symbol
  had `f.stale===true`** (stale/empty bars, consistent with a closed/after-hours market). Field names
  between `features.ts` and strategy scoring MATCH; no strategy needs levels/context for EVERY option;
  no field mismatch. Fixes (no thresholds loosened): added a `stage15Stale` counter; the rvol
  distribution now records the EFFECTIVE (proxy) relVolume so it isn't perpetually null once bars are
  fresh; metrics now state `distributionsScope: "all_non_stale_enriched"` (they summarize all non-stale
  Stage-1.5 enriched symbols, NOT just created candidates). New **evidence-only** diagnostic
  (`lib/research/options/diagnostic.ts`, token-gated `GET /api/research/options/diagnostic`): per Tier-1
  symbol it runs the exact enrichment path and reports snapshot, bar count + time range + freshness,
  every feature value or exact null-reason, missing features, every strategy scored (matched / required /
  missing / disqualifier / near-miss), chosen side, `wouldReachStage2`, cooldown remaining, and the exact
  final rejection — creating NO candidate/paper/Discord. It states explicitly whether the market is open
  for options and that a closed session rejecting everything is EXPECTED (re-run in regular hours to
  differ). Tests (`options-diagnostic`) reproduce the exact production state (14/14/0/0, all stale) AND
  prove fresh bars produce distribution samples. Green: 1721 tests, tsc 0, build 0. Public callouts +
  all freshness/liquidity/chase/dedup gates preserved; no thresholds changed; no fake candidates.
- 🟡 **Options autonomous runtime — grading + heartbeat + self-check + daily summary** (commit pending).
  Audited and closed the autonomy gaps so the scanner runs fully on Railway with **no daily manual
  PowerShell**; the diagnostic/`GET` endpoints are operator inspection tools only. Biggest gap fixed:
  the monitor **opened** real-option paper (`loop.ts`) but nothing **graded/closed** it — new
  `grade.ts` adds a PURE `decideOptionExit` (target `+OPTIONS_PAPER_TAKE_PROFIT_PCT` 60% / stop
  `-STOP_LOSS_PCT` 40% / expiration / time-stop `MAX_HOLD_MS` 2d), an isolated `gradeOpenOptionPositionsOnDb`
  (P&L from the OPTION price ×100; expired-without-quote closes UNPRICED `pnl=null`, never fabricated),
  and an in-process singleton `startOptionsGrader` (gated on `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1` +
  `REAL_OPTION_PAPER_ENABLED=1`, restart-safe from `status='ENTERED'` rows, never stops on error). New
  `runtime.ts`: `persistHeartbeatOnDb` (monitor upserts `options_runtime.heartbeat` each cycle → status
  survives restart), `runOptionsSelfCheck` (boot dep verification, fail-closed, **secrets never exposed**),
  `readRuntimeStatusOnDb`. New `daily-summary.ts`: `buildDailySummaryOnDb` (from DB; returns `null` when
  disabled+idle) + `maybeSendDailySummary` (once/day via `DISCORD_WEBHOOK_RECAP` fallback options,
  idempotent via `last_summary_day`, after `OPTIONS_SUMMARY_HOUR_ET`). Wired into `server-boot.ts`
  (self-check + grader, grader tick runs the summary); new repeat-safe `options_runtime` table;
  `GET /api/research/options` now also returns read-only `grading` backlog + `runtime` status (triggers no
  work). Session automation already present (`marketSession` handles weekend/holiday + premarket/AH
  cadences; real-option paper only opens in `regular`). Docs: `OPTIONS_AUTONOMOUS_RUNTIME.md`,
  `OPTIONS_SESSION_AUTOMATION.md`, `OPTIONS_RECOVERY_RUNBOOK.md`, `OPTIONS_DAILY_SUMMARY.md`. Tests
  (`options-autonomous`, 14) prove all 9 automation items: boot starts the monitor, in-process
  scan+grade with no endpoint call, stale→fresh open transition, weekend/holiday safe no-op, restart
  preserves dedup (1 webhook call across a restart), grading resumes from DB after restart, provider +
  Discord failures isolated/recover, disabled flags = clean no-op, read helpers are inspection-only.
  Green: **1735 tests, tsc 0, build 0.** No strategy entry gate loosened; no real-money execution;
  Phase G not started.
- 🟡 **Options earliness — forming-setup re-check (single-bottleneck fix)** (commit pending). Goal:
  alert while a setup is still forming, not after expansion. **Audit of the live monitor path found the
  single biggest reason alerts are late:** `monitor.ts` froze a symbol with the full `symbolCooldownMs`
  (default **60s**) on the "passed liquidity + freshness but NO plausible strategy yet" branch — i.e. a
  still-FORMING setup, the exact pre-expansion window. With a 15s Tier-1 cadence, that capped
  re-evaluation of a forming setup at once/60s, so the callout fired up to ~45–60s AFTER the setup
  validated. That cooldown does NOT provide dup protection (actual callouts are deduped by the
  per-`symbol:strategy` cooldown set only on success + the delivery `alertId` 5-min bucket), so it was
  pure accidental lateness. **Fix (one path only):** new config `symbolFormingRecheckMs`
  (`OPTIONS_SYMBOL_FORMING_RECHECK_MS`, default **0** = re-check next cadence) used ONLY on the
  forming-reject branch; all other cooldowns (Stage-1 hard reject, stale, escalation-reject, success)
  keep the full 60s. Added a `stage15Forming` observability counter (surfaced in `GET`). No executable
  gate loosened; no threshold changed; no extra alerts (only earlier re-evaluation). Tests
  (`options-earliness`, 3) prove: a forming symbol is re-evaluated at +15s and reaches Stage 2 while
  still forming; the old 60s cooldown would have skipped the same symbol at +15s (late); and stale /
  untradable symbols are still frozen 60s (executable quality unchanged). Green: **1738 tests, tsc 0,
  build 0.** Stock Momentum Radar untouched; no real-money execution; Phase G not started.
- 🟡 **Options early-detection unlock — wire decision-time levels** (commit pending). Engineering audit
  found the single biggest blocker to "find setups BEFORE they become obvious": `live-deps.ts` had
  `levelContext: () => null`, so prev-day H/L/close, premarket H/L, and opening-range H/L were never
  supplied. Every level-based EARLY strategy (breakout_proximity, compression_near_level,
  premarket_level_testing, sr_reclaim, gap behavior) was therefore structurally **dark** — only the
  momentum/acceleration strategies (which key on a move already in progress) could fire, so detection
  was during/after expansion, not before. **Fix:** new pure `levels.ts` `deriveDecisionLevels(bars,
  nowMs)` (ET/DST-aware, no look-ahead, null-safe) derives those levels from the SAME 1-minute bars the
  monitor already fetches — bumped `getBars` from 1→2 days (incl. extended hours) so prev-day/premarket
  are present, with **no extra provider call and no added alert latency** (levels come from a per-symbol
  bar cache the monitor populates via getBars in the same tick). No AI added (audit: AI is wired nowhere
  in the options path and has no forward evidence — leaving it async/absent is the honest state). No
  executable-contract gate changed. Tests (`options-levels`, 4) prove: levels derive correctly from a
  two-day bar window; missing prev-day/premarket yields nulls (no fabrication); and a stock grinding to
  fresh intraday highs just below yesterday's high fires `breakout_proximity` **only** with wired levels
  (invisible before) — i.e. genuine pre-breakout detection is unlocked. Green: **1742 tests, tsc 0,
  build 0.** Stock Momentum Radar untouched; no real-money execution; no profitability claim; Phase G
  not started.
- 🟡 **AI Research Lab DATA FOUNDATION — delivered vs research paper separation** (commit pending). Builds
  the honest data substrate the future Research Lab depends on (the Lab itself is NOT built). Structural
  rule: **DELIVERED_ALERT_PAPER** (the exact mirror of an alert that actually delivered) and
  **RESEARCH_ONLY_PAPER** (shadow/experiment) can never mix. Schema (repeat-safe guarded ALTERs on
  `options_paper_trades`): `paper_kind`, `alert_id`, `entry_source`, `experiment_id`, `experiment_variant`;
  legacy rows backfilled to `LEGACY_UNCLASSIFIED` (quarantined from BOTH lanes); two enforcement VIEWS
  `options_paper_delivered` / `options_paper_research` created after the ALTER (a view physically cannot
  return the other kind). Write paths: `deliverOptionsCallout` creates the ONE delivered mirror **only on a
  real SENT**, idempotent by `alert_id`, from the exact contract/quote/underlying/strategy/decision-timestamp
  the subscriber received (no hindsight, no improved entry); the monitor's auto-open is relabeled
  RESEARCH_ONLY_PAPER (`monitor_shadow`); `persistRealOptionPaperOnDb` **fail-safe defaults to
  RESEARCH_ONLY** so an unlabeled trade can never become a subscriber mirror. Read paths: subscriber
  performance (`report.ts` `subscriberPerformance`: winRate/avgReturn/expectancy/maxDrawdown/open/closed)
  reads the delivered view ONLY; research is reported separately and never blended; the daily summary's
  paper stats are delivered-scoped. Audited every write/read path (delivered writers idempotent; every
  subscriber-stat reader delivered-scoped; grading/exposure counts are kind-agnostic ops, not perf).
  Tests (`options-paper-foundation`, 6): exactly one linked mirror per delivered alert (idempotent across
  a restart), a FAILED send creates no mirror, a +500% research trade cannot move subscriber win
  rate/expectancy, the two views are disjoint with legacy quarantined, persist is fail-safe, puts never
  become a mirror. Migration proven repeat-safe on an existing pre-foundation DB. No Research Lab, no AI,
  no real-money, no profitability claim. Green: **1748 tests, tsc 0, build 0.**
- ⬜ Phases G–I per `docs/ANALOG_ENGINE_BUILD.md`. **Next: collect options/Phase-F/shadow live data before Phase G.**
  live recommendation cards forward, grade against real outcomes, compare to the Phase-D backtest before
  trusting any GO).

## 🏗️ MULTI-LANE RESEARCH REBUILD — completed (Phases 0–9, superseded scaffolding — FROZEN)

Design contract: `docs/ARCHITECTURE_REBUILD.md`. Baseline `ac4f045`. Every new
capability is behind a feature flag defaulting **OFF** (`lib/research/flags.ts`);
production behavior is unchanged until a flag is enabled. Full phase list + flag map
in the design doc §16.

**Phase status**

- ✅ **Phase 0 — Baseline & design contract** (commit pending). Verified clean tree /
  `main` / `ac4f045`; green baseline (1366 tests, tsc 0, build 0). Added the design
  contract, the normalized `SetupCandidate`/tier/gate/lane types (`lib/research/types.ts`,
  inert), the OFF-by-default flag resolver (`lib/research/flags.ts`), and Phase-0 tests
  (`tests/research-types.test.mjs`, 6 tests). **No existing file changed, no migrations,
  no runtime wiring.** Gates: focused 6/6 · full 1372/1372 · tsc 0 · build 0.
- ✅ **Phase 1 — SetupCandidate capture + tiering** (commit pending). Deterministic tier
  classifier (`lib/research/tiering.ts`: PRODUCTION_QUALITY / EXPERIMENTAL_VALID /
  NEAR_MISS_VALID / REJECTED_INVALID; stale-or-uncontractable ⇒ REJECTED_INVALID, never
  fillable), pure `AgentResult→SetupCandidate` adapter (`lib/research/adapter.ts`), and a
  flag-gated shadow capture layer (`lib/research/capture.ts`) writing two ADDITIVE tables
  (`setup_candidates`, `setup_gate_results`, `lib/db.ts` +63/-0, `CREATE TABLE IF NOT
  EXISTS`). Capture is a hard no-op unless `SETUP_CANDIDATE_CAPTURE_ENABLED=1` and is **not
  yet wired into the live cycle** (Phase 2 wires the router) — production byte-identical.
  Gates: focused 17/17 · full 1383/1383 · tsc 0 · build 0. Tests:
  `tests/research-tiering-capture.test.mjs` (11) incl. idempotent capture on real in-memory
  sqlite + repeat-safe DDL + flag-off no-op.
- ✅ **Phase 2 — Lane router + eligibility separation** (commit pending). Pure per-lane
  policy (`lib/research/lane-policy.ts`: Primary=PRODUCTION_QUALITY; Challenge=PROD+EXPERIMENTAL;
  Research=PROD+EXPERIMENTAL+NEAR_MISS with a defensible quote; REJECTED_INVALID never routes;
  **Discord is NOT a router lane**). Flag-gated router (`lib/research/router.ts`) with a testable
  OnDb core persists candidates + explicit per-lane routes to the additive `lane_routes` table
  (`lib/db.ts` +19). Wired into `lib/callouts/runtime.ts` (+23/-1) BEFORE Discord dedup, in the
  authoritative (`opts.deliver`) cycle only, self-gating on `LANE_ROUTER_ENABLED` (default OFF)
  → production path byte-identical; router writes only diagnostics (never Discord, never a
  trade — test-proven). Gates: focused 9/9 · full 1392/1392 · tsc 0 · build 0. Tests:
  `tests/research-router.test.mjs` (9) incl. REJECTED_INVALID never routed, Research can't enter
  Primary, no Discord lane persisted, idempotent routing, flag-off no-op.
- ✅ **Phase 3 — Independent portfolios** (commit pending). Independent Challenge + Research
  paper consumers that act ONLY on persisted routes (`lib/research/research-consumer.ts`) —
  never a Primary mirror, each filling its own portfolio via the new `createLanePaperTrade`
  entry (reuses sizing/risk/capital/READY + the existing fill/exit/grade sweep). Per-lane
  portfolio/cooldown descriptor (`lib/research/lane-portfolio.ts`), RESEARCH sizing env
  (`paper-challenge.ts researchSizingEnv`), and **per-ticker loss-pause** for the independent
  lanes via a pure `lib/research/cooldown.ts` (Primary keeps the stricter account-wide pause).
  Defect fixes: **Primary min-1 contract** (aggressive `minContractsPerTrade` 2→1) and cooldown
  isolation (cross-lane already per-portfolio; now cross-ticker too). Attribution (setup_id,
  strategy_agent, setup_tier, lane) frozen on every paper trade; additive `paper_trades` columns
  + `setup_candidates` option_bid/ask/mid (guarded ALTERs). Wired into `callouts/runtime.ts`
  after routing, authoritative cycle only, HARD no-op unless `RESEARCH_LANE_ENABLED` /
  `CHALLENGE_INDEPENDENT_ENABLED`. Gates: full 1404/1404 · tsc 0 · build 0. Tests:
  `tests/research-consumer.test.mjs` (12) — Challenge/Research create with no Primary, separate
  portfolios, REJECTED never filled, no-quote never filled, attribution passes, dedup, flag-off
  no-op, per-lane+per-ticker cooldown isolation, Primary accepts 1 contract / rejects over-cap.
- ✅ **Phase 4 — Strategy-agent framework** (commit pending). Typed `StrategyAgent` interface
  + shared `StrategyEvaluationContext` (`lib/research/strategy-agent.ts`), versioned registry
  with dedup / deterministic ordering / status filtering / capability report / per-agent
  failure isolation / flag-gated `evaluateAgents` (`lib/research/strategy-registry.ts`), and 27
  concrete agents (`lib/research/strategy-agents.ts`). 100% ADDITIVE — no existing file changed,
  no migrations, and the framework is **not wired into the production cycle** (test-proven);
  HARD no-op unless `STRATEGY_AGENTS_V2_ENABLED=1`. Agents emit normalized SetupCandidates only
  — never Discord, trades, routing, or gate bypass (structurally + test enforced). Gates:
  focused 14/14 · full 1418/1418 · tsc 0 · build 0. Tests: `tests/research-strategy-agents.test.mjs`.

  **Agent registry (27):**
  - **ACTIVE producers (10)** — options horizon adapters over the existing agents (reuse the
    shared per-ticker AgentResults; setup_id/attribution matches): `call_{0DTE,1-5,6-10,11-35,36-90}`
    (Calls) + `put_research_{…}` (Puts Research; research-only via bearish-gate→tiering→router).
  - **ACTIVE context/review (5)** — `options_liquidity_contract`, `volatility_iv_context` (context),
    `market_regime` (context), `risk_agent` (review, no trades), `data_quality` (review, cannot
    relax freshness). Emit no candidates.
  - **INACTIVE_MISSING_DATA (12)** — stock: `momentum_acceleration` (needs stock features in
    context), `breakout`, `news_catalyst`, `premarket_afterhours`, `reversal`, `sector_sympathy`;
    options: `earnings_options_research` (earnings calendar); research: `trade_review`,
    `counterfactual_review`, `pattern_discovery`, `strategy_evaluation`, `portfolio_allocation_research`
    (all need the Phase-5 ledger/graded outcomes). Each lists its exact missing fields; emits nothing.
- ✅ **Phase 5 — Research experiment ledger + counterfactuals** (commit pending). Experiment
  ledger (`lib/research/experiment-ledger.ts`): versioned/idempotent experiments with status
  DRAFT/ACTIVE/PAUSED/COMPLETED/INACTIVE_MISSING_DATA, idempotent enrollment with full
  attribution, and honest fill classification — FILLED (defensible quote → reuses Phase-3
  `createLanePaperTrade`; ONE execution model), OBSERVED_UNFILLED (valid but no defensible
  quote — never fabricated), NOT_FILLABLE_REJECTED (REJECTED_INVALID, never filled/no P&L).
  Counterfactuals (`lib/research/counterfactual.ts`): two SEPARATE concepts —
  `executable_counterfactual` (requires defensible entry; carries P&L) vs
  `market_movement_observation` (factual reached-target; win stays null, never P&L) — plus
  gate-effectiveness (winners-rejected vs losers-blocked, small samples flagged, never
  auto-alters thresholds) and per-agent strategy analytics with version attribution.
  Additive tables `research_experiments`, `research_enrollments`, `counterfactual_outcomes`
  (fills/outcomes reuse `paper_trades`). Live enrollment wrapper HARD no-op unless
  `RESEARCH_LANE_ENABLED`; not auto-wired into the cycle. Gates: focused 17/17 · full
  1435/1435 · tsc 0 · build 0. Tests: `tests/research-ledger.test.mjs`.
- ✅ **Phase 6 — AI research pipeline** (commit pending). DETERMINISTIC/statistical, advisory-
  only pipeline (`lib/research/ai-pipeline.ts`): 5 failure-isolated stages (trade_review,
  counterfactual_review [observation-only], pattern_discovery [exploratory-marked],
  strategy_evaluation [version attribution], portfolio_allocation [never concentrates weak
  evidence]) writing findings; normalized training-row builder keeping EXECUTED_TRADE /
  EXECUTABLE_COUNTERFACTUAL / MARKET_OBSERVATION / REJECTED_INVALID strictly distinct (observations/
  rejected never labeled executed-return); advisory research-model states (never PRODUCTION_ELIGIBLE
  from research alone). Human-review-only proposals (`lib/research/proposals.ts`): strict evidence
  validation, type allow-list (no bearish/puts/gate/Discord/env-mutation types), never defaults
  APPROVED, named human reviewer required, and `applyProposal` is a hard no-op (APPROVED never
  auto-applies). Additive tables `ai_research_runs`, `ai_research_findings`, `research_proposals`,
  `ai_training_rows`. Live runner HARD no-op unless `AI_RESEARCH_PIPELINE_ENABLED`; not auto-wired.
  Gates: focused 15/15 · full 1450/1450 · tsc 0 · build 0. Tests: `tests/research-ai-pipeline.test.mjs`.
- ✅ **Phase 7 — Historical replay** (commit pending). Bounded, point-in-time replay.
  `lib/research/historical-replay.ts`: deterministic, **no-look-ahead** stock replay (signal at
  bar i uses only bars[0..i]; next-bar-open fill; a closed trade depends only on bars[0..exit] —
  test-proven by appending wild future bars), documented slippage/fees, reproducible experiment ids
  (order-independent stable hash), resumable checkpoints + UNIQUE(run,symbol,entry) idempotency,
  provider-call budget. `lib/research/replay-provider.ts`: honest capability report — STOCK
  AVAILABLE via `/v2/aggs`; **OPTIONS `INACTIVE_MISSING_PROVIDER`** (historical Greeks/NBBO/OI/
  spreads not entitled; each missing field listed, never fabricated; options runs record the
  blocker and produce zero outcomes). Additive tables `replay_runs`, `replay_outcomes`. Live
  driver HARD no-op unless `HISTORICAL_REPLAY_ENABLED`; not auto-wired. Gates: focused 9/9 · full
  1459/1459 · tsc 0 · build 0. Tests: `tests/research-replay.test.mjs`.

  **Provider limitation (documented blocker):** historical OPTIONS replay cannot be truthfully
  activated — the current Polygon/Massive integration supplies only a present-time
  `/v3/snapshot/options`; historical option quotes/Greeks/NBBO/OI/spreads are not integrated or
  entitled. Options-replay infrastructure ships complete but explicitly inactive.
- ✅ **Phase 8 — Diagnostics & UI** (commit pending). Read-only research operations view.
  `lib/research/overview.ts`: pure aggregation over PERSISTED state + flag config only — 11
  failure-isolated sections (capabilities, candidate funnel, lane routing, portfolios,
  experiments, counterfactuals, gate-effectiveness, strategy agents, AI research, replay,
  session/provider) + a recursive `scrubSecrets` (drops any token/key/webhook/credential/env
  key). `app/api/research/overview/route.ts`: token-gated by the SAME shared auth (no weaker
  path), read-only, no provider calls, no mutations, fails safely. `app/research/page.tsx`:
  standalone read-only page — summary cards first (capabilities with honest ACTIVE/INACTIVE
  badges, tier counts, independent portfolios) + drill-down sections; clear empty/inactive/
  missing-provider states; **no write controls; paper-only labeling**. 100% ADDITIVE (no
  existing file modified, no migrations). Gates: focused 15/15 · full 1474/1474 · tsc 0 · build 0.
  Tests: `tests/research-overview.test.mjs` — sections separated, Discord not router-controlled,
  tiers separated, portfolios independent, rejected never filled, executable vs observation
  distinct, agents honestly inactive, AI advisory-only, options replay missing-provider,
  MARKET_CLOSED ≠ PROVIDER_ERROR, NO secret/webhook leakage, section failure isolation, route/
  module read-only guards.
  Note: shipped as a dedicated consolidated `/research` view (reachable directly). Wiring a nav
  link into the existing shell is a Phase-9 polish item.
- ✅ **Phase 9 — Cleanup & final verification** (commit pending). Legacy-path audit (all legacy
  paths gated/isolated/safe → documented, none removed: `autoEnterFromAlerts` suppressed under the
  canonical supervisor path; `maybeMirrorToChallenge` retained for `PAPER_CHALLENGE_ENABLED`
  back-compat alongside the independent consumer; `alert_tier='research'` label distinct from the
  Research lane; agents have no trade/Discord path). Documented ONE authoritative owner per concern.
  Added `docs/RESEARCH_PLATFORM_ARCHITECTURE.md`, `FEATURE_FLAGS_AND_ACTIVATION.md`,
  `OPERATIONS_RUNBOOK.md`, `MIGRATION_AND_ROLLBACK.md`, `NEXT_MARKET_SESSION_VALIDATION.md` (staged
  activation + rollback order + verification checklist + safety invariants). Docs-only; **no code
  changed, no flag enabled, no migration**. Final gates: full 1474/1474 · tsc 0 · build 0.

**🏁 REBUILD COMPLETE (Phases 0–9).** Baseline `ac4f045` (1366 tests) → final `main` (1474 tests).
Production behavior unchanged; every new capability OFF by default and safe to activate per the
staged plan. See `docs/RESEARCH_PLATFORM_ARCHITECTURE.md` for the authoritative map.

**Operational fix (post-rebuild, Stage-1 pre-activation):** a validation pass found that
`SETUP_CANDIDATE_CAPTURE_ENABLED` was a *dormant* flag — the only writer of `setup_candidates`
(`captureSetupCandidateOnDb`) was reachable only via the router (`LANE_ROUTER_ENABLED`), so "capture
only" could not run. Fixed by wiring the existing flag-gated `captureSetupCandidates` into the
authoritative `opts.deliver` cycle in `lib/callouts/runtime.ts` — capture-only now genuinely runs
under `SETUP_CANDIDATE_CAPTURE_ENABLED=1` **without** the router (no `lane_routes`) and without
touching Discord/paper. Additive, default OFF, failure-isolated, idempotent. Tests:
`tests/research-capture-wiring.test.mjs`. Full suite 1481/1481. **Stage-1 flag NOT enabled in
Railway — awaiting owner approval to activate + validate.**

**Safety invariants held every phase:** BEARISH_ACTIONABLE off; bearish-gate authoritative;
puts research-only; paper-only; no fabricated data/quotes; no polyFetch bypass; AI never
overrides deterministic gates; Discord stays selective; migrations additive+repeat-safe;
no force-push.

## Alert diagnosability + deployed-commit visibility (2026-07-15)

Audited why so few options alerts and late momentum alerts reach Discord. **The
dominant cause of both symptoms is production configuration, not scanner logic** —
and there was no persisted evidence to prove it after a restart. Findings + the
smallest safe deterministic fixes:

**Options root cause (config gate, first to check).** The supervisor options→Discord
path requires ALL of `SUPERVISOR_RUNTIME=1`, `CALLOUT_CANONICAL_PATH=supervisor`,
`AGENT_CALLOUT_DISCORD=1`, `DISCORD_WEBHOOK_OPTIONS`. With `CALLOUT_CANONICAL_PATH=supervisor`
but `AGENT_CALLOUT_DISCORD≠1`, the legacy sender stands down AND the supervisor stays
silent → **zero options alerts** even when callouts are emittable
(`lib/callouts/routing.ts:optionsDeliveryGateReason`). Bearish/puts are research-only
by design (unchanged).

**Momentum root cause.** Scanning is a **single bulk snapshot per tick over core ∪
promoted, evaluated in memory** — NOT sequential (ruled out). Real latency = discovery
cadence (15s) + promotion warmup (~10 ticks) for brand-new movers; only the top few
promoted names were ring-seeded. The a91aaae crossing latch only helps symbols already
in the 1s loop AND is **inert unless `STOCK_CALLOUTS=1`** (the whole momentum path
early-returns otherwise).

**Changes (additive; no threshold widening; no LLM in the signal path):**
- `lib/options-diagnostics.ts` + `options_diagnostics` table — ONE bounded row per
  supervisor cycle (tickers→chains→canonical→emitted→delivered + delivery-stage skips +
  the config `delivery_gate_reason`). Wired in `supervisor-cycle.ts`; funnel computed in
  `callouts/runtime.ts` (`CalloutFunnel`). Answers "how many qualified / chains fetched /
  rejected at which gate / most common reason / ACTIONABLE-but-undelivered".
- Nightly AI now **reads** both `options_diagnostics` and `momentum_diagnostics`
  (previously momentum was written-only): `queries.ts` gatherers → `nightly-summary.ts`
  digests. Config-blocked delivery sets `prioritizedIssue = options_delivery_disabled`
  (a mis-config outranks every signal issue).
- `/api/healthz` + `/api/runtime/status` now expose `commit`/`commitShort`/`branch`
  (`lib/build-info.ts`, from Railway's injected SHA) — confirm the live commit vs
  `origin/main`. healthz stays secret-free (helper import, no `process.env` in the route).
- `SCANNER_SEED_TOP_N` (default 6, bounded 0–12, budget-guarded) — seed more freshly
  promoted movers' rings so fast movers detect earlier. `optionsDeliveryGateReason`
  moved to `routing.ts` (pure, testable).
- New env: `SCANNER_SEED_TOP_N`, `OPTIONS_DIAGNOSTIC_RETENTION_DAYS`,
  `MOMENTUM_DIAGNOSTIC_RETENTION_DAYS` (all safe defaults). One-line options format,
  Discord↔paper contract identity, actionable-only delivery, and bearish/real-money
  safeguards all unchanged.

Verification: full suite **1149 pass / 0 fail** (+15 `tests/options-diagnostics.test.mjs`),
`tsc --noEmit` clean, production build OK, `options_diagnostics` migration idempotent
(SCHEMA applied twice in-test). Tests cover the funnel summarizer, the delivery-gate
reason, the config-blocked nightly prioritization, the persistence round-trip, the
bulk-snapshot (not sequential) scanning model, the seed knob, and `deployInfo`.

## First controlled AI phase — nightly diagnosis + weekly proposals (2026-07-14)

Advisory AI layer: **offline, scheduled, auditable, human-approved.** It reads
deterministic data and narrates/proposes; it never touches the live signal path,
never trades, never edits/merges/deploys code. All code lives under `lib/ai/`;
the "no LLM in the signal path" boundary is test-enforced (`architecture.test.mjs`).

**New modules (`lib/ai/`)**
- `config.ts` — env config; AI OFF by default (needs `AI_ENABLED=1` **and** a key).
- `pricing.ts` — model price table + estimated-cost math (unknown model → Opus-tier fallback).
- `provider.ts` — the ONE Anthropic abstraction over `fetch` (no SDK dep). Hard timeout,
  bounded retries, strict-JSON validation, token usage. Never throws; fails closed.
- `store.ts` — `ai_reports` / `ai_lessons` / `ai_proposals` / `ai_job_runs` read/write +
  monthly cost gate. Testable `*OnDb` cores + lazy wrappers.
- `nightly-summary.ts` (PURE) — deterministic nightly stats (calls/puts, 0DTE vs longer,
  by-strategy, time-of-day, rejection reasons + liquidity/contract classification,
  realized vs opportunity grade, signal-correct-exit-failed vs both-failed, prioritized
  issue). Empty input → 0/null, never fabricated.
- `schemas.ts` — response validators + the anti-fabrication guard (every number in the
  nightly narrative must appear in the deterministic summary).
- `prompts.ts` (PURE), `queries.ts`, `nightly.ts` (orchestration), `lessons.ts` (deterministic
  candidate lessons + dedup), `weekly.ts` (proposals), `safety.ts` (hard forbidden-intent
  screen), `schedule.ts` (ET/holiday-aware run keys), `runtime.ts` (scheduler entry),
  `overview.ts` (dashboard read model).

**Reused infrastructure (no duplicates):** the scheduler + `"scheduler"` worker lease
(`instance-lock.ts`), the DB + guarded-migration pattern, `paper_trade_outcomes` +
`paper_candidates` for evidence, `trading-session.ts` for the ET calendar, the recap
webhook in `notifications.ts`, and the `checkApiToken` API pattern. The immutable
`improvement_proposals` ledger is left as-is; AI proposals use a separate mutable-status
`ai_proposals` table because an approval workflow cannot live on a write-once ledger.

**Scheduling:** the offline jobs run **detached** from the scheduler beat (never awaited,
so a slow model call can't delay the supervisor/Discord jobs), lease-protected, idempotent
(one report per ET day/week), fail-closed. Nightly after 20:15 ET on trading weekdays;
weekly Friday ≥21:00 ET / Saturday.

**Cost controls:** per-run audit (`ai_job_runs`: model, tokens, est. cost, latency,
retries, status). Monthly soft limit warns; hard limit skips optional jobs while the
deterministic summary is still stored. Nightly uses the lower-cost model; weekly uses the
stronger one.

**Dashboard/API:** `GET/POST /api/ai` (auth-gated) + `/ai` page (flags, cost, latest
nightly, lessons, pending proposals with accept/reject). See `docs/AI_OPERATIONS.md`.

Verification: full suite **1124/1124**, tsc clean, build OK, AI migrations idempotent.
Env vars + schedules + limits documented in `docs/AI_OPERATIONS.md` and
`docs/RAILWAY_DEPLOYMENT.md`. **Nothing auto-deploys; the AI never self-approves.**

## Simplified options Discord contract line (2026-07-14)

Actionable options Discord callouts (supervisor path) are now ONE canonical line and
nothing else — no embed, greeks, confidence, targets, entry zones, or setup names:

```
$NVDA 18 JUL 26 $180 CALL $3.25
```

- **`lib/callouts/option-line.ts`** (PURE, new) — the single source for the line and the
  canonical contract identity. Reads the callout's verified `contract` (the same
  `AgentResult.selectedContract` the paper bridge trades). Price = **mid** preferred, else
  **ask** (no last-trade field). Expiration `DD MON YY`, strike minimal-decimals. Nothing is
  fabricated.
- **`lib/callouts/discord-format.ts`** — options → single content line (no embed); stock/
  momentum cards unchanged (`DiscordCalloutPayload.embed` is now optional).
- **`lib/callouts/runtime.ts`** — delivery gate blocks an actionable options alert whose exact
  contract cannot be verified (`CONTRACT DATA INCOMPLETE — <reason>`), and asserts the
  published contract equals the paper-traded contract (`sameOptionContract`). Never a generic
  options alert, never a Discord-A/paper-B mismatch.
- Routing preserved (options webhook). Tests: `tests/option-line.test.mjs` (+ updated
  `callouts` / `compact-card` / `discord-smoke`). Suite 1072/1072, tsc clean, build OK.

## Opportunity-to-expiration grading + breakout-crossing latch (2026-07-14)

Git repo: `github.com/bexgonz37/optiscan`, branch `main`. AI architecture direction is
recorded separately in `docs/AI_ARCHITECTURE_ROADMAP.md` (design only — nothing built).

### A. Opportunity-to-expiration accuracy metric
Realized grading (`trade-outcome.ts`) scores net P&L at the actual paper exit, which
usually closes well before an option expires. That undercounts whether the **callout**
was right. New, independent metric: *did the call/put ever go green enough to book a
profit at any point up to expiration?*
- **`lib/callout-opportunity.ts`** (PURE) — `gradeOpportunity` → `HIT` / `NONE` /
  `UNGRADABLE` from the lifetime peak favorable %, threshold `OPPORTUNITY_MIN_FAVORABLE_PCT`
  (default **25**). Never fabricates: no recorded peak ⇒ `UNGRADABLE`, not a guessed 0.
- **`opportunity_peak_pct`** on `paper_trades` — high-watered **past the paper exit until
  the contract expires**, reusing chains the sweep/scanner already fetch (`trackOpportunityToExpiration`
  in `paper-engine.ts`). **No extra provider calls, no status/fill/exit changes.** A ticker
  with no further chain fetches keeps its held-window peak (window reported `held`, honest).
- Lifetime peak = `max(held-window mfe, post-exit peak)`; graded on every outcome and
  exposed on the outcome read-model (`opportunity_grade`, `peak_favorable_pct`,
  `opportunity_threshold_pct`, `opportunity_window`). Guarded additive migrations +
  base-schema columns; validated idempotent.

### B. Late/missed breakout — root cause + fix
**Root cause (from the deterministic pipeline; raw NVDA per-eval records were not
available locally to confirm from stored data):** the entry gate (`entry-window.ts`) is a
single-instant snapshot and the supervisor samples it only every `SCHED_SUPERVISOR_MS`
(~30s). A fast breakout **crosses the entry band between evaluations**, so a periodic
snapshot sees `NEAR_TRIGGER` (before) then `WAIT_FOR_PULLBACK` (after) and never
`ACTIONABLE`. This is a sampling/cadence problem (root causes #1 + #3), **not** a
band-width problem.

**Why blind VWAP-band widening was rejected:** widening the always-on band would fire for
any candidate merely *sitting* at 1.5–2.1% off VWAP regardless of whether it crossed
through — i.e. it reintroduces top-of-candle chasing, the exact symptom already being
fought. The band stays at `ENTRY_MAX_VWAP_DIST_PCT` (1.5).

**Fix — deterministic breakout-crossing latch** (`lib/breakout-latch.ts`, PURE, consumed
by `entry-window.ts`, driven by `agents/runtime.ts`): two consecutive supervisor snapshots
bracket the crossing. If a prior cycle stamped the candidate as *developing* on the
favorable side within a TTL, and it is now only just past the band (≤ `CROSS_LATCH_TOLERANCE_PCT`
beyond it, always < the extended cap) and **still fully confirmed** (aligned, accelerating,
on volume, regular hours, fresh quote), rescue it to `ACTIONABLE` **once**. Guarantees:
- No band widening; the rescue requires a proven prior developing stamp.
- Hard anti-chase: rescue window is `(1.5%, 1.5%+0.6%]`; ≥ `ENTRY_EXTENDED_VWAP_DIST_PCT`
  (3%) is always `EXTENDED`/`MISSED`, never rescued.
- Fires once per episode; invalidation (reverse/extended/blocked) clears it.
- Latch state is **in-process** → empty on restart → **no post-restart ghost alerts**;
  single Railway replica so no cross-worker sharing needed.
- **No extra provider calls** (reuses existing momentum snapshots).
- Every downstream gate unchanged: risk veto, eligibility (`nowOnlyActionable`), portfolio
  ranking, emission dedup, the actionable-only Discord boundary, and the paper bridge.
- Instrumentation: `alert-timing.ts` now records `crossingRescued` + a `crossingRescues`
  summary count so future rescues are stored evidence.

### New environment variables (all have production-safe defaults)
- `OPPORTUNITY_MIN_FAVORABLE_PCT` (default 25) — profit-opportunity threshold %.
- `CROSS_LATCH_TTL_MS` (default 90000) — developing-stamp lifetime.
- `CROSS_LATCH_TOLERANCE_PCT` (default 0.6) — max |VWAP dist| beyond the band a crossing may be rescued.

### Verification baseline (2026-07-14)
- Full suite: **1059 tests, 1059 pass, 0 fail** (`node --experimental-strip-types --test tests/*.test.mjs`).
- TypeScript: `tsc --noEmit` clean. Production build: succeeds. Additive migrations: validated apply + idempotent.

### Operational notes (Railway, later)
- No action required to deploy — all new env vars default safe; the latch is in-process
  and single-replica-safe. Watch `crossingRescues` in alert-timing after go-live to confirm
  the latch is recovering real breakouts; if a faster reaction is ever wanted, `SCHED_SUPERVISOR_MS`
  can be lowered (costs more chain fetches) — the latch does not require it.
- Safety boundaries unchanged: `BEARISH_ACTIONABLE` off (puts research-only), no live
  brokerage, `IMPROVEMENT_AUTOMATION`/`IMPROVEMENT_AUTO_MERGE` off, paper stays simulated
  with real provider quotes.
## Fast-moving momentum stock callouts (2026-07-14)

Root cause: the stock callout path was deterministic but single-snapshot. A fast
non-core mover had to wait for discovery/promotion, then satisfy speed, volume,
freshness, timing, and anti-chase in the same loop snapshot. In practice, speed
could cross first, volume/relVol could confirm a few seconds later, and the move
could then be rejected as extended. Production DB records were not available
locally; existing near-miss state was in-memory only, so the fix also persists
bounded decision diagnostics.

Fix:
- `SCANNER_DISCOVERY_MS` default reduced from 30s to 15s. This adds one broad
  discovery bulk quote every 15s (roughly +2 calls/minute vs +1/minute before);
  no extra option-chain calls.
- `lib/stock-momentum-latch.ts` adds a pure, in-memory crossing latch for long
  stock momentum. It records a short-lived speed crossing while the stock is
  still inside quote freshness and anti-chase caps, then permits a stock-only
  rescue only if volume confirmation arrives before the TTL. A restart starts
  empty, so there are no ghost alerts.
- `lib/scanner-loop.ts` wires the latch without changing options behavior:
  normal `fired` still drives options during regular hours; stock-only rescues
  call only `handleStockTrigger`. Final stock capture/Discord gates still enforce
  ACTIONABLE_NOW, fresh NBBO, spread, confidence, session, VWAP/day-run anti-chase,
  duplicate cooldowns, and paper safeguards.
- `lib/momentum-diagnostics.ts` + `momentum_diagnostics` table persist bounded
  decision rows: sent/rescued/rejected/near-miss, velocity, acceleration, relVol,
  volume surge, VWAP distance, quote age, latch state, first-detected/actionable
  times, trigger latency, and strategy version. AI/learning can summarize these
  records later, but they do not influence live decisions.
- Broad threshold loosening was rejected because it would weaken anti-chase and
  spam controls. The latch is narrower: it only bridges the timing gap between
  exceptional speed and late volume confirmation.

Operational knobs: `SCANNER_DISCOVERY_MS`, `STOCK_MOMENTUM_LATCH`,
`STOCK_MOMENTUM_LATCH_TTL_MS`, `STOCK_LATCH_MIN_VELOCITY_PCT_MIN`,
`STOCK_LATCH_MIN_INSTANT_PCT_MIN`, `STOCK_LATCH_MIN_ACCEL`,
`STOCK_LATCH_MIN_VOL_SURGE`, `STOCK_LATCH_MIN_REL_VOL`,
`MOMENTUM_DIAGNOSTIC_RETENTION_DAYS`. Rollback: set `STOCK_MOMENTUM_LATCH=0`
and, if desired, set `SCANNER_DISCOVERY_MS=30000`.

Verification in this workspace: focused stock/momentum suite **65 pass**;
`tsc --noEmit` clean.

## Supervisor→Paper Bridge + now-only alerts + stock repair (2026-07-13)

Root cause (Codex audit): Supervisor canonical callouts persisted to `callout_state`
but **never created paper candidates or paper_trades** — auto-entry read only legacy
`alerts` rows (capture_action='TRADE' + option_symbol). The Supervisor flow stopped at
Discord eligibility.

- **`lib/callouts/eligibility.ts`** (PURE) — the ONE non-negotiable now-only rule
  shared by Discord + paper: `nowOnlyActionable` (HIGH tier + ACTIONABLE_NOW +
  actionable + valid/fresh two-sided quote + risk + entry window not late) and
  `paperCandidateEligibility` (adds PAPER_TRADING_ENABLED/PAPER_AUTO_ENTRY/
  PAPER_KILL_SWITCH, the 0DTE `PAPER_ALLOW_ZERO_DTE` gate, and the hard bearish
  block). Returns a precise reason for observability.
- **`lib/callouts/paper-bridge.ts`** — the authoritative bridge. `bridgeCalloutsToPaperOnDb`
  (testable core: explicit db + injected createTrade) freezes an auditable
  `paper_candidates` row (contract, quotes, underlying, confidence, setup/contract
  score, risk, lifecycle, model/evidence, callout/trigger/quote timestamps,
  idempotency key) then calls the SHARED `createPaperTrade` → READY trade → the
  EXISTING sweep does pre-entry revalidation → conservative fill → open → exit →
  graded outcome. Dedup: UNIQUE `paper:<ticker|dir|horizon>:<status>:<day>` — cycles/
  restarts/retries never double-create. Rejections stored with reason, never graded.
  Wired into `callouts/runtime.ts` ONLY when `opts.deliver` (authoritative cycle) —
  never on read-only GETs.
- **New table `paper_candidates`** (additive, repeat-safe `CREATE IF NOT EXISTS` in
  db.ts SCHEMA; UNIQUE idempotency_key).
- **Now-only Discord (§B/C):** normal options Discord uses the shared
  `nowOnlyActionable` rule. Only HIGH + ACTIONABLE_NOW + explicit ACTIONABLE entry
  window + fresh two-sided quote + passed risk can send. `EARLY_ALERTS_ENABLED`
  no longer affects normal Discord delivery, and mixed-thesis WATCH stays
  dashboard-only. Confidence stays a deterministic tier, never a probability.
- **Momentum stock repair (§D):** `lib/stock-callout.ts` (PURE) — now-only NBBO gate
  (`stockNowOnlyEligible`) + compact card (`stockCompactCard`/`formatStockCalloutDiscord`).
  NBBO threaded from scanner tape → `captureStockAlert` → `notifyNewAlert`, which now
  sends a COMPACT stock card via the **stocks** webhook only for a HIGH-confidence,
  ACTIONABLE_NOW, fresh, two-sided, acceptable-spread, long, session-permitted setup;
  everything else is dashboard-only (verified live prices; no fabricated entry).
- **Observability (§E) + timing (§F):** `paperCandidateSummary()` (+ recent rejections
  with exact reasons) surfaced in `runtime-status.ts` under `paper`. Candidate rows
  store real timestamps (callout/trigger/quote-as-of); missing → null, never inferred.
- Tests +49 (`eligibility`, `paper-bridge`, `stock-callout` + compact-card update).
  Suite: **962 pass**. tsc clean, build clean, migration repeat-safe.

### Railway variables (Phase G) — exact, do NOT enable bearish
- Supervisor options scanning: `SUPERVISOR_RUNTIME=1`.
- Supervisor options Discord: `CALLOUT_CANONICAL_PATH=supervisor`, `AGENT_CALLOUT_DISCORD=1`,
  `DISCORD_WEBHOOK_OPTIONS=<url>`.
- Momentum stock Discord: `STOCK_CALLOUTS=1`, `DISCORD_WEBHOOK_STOCKS=<url>`
  (extended hours also needs `STOCK_EXTENDED_HOURS=1` or `PAPER_STOCK_EXTENDED_HOURS=1`;
  tunable `STOCK_CLEAR_MIN_CONFIDENCE`, `STOCK_MAX_SPREAD_PCT`, `STOCK_MAX_QUOTE_AGE_MS`).
- Paper trading: `PAPER_TRADING_ENABLED` unset/≠0 (on), `PAPER_AUTO_ENTRY=1`.
- 0DTE paper: also `PAPER_ALLOW_ZERO_DTE=1` (else 0DTE candidates are blocked, surfaced).
- Kill switch (optional): `PAPER_KILL_SWITCH=1` to halt paper entries.
- Persistent SQLite: `ALERT_DB_DIR=/app/data` (Railway volume).
- Safe bearish-off production: leave `BEARISH_ACTIONABLE` unset/off (puts stay
  research-only, never paper-trade). No live execution / brokerage anywhere.
- Smoke testing: `DISCORD_SMOKE_TEST=1` (permits the dry-run smoke endpoint to send).

## Compact Trade Cards (2026-07-13) — default Discord + frontend callout

The default callout (Discord + `/callouts`) is now a COMPACT TRADE CARD, not a
technical write-up. All underlying data is preserved — technical detail just moves
behind Advanced.

- **`lib/callouts/confidence.ts`** (PURE) — the compact-card layer. Derives, from
  fields already verified on the callout: a DETERMINISTIC confidence tier
  (HIGH/MEDIUM/LOW — a setup-quality tier, **not** a win probability), the exact
  contract line, expiration/DTE, underlying price at alert time, live bid/ask/mid,
  a realistic estimated entry (matches the paper-fill model: `ask + bounded
  slippage`, capped), a plain entry status (ACTIONABLE NOW / WAIT FOR PULLBACK /
  WAIT / NO VALID ENTRY / MISSED), horizon, and ET alert time. Never fabricates a
  price; a missing/stale/crossed quote → NO VALID ENTRY (no old price shown).
- **HIGH** requires every gate: aligned + actionable, fresh & valid two-sided
  quote, acceptable spread, risk passed, and — when an entry window exists — that
  it confirm NOW (not extended/missed/invalidated/waiting/early). Only **HIGH**
  actionable setups send a normal Discord alert (`selectForDiscord` confidence
  gate); MEDIUM/LOW, early-stage ideas, and mixed-thesis WATCH stay dashboard-only.
- **`lib/callouts/discord-format.ts`** rewritten: the default embed is the compact
  card (description = Contract/Expiration/DTE/Stock/Option/Estimated entry/Status/
  Horizon/Time + the labeled setup score). The Advanced block (OCC symbol, greeks,
  OI/vol, spread%, score/rank, agent, evidence, model, risk, entry-window detail)
  is appended ONLY when `DISCORD_ADVANCED_DETAILS=1` (**default off**).
- `callout.ts` now carries `underlyingPrice`, `confidenceTier`, `estimatedEntry`,
  `entryStatusLabel`; `app/callouts/page.tsx` renders the compact card with an
  `<details>` Advanced section (collapsed by default). API already spreads the
  callout so the new fields flow to the frontend.
- Env: `DISCORD_ADVANCED_DETAILS=0` (default off). Not added to
  `.env.railway.example` (that file is permission-locked in this workspace); the
  code default already treats anything but `"1"` as off.
- Tests: +14 (`tests/compact-card.test.mjs`) proving exact strike/expiration/DTE/
  underlying/bid/ask/mid shown, estimated entry from verified quote, missing/stale
  → NO VALID ENTRY, only-HIGH-sends, medium/low dashboard-only, inactive setup
  score ≠ probability, Advanced hidden by default, no fabricated price. Existing
  `callouts`/`discord-smoke` tests updated to the compact format. Suite: 915 pass.
- Unchanged (safety): trading logic, freshness/spread/liquidity gates, risk rules,
  paper-trading rules, contract selection, bearish default, model integrity,
  no-live-execution. Confidence only *gates/labels*; it never loosens a gate.

## Forward-Looking Alert Quality (2026-07-13) — anti-late / entry-window

Root cause of "wrong / late" calls (e.g. an NVDA CALL while it was falling):
`agents/runtime.ts` fed every horizon agent EMPTY `triggerConditions`/
`invalidationConditions` and null lifecycle, so `ACTIONABLE_NOW` meant only "a
tradable contract exists during RTH" — it never checked whether the UNDERLYING
had actually set up a valid entry, already extended, or reversed.

Fix (additive, PURE core + minimal wiring):
- **`lib/entry-window.ts`** — deterministic, forward-looking entry-window model.
  From the live scanner tape (direction, VWAP distance, accel, relVol) + quote/
  spread age it returns EARLY / NEAR_TRIGGER / ACTIONABLE / WAIT_FOR_PULLBACK /
  EXTENDED / MISSED / INVALIDATED / BLOCKED, plus WAIT-FOR / VALID-ENTRY / DO-NOT-
  ENTER / CURRENTLY / ALREADY-HAPPENED language. Uses only entry-time info; no
  future data. It is the FINAL anti-late authority: a tradable contract on an
  extended/reversing/unconfirmed underlying is downgraded, never ACTIONABLE. No
  live momentum snapshot ⇒ never actionable.
- Wired through `agents/runtime.ts` → `horizon-agent.ts` → `callout.ts`. The
  callout now carries `entryState/waitFor/validEntry/doNotEnter/currently/
  alreadyHappened/timing`; `actionable` is false for any late state.
- **MISSED** status added end-to-end (types + rank); it is NOT Discord-emittable
  (visible for learning, never sent) and never actionable → never a paper entry.
- Discord redesigned forward-first (`discord-format.ts`): Trade → ⏳ Wait for →
  ✅ Valid entry (or "WAIT — NO VALID ENTRY WINDOW") → ⛔ Do not enter if → 📍
  Currently (with an ALREADY-TOO-LATE flag) → Horizon → Risk; ALREADY-HAPPENED is
  labeled context, never the entry.
- Ranking (`agents/portfolio.ts`): timing/entry-window validity now outranks
  retrospective strength — an early VALID setup beats a higher-scoring COMPLETED
  move (EXTENDED/MISSED penalized hard; ACTIONABLE rewarded). Late states are
  never selected for Discord.
- **`lib/alert-timing.ts`** — PURE quality-metrics aggregator (before/at/late,
  downgraded-to-missed, avg trigger→Discord latency, % valid window at send, %
  rejected for extension, paper fills inside vs outside window). Computes, never
  fabricates.
- Owner knobs: `ENTRY_MAX_VWAP_DIST_PCT`, `ENTRY_EXTENDED_VWAP_DIST_PCT`,
  `ENTRY_MIN_RELVOL`, `ENTRY_STALE_QUOTE_MS`, `ENTRY_MAX_SPREAD_PCT`.
- Safety unchanged: no live execution, no fabricated targets/probabilities,
  contract-selector / liquidity / spread / freshness / risk / evidence / model
  leakage protections and bearish default all preserved.

## Production Refinement Phase (2026-07-13) — quality over quantity

Goal shift: not "find every valid setup" but "find the BEST trades, send FEWER,
higher-quality alerts." All ADDITIVE and reusing the existing Supervisor / agents /
selector / risk / paper / model / statistics / lifecycle / Discord — no redesign.

- **Portfolio-manager layer** (`lib/agents/portfolio.ts`, PURE): after the base
  Supervisor dedups/vetoes, this ranks every idea by a composite quality score
  (setup + contract quality, liquidity, spread, freshness, evidence, validated
  probability, status, core-universe priority), reconciles conflicting theses per
  ticker (no simultaneous bull+bear actionables — mixed → one WATCH), applies
  anti-chase (extended ACTIONABLE → WAIT_FOR_PULLBACK), and selects only the
  strongest few for Discord. Wired into `lib/callouts/runtime.ts`; delivery is
  gated on portfolio eligibility (existing dedup/cooldown untouched).
- **Owner controls** (`lib/owner-settings.ts`, PURE, env-driven): core/priority
  tickers, max Discord alerts, min setup quality, bullish/bearish enable, early
  alerts, alert categories. Surfaced read-only in `/api/system/overview`.
- **Bearish trading** is now a first-class, owner-controllable capability behind
  `BEARISH_ACTIONABLE=1`: when enabled, bearish ideas run the SAME risk/selection
  lifecycle and quality gates as bullish (no separate weaker path, no "disabled"
  message). Default remains OFF (safe); the owner flips one flag. Model
  probability stays null for bearish (no bearish model — never fabricated).
- **Discord format** redesigned trader-first (`lib/callouts/discord-format.ts`):
  what trade / why now / underlying trigger / option entry (bid-ask-mid-spread +
  est. fill) / invalidation / horizon / risk, with stats below. Never headlines
  the OCC symbol; shows "WAIT — NO VALID ENTRY WINDOW" when there is no entry;
  never fabricates targets.
- **Stock-alert diagnosis** (§8): options run on the supervisor path; legacy stock
  alerts require `STOCK_CALLOUTS=1` (`lib/notifications.ts:317`). Added
  `stockAlertGateReason()` + surfaced it in `/api/system/overview` so the exact
  reason is visible without logs.
- Safety intact: evidence/probability/paper/lifecycle/fingerprinting/statistics/
  scheduler/supervisor/risk/dedup/contract-selection all preserved; no live
  brokerage; no fabricated probabilities or targets; freshness/risk/liquidity
  gates unchanged.

## Verification baseline (green)

| Check | Result |
|---|---|
| `npm test` | **817 pass**, 0 fail (745 through P9 + 59 live-runtime wiring + 13 Railway packaging) |
| `npx tsc --noEmit` | clean |
| `npm run build` | compiles, all static pages (1 pre-existing benign dynamic-require warning) |

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
| P9 — Controlled code-improvement agent | ✅ pushed | `8057332` |
| **Live runtime wiring (A–F)** | ✅ pushed | `5a6979b`…(this commit) |

**ROADMAP COMPLETE (P1–P9) + RUNTIME-WIRED.** Phases 5–9 are no longer on-demand
only — they run automatically from server boot via the scheduler (single-owner
worker lease), the Supervisor delivers canonical callouts through the tracked Discord
ledger, and callout lifecycle/dedup is persistent (restart-safe). See "Live Runtime
Wiring" below and `docs/RUNTIME.md`. `main` clean, tsc clean, build green.
Reusable substrate in place: `contract-selector`,
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

## Live Runtime Wiring, Discord Delivery & Scheduler — DONE

Turns the on-demand Phase 5–9 capabilities into an automatic background runtime.
Safe by default: no new env vars ⇒ legacy behavior, nothing new sent. Full ops
guide in `docs/RUNTIME.md`.

**Commit A `5a6979b` — Supervisor cycle (relevance-gated).** `lib/agents/relevance.ts`
(pure) runs only horizons the fetched chain genuinely covers (no silent widening).
`lib/agents/runtime.ts` does ONE metered 0–90 DTE chain fetch per ticker for all
horizons and threads supervisor prior-state for lifecycle hysteresis.
`lib/supervisor-cycle.ts` drives a bounded universe. OFF by default (`SUPERVISOR_RUNTIME=1`).

**Commit B `c009649` — Persistent callout lifecycle/dedup.** Additive `callout_state`
table + `lib/callouts/state-store.ts` hydrate/persist the dedup map so cooldowns and
lifecycle survive restarts/scaling — a restart never resends an unchanged callout.
`lib/callouts/material-hash.ts` (pure) hashes decision-relevant fields only.

**Commit C `4dea48c` — Real tracked Discord delivery.** `lib/callouts/routing.ts`
(pure) routes calls+puts → options webhook (puts labeled RESEARCH ONLY), stock →
stocks webhook; coexistence gating defaults to LEGACY. `notifications.deliverCalloutDiscord`
reuses the existing tracked ledger (idempotency, retries, status) — one message per
canonical opportunity/horizon, never per agent. `notifyNewAlert` stands the legacy
options path down when `CALLOUT_CANONICAL_PATH=supervisor` (no double-send).

**Commit D `3af1480` — Learning/drift scheduler + worker lease.** Generalized named
`worker_leases` (heartbeat/staleness/recovery, fake-time testable). `lib/scheduler.ts`
started from `server-boot`, single-owner, runs maintenance (sync+stats), the bounded
learning cycle (gated retrain + drift), and the supervisor cycle. `lib/scheduler-policy.ts`
(pure) clamps cadences. Never fabricates readiness.

**Commit E `c7f5a38` — Improvement audit scheduling + runtime health.** Proposal-only
improvement audit job (`IMPROVEMENT_AUDIT=1`, low frequency). `GET /api/runtime/status`
+ `lib/runtime-status.ts` aggregate worker/lease ownership, scanner/supervisor
telemetry, Discord ledger counts, learning/drift, model readiness (outcomes needed
for experimental/validated), and improvement mode — never exposing secrets.

**Commit F (this commit) — Smoke test + docs.** `lib/callouts/smoke-fixtures.ts`
(pure) + `lib/callouts/smoke.ts` + `GET /api/dev/discord-smoke` + `scripts/discord-smoke.mjs`:
disabled by default, sends only TEST/DRY-RUN-labeled fixtures (options/put-research/
stock/inactive-model/experimental-model/no-valid-contract) with zero paper/outcome/
model side effects. `docs/RUNTIME.md` documents every flag + the manual send command.

**Current live state.** Supervisor cycle + supervisor Discord delivery + improvement
audit are OFF by default (safe). The scheduler's maintenance + bounded learning jobs
run automatically; the model stays `INACTIVE_NO_TRAINABLE_DATA` until real graded
outcomes exist. To go fully live set `SUPERVISOR_RUNTIME=1`, `CALLOUT_CANONICAL_PATH=supervisor`,
`AGENT_CALLOUT_DISCORD=1`, and the webhook vars (see `docs/RUNTIME.md`).

## Railway Deployment Packaging — DONE

Packages the single-service runtime for Railway (one service, one replica, SQLite on
a persistent volume). No new trading logic. Full guides: `docs/RAILWAY_DEPLOYMENT.md`,
`docs/OPERATIONS.md`, `docs/RUNTIME.md`.

- **Production runner:** the existing `Dockerfile` builds Next.js standalone output
  and runs `node server.js` → instrumentation `register()` (production) → `ensureServerBoot()`
  starts scanner + paper engine + scheduler. (Verified empirically that plain
  `next start` does NOT boot the runtime and warns against standalone — so the image
  is authoritative.)
- **Volume safety:** new `docker-entrypoint.sh` runs as root only to `chown` the
  `/app/data` volume, then drops to the `nodejs` user via `gosu` (signal-safe). Works
  whether the mount is root- or user-owned.
- **`railway.json`:** Dockerfile builder, `numReplicas: 1`, healthcheck `/api/healthz`,
  restart on failure. Railway injects `PORT` (not hard-coded).
- **`/api/healthz`:** lightweight probe — 200 when the DB opens; never 503 for a
  closed market, inactive model, unconfigured Discord, or rate-limited provider.
  Detailed degradation stays in `/api/runtime/status`.
- **`.env.railway.example`:** full variable inventory (placeholders only) + Stage A/B/C
  profiles. **DB path:** `${ALERT_DB_DIR}/optiscan.db`, `ALERT_DB_DIR=/app/data`.
- **Staged go-live:** A (infra, everything safe/off) → B (`SUPERVISOR_RUNTIME=1`,
  observe, no sends) → C (`CALLOUT_CANONICAL_PATH=supervisor` + `AGENT_CALLOUT_DISCORD=1`,
  legacy options sender stands down — exactly one options path). Improvement automation
  stays off; puts RESEARCH_ONLY; no live brokerage.
- **Readiness tests:** `tests/deploy-readiness.test.mjs` (13) — config parses, PORT
  respected, DB-path/volume, healthcheck safety, Stage A/B/C send-gating, one replica,
  repeat-safe migration, no committed secrets, docs match code.

Node engine pinned via `.nvmrc` (20, matches the image base). SQLite → PostgreSQL
migration is documented as the trigger for multi-replica/multi-service (not done now).

_Deployment is packaging only — no external Railway deploy was performed (no account
access). The repo is ready to connect to a Railway service._

## Later phases (explicitly out of scope now)

Bearish-strategy rebuild · contract substitution on revalidation failure ·
historical-data adapter · statistical prediction models · specialized strategy
agents (each = a selector profile) · Self-Improvement Lab · optional embedded
LLM · live-broker / real-money execution.

## New tests

`tests/opportunity-lifecycle.test.mjs` (14), `tests/opportunity-persistence.test.mjs`
(6), `tests/system-health.test.mjs` (9), `tests/navigation.test.mjs` (4),
`tests/command-center.test.mjs` (5).

# OptiScan Multi-Lane Research Architecture — Design Contract

**Status:** Phase 0 (design contract). Baseline commit `ac4f045`, branch `main`.
**Owner-approved** architecture review is the source of intent; this document is the
implementation contract every subsequent phase must honor.

This is the **final structural correction**, not a patch. It is executed through small,
gated, individually-reversible phases. Every new capability ships behind a feature flag
that defaults **OFF**, so production behavior is byte-for-byte unchanged until an owner
explicitly enables a lane.

---

## 1. Target data flow

```
MARKET DATA (polygon-provider)
    ↓
SHARED FEATURE / DATA LAYER      (one timestamped snapshot per ticker/cycle; agents never re-fetch)
    ↓
INDEPENDENT STRATEGY AGENTS      (emit hypotheses only — never send Discord, never create trades)
    ↓
NORMALIZED SETUP CANDIDATES      (SetupCandidate contract — full attribution)
    ↓
DETERMINISTIC VALIDATION + TIERING   (structured gate results → setup tier; PURE)
    ↓
LANE ROUTER                      (persisted routing decision + reason codes per lane)
    ├── Production Discord        (unchanged strict eligibility; research can NEVER enter)
    ├── Primary Paper             (conservative; PRODUCTION_QUALITY only)
    ├── Challenge Paper           (independent aggressive; not a Primary mirror)
    ├── Research Experiments      (high-volume evidence; branches BEFORE Discord dedup)
    └── Historical Quant Replay   (bounded offline; honest provider limits)
    ↓
OUTCOME GRADING + ATTRIBUTION    (lane + strategy attribution preserved end-to-end)
    ↓
AI RESEARCH / PATTERN ANALYSIS   (trains on research/challenge; production tier still stricter)
    ↓
HUMAN-REVIEWED PROPOSALS ONLY    (no self-modifying production)
```

The **deterministic validation + tiering** and the **lane router** are the production
authority. Agents produce hypotheses; probabilities/AI/model outputs **never** override a
hard deterministic gate.

---

## 2. Non-negotiable safety invariants (verified by tests every phase)

- `BEARISH_ACTIONABLE` stays disabled; `bearish-gate.ts` is final authority.
- Puts remain RESEARCH_ONLY unless existing deterministic production gates allow otherwise.
- No live brokerage, no real money, no fabricated data, no synthetic quotes-as-real, no `polyFetch` bypass.
- Model/AI/probability may never override a hard deterministic gate.
- Discord stays selective; production eligibility is never loosened to raise volume.
- Research activity never leaks into Production Discord.
- Challenge and Research are paper-only.
- Historical limits represented honestly; no invented historical Greeks/NBBO/OI.
- All migrations additive + repeat-safe. No force-push, no history rewrite, no secret exposure.
- Never silently activate incomplete infrastructure — flags default OFF.

---

## 3. Normalized `SetupCandidate` contract (Phase 1)

Superset/adapter of the existing `lib/agents/types.ts:AgentResult`. Full attribution
(section spec → `lib/research/types.ts`). Required fields, where applicable:

`setupId, strategyAgent, strategyFamily, strategyVersion, agentVersion, ticker, direction,
assetClass, optionSymbol, expiration, strike, side, horizon, session, setupTier, confidence,
gateResults, rejectionReasons, freshnessState, liquidity, spreadPct, volume, openInterest,
greeks{delta,gamma,theta,vega,iv} (only when genuinely available), entryThesis,
invalidationThesis, featureSnapshot, marketRegimeContext, originatingTsMs, consumerLanes,
experimentId, modelVersion, outcome{status,mfePct,maePct,returnPct,win,exitReason}`.

The **adapter** (`AgentResult → SetupCandidate`) is a pure mapping; existing agents are not
rewritten. Greeks are copied only when the provider truly supplied them (never fabricated).

## 4. Setup tier taxonomy (Phase 1)

| Tier | Meaning | Lanes |
|---|---|---|
| `PRODUCTION_QUALITY` | passes every strict live production gate | Discord + Primary + (Challenge/Research per policy) |
| `EXPERIMENTAL_VALID` | real symbol/contract + trustworthy data; fails ≥1 production/confidence gate | Challenge + Research (per lane policy) |
| `NEAR_MISS_VALID` | valid underlying/contract; close but fails a specified threshold | Research (simulate only with a defensible real entry quote) |
| `REJECTED_INVALID` | bad contract identity, unusable/over-stale data, impossible spread, unverifiable input, or hard safety veto | **never filled**; stored for counterfactual analysis |

Classifier is **deterministic and pure** (`lib/research/tiering.ts`). AI never promotes a
tier.

## 5. Structured gate results (Phase 1, section-7 spec)

Each candidate carries a map of named gates → `{ passed: boolean, score?: number, reason?: string }`
(e.g. `freshness, liquidity, trend, risk, spread, contractIdentity, session, bearish`).
This replaces the single free-text reason and powers counterfactual gate-effectiveness
analytics (Phase 5).

## 6. Lane policies (Phase 2–3) — one policy object per lane

Each lane has its **own**: eligibility policy, freshness policy, sizing profile, cooldown
policy, exposure limits, portfolio balance, fill model, outcome ledger, analytics. No
global paper loss may freeze all tickers/lanes.

| Lane | Eligibility | Freshness | Sizing | Cooldown |
|---|---|---|---|---|
| Production Discord | `nowOnlyActionable` (unchanged) | live-actionable (unchanged) | n/a | dedup/cooldown (unchanged) |
| Primary Paper | PRODUCTION_QUALITY only | live-actionable | conservative, **min 1 contract** | per-ticker |
| Challenge Paper | PRODUCTION_QUALITY + selected EXPERIMENTAL_VALID | live-actionable | aggressive (own), min 1 | per-ticker (own) |
| Research | valid setups **before** Discord dedup; A/B/near-miss | `research` policy (accepts DELAYED / off-hours stock; options need a defensible real quote) | own, min 1 when real contract+quote exist | per-strategy + per-symbol |
| Historical Quant | offline replay only | point-in-time | documented | n/a |

**Fix wiring, not modules:** the sizer/risk engine stay pure; lanes pass their own config.

## 7. Portfolio isolation (Phase 3)

`PRIMARY`, `CHALLENGE`, `STOCK_DAY_TRADER`, and new `RESEARCH` portfolios each have an
independent balance, sizing, cooldown, positions, and analytics. **Challenge is an
independent consumer of the setup stream — not a child of `createPaperTrade`'s Primary
mirror.** (Corrects commit `7351c5d`.)

## 8. Strategy-agent framework (Phase 4)

Extensible interface + registry. Existing 10 horizon agents + stock momentum agent are
**adapted** into it. New agents are added per the approved list; any agent that cannot
truthfully operate on current provider data ships with interface+tests+diagnostics and
status `INACTIVE_MISSING_DATA`, reporting the exact missing field — never fabricated output.
Agents emit normalized candidates only.

## 9. Research ledger + counterfactuals (Phase 5)

Experiment definitions, candidate enrollment, realistic fills, non-fill/rejection tracking,
MFE/MAE/outcomes, counterfactual grading, gate-effectiveness + strategy/regime/options
analytics. Rejected/near-miss captured without pretending they were executable.
Counterfactual results never auto-alter production thresholds.

## 10. AI research pipeline (Phase 6)

Trade Review, Counterfactual Review, Pattern Discovery, Strategy Evaluation, Portfolio
Allocation Research, evidence-backed Proposals. Training rows preserve portfolio/strategy/
tier/data-quality/experiment attribution. Research-trained models stay EXPERIMENTAL until
they pass the stricter production validation tier. No self-modifying production.

## 11. Historical replay (Phase 7)

Bounded, deterministic-clock, no look-ahead. Stock: real OHLCV via `/v2/aggs`. Options:
only genuinely available contract OHLCV/metadata; **no invented Greeks/NBBO/OI/spreads**. If
truthful options replay is not entitled, ship complete infra **inactive** and report the
blocker.

## 12. Diagnostics/UI (Phase 8)

Terminal + diagnostics separate: production opportunities, Production Discord, Primary,
Challenge, Research, Historical Replay, AI Research, Proposals. Distinguish expected
MARKET_CLOSED/STALE research observations from real provider errors.

## 13. Cleanup (Phase 9)

Resolve/retire the legacy `autoEnterFromAlerts` path; remove "research == label" misnomers;
update `IMPLEMENTATION_STATUS.md`, add data-flow doc, runbook, migration + flag + rollback docs.

---

## 14. Feature flags — all default OFF/inactive (`lib/research/flags.ts`)

| Flag | Default | Gates |
|---|---|---|
| `SETUP_CANDIDATE_CAPTURE_ENABLED` | `0` | Phase 1 capture of normalized candidates (read-only shadow) |
| `LANE_ROUTER_ENABLED` | `0` | Phase 2 lane routing (production path unchanged when off) |
| `RESEARCH_LANE_ENABLED` | `0` | Phase 3/5 research paper generation |
| `CHALLENGE_INDEPENDENT_ENABLED` | `0` | Phase 3 independent Challenge consumer (falls back to current mirror when off) |
| `STRATEGY_AGENTS_V2_ENABLED` | `0` | Phase 4 new strategy-agent framework |
| `AI_RESEARCH_PIPELINE_ENABLED` | `0` | Phase 6 pipeline jobs |
| `HISTORICAL_REPLAY_ENABLED` | `0` | Phase 7 replay jobs |

Existing production flags (`PAPER_CHALLENGE_ENABLED`, `PAPER_ALLOW_ZERO_DTE`,
`OPTIONS_PUTS_ENABLED`, `BEARISH_ACTIONABLE`, `AGENT_CALLOUT_DISCORD`, …) are untouched and
keep their current semantics.

## 15. Schema migrations (additive, repeat-safe)

All new tables/columns added via the existing idempotent `migrate()` runner in `lib/db.ts`
(the `["name", "ALTER TABLE … ADD COLUMN …"]` / `CREATE TABLE IF NOT EXISTS` pattern).
Planned additive tables: `setup_candidates`, `setup_gate_results`, `lane_routes`,
`research_experiments`, `research_fills`, `counterfactual_outcomes`, `replay_runs`. No table
is dropped, renamed, or altered destructively. `portfolio` column already exists on
`paper_trades`.

## 16. Phase → capability → flag map (execution order)

0. Design contract (this doc) — no runtime change.
1. `SetupCandidate` + tiering + gate results + adapter + additive migrations (capture behind `SETUP_CANDIDATE_CAPTURE_ENABLED`).
2. Lane router + per-lane eligibility separation (`LANE_ROUTER_ENABLED`).
3. Independent Challenge + Research portfolios, per-lane sizing/cooldown, Primary min-1-contract (`CHALLENGE_INDEPENDENT_ENABLED`, `RESEARCH_LANE_ENABLED`).
4. Strategy-agent framework + adapted/new agents (`STRATEGY_AGENTS_V2_ENABLED`).
5. Research ledger + counterfactual grading.
6. AI research pipeline (`AI_RESEARCH_PIPELINE_ENABLED`).
7. Historical replay (`HISTORICAL_REPLAY_ENABLED`).
8. Diagnostics/UI separation.
9. Cleanup + docs.

Every phase runs: focused tests → full suite → `npx tsc --noEmit` → `npm run build` → diff
review → migration/secret/safety verification → commit → push → status update.

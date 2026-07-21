# Analog Engine — Build Log & Implementation Map

Authoritative design: the artifact **"The Analog Engine — Quantitative Blueprint."**
This file is the build map, cost review, blocker register, and phase resume point.
Baseline for the build: `main` @ `40e68b7` (10-phase research rebuild complete).

## Phase → codebase map (dependency order)

| Blueprint phase | New / reused code | Additive tables | Gate to advance |
|---|---|---|---|
| **A · Episode schema + labels** | `lib/research/episode/{schema,labels,leakage,store}.ts` | `setup_episodes`, `episode_labels` | leakage checks pass on adversarial fixtures; label math correct on fixtures |
| **B · Evaluation harness + baselines** | `lib/research/eval/{harness,baselines,metrics}.ts` | `eval_runs`, `eval_results` | harness reports lift on synthetic-edge data, **zero** lift on synthetic-random data |
| **C · Replay seeding** | redesign `historical-replay.ts` to emit Episodes+labels; reuse `replay_runs` checkpoint | (reuse) | survivorship-free, deduped, deterministic rebuild; sane label/regime distributions |
| **D · Tier-1 analog engine** (GATE) | `lib/research/analog/{features,similarity,retrieval,distribution}.ts` | `analog_index` (optional) | out-of-sample calibrated expectancy beats ALL §9 baselines incl. broker-visible. No lift ⇒ STOP + bounded remediation |
| **E · Options mapping + card** | `lib/research/reco/{contract,card}.ts` | `recommendations` | contracts pass hard liquidity gates; modeled flag always present; card traces to evidence |
| **F · Forward paper validation** | wire reco → existing research paper lane (flag-gated) | (reuse `paper_trades`) | forward OOS lift + calibration hold across multi-month, multi-regime |
| **G · Learning loop + clustering + decay** | `lib/research/learn/{update,cluster,decay}.ts` | `patterns`, `pattern_versions`, `pattern_state` | decay catches a synthetic-decayed pattern; updates stable not jumpy |
| **H · Tier-2/3 + ablation-gated data** | embeddings/sequence; premium data only if ablation proves lift | tbd | each addition beats predecessor OOS past multiple-testing correction |
| **I · Broker automation** | — | — | **only after** sustained forward validation (blueprint: 12+ mo, ≥1 regime change) + deterministic risk caps |

**Reuse substrate:** `setup_candidates`/`setup_gate_results` (decision-time context feed), `counterfactual_outcomes` (Zone-D observations), `ai_training_rows` (training view), `paper_trades` (Zone-C execution + MFE/MAE), `model-registry.ts`/`model-evaluation.ts` (champion/challenger scaffold), `logistic-model.ts` (baseline), `data-freshness.ts` (provenance), `bearish-gate.ts`/`options-universe-policy.ts` (authoritative deterministic gates — never overridden).
**Freeze (no investment):** lanes/challenge/strategy-agents-V2/AI-proposal machinery, `setup-fingerprint`/`setup-statistics` (weak Tier-0). **Ignore:** broker/charting parity.

## Cost review (~$500/mo)

| Expense | Classification | Note |
|---|---|---|
| Polygon/Massive data plan | **essential now** | The `/v2/aggs` history IS the memory seed — the single most **underused** asset already paid for. Do **not** cancel. |
| Railway hosting (app + SQLite volume) | **essential now** | Hosts capture + the DB (historical evidence). Do not disable. |
| Scheduler jobs: AI research / learning / improvement cadence (`SCHED_AI_CHECK_MS`, `SCHED_LEARNING_MS`, `SCHED_IMPROVEMENT_MS`) | **safe to pause / scale down** | Produce no edge today; lengthening intervals trims compute. **Env-only change — documented, not performed here; destroys no data.** |
| Lanes / Challenge / agents-V2 / AI pipeline (flags) | **already OFF** | No active cost; frozen in code. |
| Historical **options** entitlement | **unjustified until ablation** (§13) | Not entitled; options outcomes are MODELED until proven worth buying. |
| News / IV-surface history | **needed later, defer** | Premium; buy only if ablation shows lift. |
| Earnings/event calendar (historical) | **needed later (Phase C/E)** | Cheap, high context value; procure before options history. |

**No expense is disabled by this build.** Nothing that would destroy capture, historical evidence, or provider access is touched. The one recommended saving (trim non-edge scheduler cadence) is an env change for the owner, documented above.

## Blockers / contradictions register

1. **Historical options data not entitled** (`replay-provider.ts → INACTIVE_MISSING_PROVIDER`). Not a blocker: option outcomes are **MODELED** from underlying path + entry Greeks, honestly flagged. Real historical chains deferred to §13/ablation.
2. **Point-in-time universe, corporate actions, earnings calendar** — required for **Phase C** replay seeding, not Phase A/B. Procurement/verification tracked as Phase-C prerequisites; earnings calendar is a known data gap.
3. **No provider/DB access from the build environment** — Phase A/B/D are built as **pure + OnDb** logic with in-memory-sqlite tests; live seeding (Phase C) runs on Railway boot. This is why the harness (B) precedes the recommender and is validated on synthetic data.
4. **Schema relationship (not a conflict):** `setup_candidates` (live-capture shadow) and `setup_episodes` (rich memory unit) are distinct + additive. A Phase-C adapter derives episodes from candidates and from replay. Both retained.
5. **Modeled ≠ real:** every modeled option label carries `outcome_kind=MODELED_OPTION`; never merged with `EXECUTED_TRADE`/real fills; always disclosed on the card.

## Resume point
- **Now building: Phase A.** Files: `lib/research/episode/*`, additive tables `setup_episodes` + `episode_labels`, tests `tests/analog-episode-*.test.mjs`. Default OFF / not wired into the live cycle. Gate: leakage + label-math tests green + full suite/tsc/build green.

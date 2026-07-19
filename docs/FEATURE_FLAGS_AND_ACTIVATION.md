# Feature Flags & Staged Activation

**Every new capability defaults OFF.** Do NOT enable any of these automatically in Railway.
Enable one stage at a time, validate, then proceed. Production Discord strictness is never
relaxed by this sequence.

## Flag inventory (resolver: `lib/research/flags.ts`, default OFF)

| Flag | Default | Enables |
|---|---|---|
| `SETUP_CANDIDATE_CAPTURE_ENABLED` | `0` | Shadow capture of normalized candidates (read-only) |
| `LANE_ROUTER_ENABLED` | `0` | Lane routing (writes `lane_routes`; no Discord/trade effect) |
| `RESEARCH_LANE_ENABLED` | `0` | Research paper fills + experiment enrollment live wrapper |
| `CHALLENGE_INDEPENDENT_ENABLED` | `0` | Independent Challenge consumer (not the mirror) |
| `STRATEGY_AGENTS_V2_ENABLED` | `0` | Strategy-agent framework evaluation |
| `AI_RESEARCH_PIPELINE_ENABLED` | `0` | AI research pipeline runs |
| `HISTORICAL_REPLAY_ENABLED` | `0` | Historical replay driver (stock; options stays inactive) |

Existing production flags (`AGENT_CALLOUT_DISCORD`, `PAPER_AUTO_ENTRY`, `PAPER_CHALLENGE_ENABLED`,
`PAPER_ALLOW_ZERO_DTE`, `OPTIONS_PUTS_ENABLED`, `BEARISH_ACTIONABLE`, …) keep their current
semantics and are unchanged by the rebuild. **`BEARISH_ACTIONABLE` must remain off.**

## Staged activation (document only — do NOT auto-perform)

Each stage: set the flag → observe the validation window → check expected metrics → abort/rollback
if an abort condition trips (rollback = unset the flag; all writes are additive + idempotent).

**Stage 1 — Capture.** Flag: `SETUP_CANDIDATE_CAPTURE_ENABLED=1`. **Wiring:** capture-only runs in
the authoritative supervisor cycle (`callouts/runtime.ts`, inside `opts.deliver`) — it shadow-captures
the canonical agent verdicts into `setup_candidates` / `setup_gate_results` via the existing
`captureSetupCandidates` wrapper, **without** the router (no `lane_routes`) and without touching
Discord or paper. **Prerequisite:** the authoritative supervisor cycle must be running in production
(verify via `/api/runtime/status`); off-hours DATA_STALE is expected. Metric: `setup_candidates` rows
accrue during RTH; tier distribution looks sane; Discord/Primary unchanged. Abort: rows never appear
during RTH, tier skew is all REJECTED_INVALID during RTH, or any change to Discord/Primary. Rollback:
unset flag — the capture path becomes an immediate no-op (no data path depends on it).

**Stage 2 — Lane Router.** Flag: `LANE_ROUTER_ENABLED=1`. Metric: `lane_routes` populate;
`RESEARCH.routed > 0`; **Discord counts unchanged**. Abort: any change to Discord considered/
emitted/delivered. Rollback: unset flag.

**Stage 3 — Research Enrollment (no fills).** Prereq: Stages 1–2 green. Keep `RESEARCH_LANE_ENABLED=0`
but run the ledger enrollment in observe-mode via an ACTIVE experiment whose policy yields
OBSERVED_UNFILLED (or run `enrollRoutedCandidates` manually). Metric: enrollments accrue; 0 fills.
Abort: any FILLED without a defensible quote. Rollback: pause the experiment.

**Stage 4 — Research Fills.** Flag: `RESEARCH_LANE_ENABLED=1`. Metric: RESEARCH `paper_trades`
created only with a defensible quote; REJECTED_INVALID never filled; per-ticker cooldown holds.
Abort: any stale/quoteless fill, or Primary/Discord affected. Rollback: unset flag.

**Stage 5 — Independent Challenge.** Flag: `CHALLENGE_INDEPENDENT_ENABLED=1`. Metric: CHALLENGE
trades created independently of Primary; separate balance/cooldown. Abort: Challenge mirrors
Primary or shares cooldown. Rollback: unset flag (mirror path remains for back-compat).

**Stage 6 — Strategy Agents V2.** Flag: `STRATEGY_AGENTS_V2_ENABLED=1`. Metric: active producers
emit candidates matching their horizon; inactive agents emit nothing. Abort: any agent emits for a
foreign horizon or an inactive agent emits. Rollback: unset flag.

**Stage 7 — Counterfactual Analytics.** No flag (read-only). Metric: executable vs observation kept
distinct; gate-effectiveness computed. Abort: observation counted as P&L. (Read-only; nothing to roll back.)

**Stage 8 — AI Research.** Flag: `AI_RESEARCH_PIPELINE_ENABLED=1`. Metric: findings/proposals/
training rows accrue; proposals PENDING_REVIEW; nothing auto-applies. Abort: any proposal APPROVED
without a human, or any production/config change. Rollback: unset flag.

**Stage 9 — Historical Stock Replay.** Flag: `HISTORICAL_REPLAY_ENABLED=1`. Metric: bounded stock
replay runs; provider-call budget respected; options runs report INACTIVE_MISSING_PROVIDER. Abort:
provider-call budget exceeded or any look-ahead detected. Rollback: unset flag.

## Rollback order (reverse of activation)
9 → 8 → 6 → 5 → 4 → 3 → 2 → 1. Unsetting a flag makes its runtime path a hard no-op immediately;
persisted additive rows remain (harmless) and can be ignored or archived.

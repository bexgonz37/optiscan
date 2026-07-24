# OptiScan Enterprise Phase Map

_Last updated: 2026-07-24. Canonical repo: `C:\Users\bexgo\Downloads\optiscan-main`, branch `main`._

Maps the mega-prompt Phases 0–21 to existing implementation and the additive enterprise extension track. **Do not rebuild frozen substrate.**

## Already complete (reuse, do not duplicate)

| Mega phase theme | Repo equivalent | Status |
|---|---|---|
| Market context / regime foundation | Quant P3, `lib/market-context.ts`, research shadow context | DONE |
| Modular strategy agents | Quant P5, `lib/research/strategy-agent.ts`, options `strategy-catalog.ts` | DONE |
| Probability model foundation | Quant P4, `lib/model-registry.ts` (often INACTIVE_INSUFFICIENT_DATA) | DONE |
| Statistics / evidence | Quant P2, `lib/setup-statistics.ts` | DONE |
| Controlled learning / drift | Quant P7, `lib/scheduler.ts` learning cycle | DONE |
| Live runtime + Discord ledger | Runtime A–F, `lib/callouts/`, `discord_deliveries` | DONE |
| Multi-lane research | Phases 0–9, `docs/ARCHITECTURE_REBUILD.md` | FROZEN |
| Analog Engine A–E | `lib/research/analog/`, episode store | DONE |
| Independent options LIVE path | `monitor → loop → callout → delivery-decision → delivery` | DONE (flag-gated) |
| Evidence Learning (advisory) | `lib/ai/evidence-learning.ts` | DONE |
| AI Lab (advisory) | `lib/ai/*`, `app/ai/page.tsx` | DONE |

## Active gates (do not bypass)

- **Analog Phase F:** COLLECTING_DATA — no Phase G promotion without live forward evidence.
- **BEARISH_ACTIONABLE:** OFF; `bearish-gate.ts` is final authority.
- **Puts:** RESEARCH_ONLY on Discord unless explicit product flags authorize otherwise.
- **L2/L3 / historical options Greeks / earnings feed / PIT universe:** BLOCKED until licensed provider wired.

## Enterprise extension track (Phases 0–21)

| Phase | Deliverable | Primary paths |
|---|---|---|
| 0 | Audit + this map | `docs/ENTERPRISE_PHASE_MAP.md`, `IMPLEMENTATION_STATUS.md` |
| 1 | Pipeline diagnostics | `lib/research/options/pipeline-diagnostics.ts`, `/api/research/options/pipeline-health` |
| 2 | Opportunity Case | `lib/opportunity-case/*`, `opportunity_cases` table |
| 3 | Strategy contract | `lib/strategy/evaluation.ts`, catalog adapters |
| 4–5 | Library + Conductor | `lib/strategy/conductor.ts`, blocked providers |
| 6–11 | Regime, probability, contract, explanation, ranking | `lib/opportunity-case/{regime,probability,explanation,ranking}.ts` |
| 12–20 | Discord, billing INACTIVE, licensing, report cards, learning gov, briefs, replay, hardening | `lib/billing/*`, `lib/licensing/*`, `lib/opportunity-case/*` |
| 21 | Enterprise UI | `app/intelligence/*`, dossier components |

## Primary LIVE spine (extend, not replace)

```
Polygon → live-deps → monitor → discovery → loop → callout → delivery-decision → delivery → Discord
                                                                              ↓
                                                                    opportunity_cases (audit)
```

Parallel paths get **adapters only** (supervisor/agent, stock radar) — no third Discord alerter.

## Gap register (pre-extension)

| Gap | Severity | Resolution phase |
|---|---|---|
| No unified Opportunity Case | High | 2 |
| No Strategy Conductor / Ensemble Decision | High | 5 |
| End-to-end "why no alert" trace | High | 1 |
| Dual contract selectors | Medium | 9 |
| No billing / subscriber entitlements | Medium | 13 (INACTIVE until credentials) |
| No licensing enforcement layer | Medium | 14 |
| No dossier UI | Medium | 21 |
| L2/L3 strategies | Blocked | 4 (INACTIVE stubs) |

## Safety invariants (all phases)

1. Live path remains deterministic.
2. Strategies emit evidence only — never Discord.
3. Hard gates final; probabilities/AI/learning cannot override.
4. Missing data → explicit INSUFFICIENT — never neutral/zero fabrication.
5. Kelly / Monte Carlo / shadow learning → RESEARCH_ONLY or advisory.

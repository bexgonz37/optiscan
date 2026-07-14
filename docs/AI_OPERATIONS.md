# OptiScan — AI Operations

The advisory AI layer (`lib/ai/`) is **offline, scheduled, auditable, and
human-approved**. It reads deterministic OptiScan data and narrates/proposes; it
never touches the live signal path, never trades, never edits/merges/deploys code,
and never bypasses a deterministic gate. It is **OFF by default**.

See the design rationale in `AI_ARCHITECTURE_ROADMAP.md`.

---

## What it does

| Capability | When | Model tier | Output |
|---|---|---|---|
| **Nightly miss-diagnosis** | After extended-hours finalization (≥ 20:15 ET, trading weekdays) | lower-cost (narration) | Deterministic summary JSON + validated narrative → `ai_reports`; candidate `ai_lessons` |
| **Minimal lessons memory** | Written by the nightly job when evidence thresholds are met | — (deterministic) | `ai_lessons` (deduped, human accept/reject) |
| **Weekly proposals** | Friday ≥ 21:00 ET / Saturday | stronger (reasoning) | `ai_proposals` (PENDING_APPROVAL) |
| **Private recap** (optional) | After a nightly report is stored | lower-cost | One concise line to the existing recap webhook |

The **deterministic system computes every statistic first**; the model only
narrates/reasons over the summary. Every number in a stored narrative must appear
in the deterministic summary (`schemas.ts` anti-fabrication guard) or the narrative
is rejected. Empty inputs yield `0`/`null`, never invented figures.

---

## Environment variables

All AI env vars (add to the Railway service; `.env.local` for dev). Absent/`0`
values keep the feature off — the deterministic scanner/Discord/paper paths are
unaffected regardless.

| Var | Default | Meaning |
|---|---|---|
| `AI_ENABLED` | `0` | Master switch. AI does nothing unless this is `1` **and** a key is set. |
| `ANTHROPIC_API_KEY` | — | Anthropic API key. Read only from env; never logged or returned. |
| `AI_NIGHTLY_DIAGNOSIS_ENABLED` | `0` | Enable the nightly narration (requires `AI_ENABLED=1`). |
| `AI_WEEKLY_PROPOSALS_ENABLED` | `0` | Enable weekly proposals (requires `AI_ENABLED=1`). |
| `AI_RECAP_ENABLED` | `0` | Send the concise private recap (requires a configured `DISCORD_WEBHOOK_RECAP`). |
| `AI_NIGHTLY_MODEL` | `claude-haiku-4-5` | Lower-cost narration model. |
| `AI_WEEKLY_MODEL` | `claude-sonnet-5` | Stronger reasoning model for proposals. |
| `AI_RECAP_MODEL` | = nightly model | Model for recap wording (recap currently uses a deterministic template). |
| `AI_MONTHLY_SOFT_LIMIT_USD` | `5` | Warn threshold (recorded; does not stop jobs). |
| `AI_MONTHLY_HARD_LIMIT_USD` | `20` | Optional AI jobs are skipped once monthly estimated spend ≥ this. |
| `AI_MAX_INPUT_TOKENS_PER_JOB` | `60000` | Advisory input budget (prompts are summaries, kept small). |
| `AI_MAX_OUTPUT_TOKENS_PER_JOB` | `4000` | `max_tokens` per call. |
| `AI_JOB_TIMEOUT_MS` | `60000` | Hard per-call timeout. |
| `AI_MAX_RETRIES` | `2` | Bounded retries for transient / validation errors. |
| `AI_LESSON_MIN_SAMPLE` | `3` | Minimum supporting count before a finding becomes a candidate lesson. |
| `SCHED_AI_CHECK_MS` | `300000` | How often the scheduler CHECKS whether an AI job is due (not the job cadence). |

Model IDs and pricing are in `lib/ai/pricing.ts`. Cost is an **estimate** for the
guardrails/audit, not a billing figure.

---

## Estimated monthly cost

A few dozen calls/month on summarized inputs. Nightly narration (~a few K tokens
in/out at Haiku $1/$5 per MTok) is well under a cent per run; ~21 trading nights ≈
**< $0.50/mo**. Weekly proposals (~5–15K tokens at Sonnet $3/$15) ≈ a few cents each,
~4/mo ≈ **< $0.50/mo**. Realistic incremental AI spend: **~$1–5/month**, bounded hard
by `AI_MONTHLY_HARD_LIMIT_USD`.

---

## Scheduling & failure behavior

- Jobs run **in-process, detached** from the scheduler beat (`lib/scheduler.ts`
  `launchAiJobs`) so a slow model call never delays the supervisor/Discord/maintenance
  jobs. They are guarded by the existing `"scheduler"` worker lease (single owner).
- **Idempotent:** one `ai_reports` row per (`nightly`, ET-day) / (`weekly`, ISO-week).
  A restart or duplicate beat re-running the same key is a no-op.
- **Fail-closed:** the deterministic summary + lessons are stored **before** any model
  call. An AI/network/timeout/budget failure leaves them intact and never throws into
  the scheduler. The scanner, Discord callouts, paper trading, outcome grading, and
  deterministic learning continue normally.
- **America/New_York** with the exchange holiday calendar (`trading-session.ts`); the
  nightly job does not run until the extended session is finalized.

---

## Cost controls & audit

Every provider attempt (including skips) records an `ai_job_runs` row: `job_type`,
`model`, `status`, `error_category`, `input_tokens`, `output_tokens`,
`estimated_cost_usd`, `latency_ms`, `retry_count`, `month_key`. Monthly spend is the
sum over `month_key`. At the **hard limit**, optional jobs are skipped (status
`SKIPPED_HARD_LIMIT`) and the deterministic summary is still stored. Retries are
always bounded — never an infinite loop.

---

## Dashboard / API

- `GET /api/ai` — overview (flags, monthly cost, latest + historical nightly/weekly
  reports, lessons, pending/accepted/rejected proposals, job failures). Auth-gated
  (`SCAN_API_TOKEN`).
- `POST /api/ai` — human decisions and manual (idempotent, budget-gated) triggers:
  - `{ action: "decide_proposal", id, status: "ACCEPTED"|"REJECTED", notes? }`
  - `{ action: "decide_lesson", id, status, decisionState, notes? }`
  - `{ action: "run_nightly" | "run_weekly" }`
- `/ai` — private AI Lab page (minimal, reuses existing UI components).

The AI **never self-approves**. Accept/reject is always a human action.

---

## Database schema (additive; `CREATE TABLE IF NOT EXISTS`)

| Table | Purpose | Key idempotency |
|---|---|---|
| `ai_reports` | Deterministic summary (always) + validated narrative (when the model ran) | `UNIQUE(report_type, period_key)` |
| `ai_lessons` | Durable lessons memory (evidence, sample, decision state, result-after) | `UNIQUE(dedup_key)` |
| `ai_proposals` | Weekly proposals with a human approval lifecycle | `UNIQUE(dedup_key)` |
| `ai_job_runs` | Per-run cost + audit log; drives the monthly limit | indexed by `month_key`, `job_type` |

No vector store, no embeddings, no repo RAG. Proposals reference a **curated,
hand-maintained** file list (`CURATED_STRATEGY_FILES` in `lib/ai/weekly.ts`).

---

## Safety boundaries (enforced, not toggles)

- No AI in the live signal path (test-enforced in `architecture.test.mjs`).
- No AI-controlled trades, no live/real-money execution.
- No automatic code edits, merges, or deploys; `IMPROVEMENT_AUTOMATION` /
  `IMPROVEMENT_AUTO_MERGE` stay off.
- Proposals pass a hard forbidden-intent screen (`lib/ai/safety.ts`): any proposal
  that would enable bearish actionable alerts, real-money execution, auto-merge/deploy,
  or bypass a gate is **dropped**, not stored.
- No fabricated statistics — every stored number traces to a deterministic summary.
- Bearish stays research-only; puts stay research-only where required.

---

## Known limitations

- **Near-miss / alert-timing / crossing-rescue counts are best-effort.** They live in
  in-memory scanner buffers (cleared on restart), so the nightly summary reports them
  as `null` / `available:false` when unavailable rather than guessing. Authoritative
  numbers always come from persisted `paper_trade_outcomes` + `paper_candidates`.
- Cost is an estimate (token-based), not billed truth.
- The recap is a deterministic template line; optional model-written recap wording is a
  later step (roadmap §8).
- Proposals are advisory only — applying one is a manual, human-reviewed change.

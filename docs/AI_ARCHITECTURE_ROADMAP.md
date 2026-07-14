# OptiScan — AI Architecture Roadmap

**Status:** Design review / roadmap. **Nothing in this document is implemented yet.**
**Author role:** Principal AI Architect review.
**Core principle:** Deterministic trading logic is the source of truth. AI is advisory, offline, and proposal-only. AI never touches the live signal path and never trades.

---

## 1. Executive Summary

OptiScan already has the hard part right: a deterministic gate spine, a proposal-only
improvement path, a learning/model-registry scaffold, and an outcome store that only
grades filled + terminal trades. The correct AI strategy is to make that existing
skeleton **smarter and more legible to the operator** — not to bolt a "central AI
brain" onto a money system.

The single highest-ROI AI capability is **nightly miss-diagnosis**: an automated,
plain-English explanation of *why* the day's setups were missed or alerted late, and
which one deterministic knob would most have helped. That replaces the current manual
"pull the tape and diagnose by hand" loop.

The biggest risk in front of the project is **over-building the AI layer** (a central
orchestrator, repo RAG, self-editing code), not under-building it.

---

## 2. Current OptiScan Capabilities That Already Support AI-Assisted Improvement

These already exist in the codebase and are the foundation the AI layer reads from —
no new data plumbing is required to start:

- **Deterministic entry gate** (`lib/entry-window.ts`, `lib/eligibility.ts`,
  `nowOnlyActionable`) — the auditable decision spine.
- **Near-miss capture** (`lib/near-miss.ts`) — records setups that *almost* qualified
  and why they did not.
- **Alert-timing metrics** (`lib/alert-timing.ts`) — trigger-to-Discord latency,
  entry-window validity at send, downgrade/rejection counts.
- **Setup statistics** (`lib/setup-statistics.ts`) — per-setup aggregated performance.
- **Outcome store** (`lib/outcome-store.ts`) — grades only filled + terminal trades,
  idempotent.
- **Improvement agent** (`lib/improvement/`) — already proposal-only; automation off.
- **Learning scaffold** (`lib/learning/`, `lib/model-registry.ts`) — drift detection,
  retrain policy, validated/experimental model gates.
- **Scheduler with DB lease** (`lib/scheduler-policy.ts`) — the cadence mechanism the
  offline AI jobs will reuse.
- **Runtime status** (`lib/runtime-status.ts`) — explains why no trade fired.

The AI layer is a **reader and narrator** of these, plus a **proposer** into the
existing improvement path. It adds no new authority.

---

## 3. Why Deterministic Trading Gates Must Remain the Source of Truth

- **Auditability is the product.** When a setup fires (or doesn't), the operator must
  know the exact reason — a threshold, a gate, a freshness check. That is what allowed
  the VWAP entry-band root-cause diagnosis. An LLM deciding entries would make such a
  diagnosis impossible.
- **LLM failure is silent and correlated.** A bad threshold misses one setup; a
  miscalibrated model quietly biases *every* entry the same direction until the P&L
  reveals it. Unacceptable in a money system.
- **Single operator.** One person must be able to hold the decision path in their head.
  A non-deterministic decision path fails that test immediately.

Deterministic gates stay. AI explains and proposes; it does not decide.

---

## 4. Why AI Must Remain Outside the Live Signal Hot Path

- The 1-second scanner loop and the paper engine must **never** `await` an LLM call.
  Network latency and rate limits would wreck the real-time guarantees and could wedge
  the scanner or the boot health check.
- AI reads the **results** of the loop *after the fact* (batch, offline). It never sits
  inside detection, eligibility, revalidation, or fill.
- This preserves the existing, correct separation: real-time deterministic detection
  vs. offline advisory analysis.

---

## 5. Recommended Nightly Miss-Diagnosis Capability (highest ROI — build first)

- **Purpose:** After each close, explain in plain English why the day's misses and late
  alerts happened, and rank the single most effective deterministic remediation.
- **Inputs:** Summarized rows from `near-miss.ts`, `alert-timing.ts`, and graded
  outcomes — **summaries, never raw tick tape**.
- **Processing:** Clustering and attribution are mostly deterministic SQL/stats
  (e.g., "6 of 9 misses were breakouts 0.9–1.6% above VWAP that fired late"). The LLM's
  only job is **narration** — turning the numbers into an operator-readable report and a
  ranked "one knob that would have helped" recommendation.
- **Output:** A short structured Markdown report to a table (optionally the Discord
  recap channel).
- **When:** Once, after close, via the existing scheduler.
- **Model:** Lower-cost tier (narration, not reasoning).

---

## 6. Recommended Weekly Strategy-Improvement Proposal Capability

- **Purpose:** Convert repeated miss-patterns into concrete, testable config/threshold
  change proposals.
- **Inputs:** Summarized outcome statistics + the week's miss clusters.
- **Processing:** Proposal computation is deterministic (a rules engine over the stats,
  with a back-test check where history allows). The LLM adds value only in **explaining
  the tradeoff** and catching cases the rules miss.
- **Output:** A structured proposal row on the existing `improvement/` scaffold —
  proposed change, expected effect, supporting sample size, confidence. **Human approves
  or rejects. Never auto-applied.**
- **When:** Weekly (threshold changes need a week of data; daily would chase noise).
- **Model:** Mid-tier for the reasoning/explanation.

---

## 7. Minimal Knowledge / Lessons Storage

- **Purpose:** Persist what has been learned (which setups work, which thresholds were
  tried and why, and the outcome) so diagnosis and proposals compound instead of being
  re-derived nightly.
- **Shape:** A plain SQLite `lessons` table in the existing DB on the Railway volume —
  **one lesson per row**, each with its "why" and its outcome. Written as decisions are
  made; read at the start of each AI job.
- **Not** a vector store. At single-user scale (hundreds of lessons over years), the
  relevant slice is retrievable by simple structured query (by setup type, ticker,
  date). Add embeddings only if structured query ever fails to find the right lesson —
  it will not at this scale.

---

## 8. X (Twitter) Draft and Content-Generation Approach

- **Purpose:** Produce shareable post drafts for qualifying callouts, plus daily recaps.
- **Deterministic first:** Generate the X draft for **every qualifying callout from a
  deterministic template** populated with the callout's real fields (ticker, side,
  setup, levels, timing). No LLM required for the baseline draft — this guarantees the
  content can never invent a number and never fires on a non-qualifying/WAIT/WATCH state.
- **Optional LLM wording (later):** An LLM may *polish the wording* of an
  already-generated draft or write the end-of-day recap prose. It operates only on
  post-hoc, already-decided content and touches nothing in the decision path.
- **Hard constraint preserved:** Only actionable callouts produce a shareable draft;
  WAIT / WATCH / NEAR_TRIGGER / research-only states never generate outbound content.
- **Draft, not auto-post:** Drafts are queued for human review; nothing is posted
  automatically.

---

## 9. Why a Central AI Orchestrator Is Not Currently Necessary

- The AI roles are **independent, scheduled, offline jobs** that share only a read-only
  view of the database. Independent scheduled jobs need a cron cadence — which the
  existing scheduler already provides — not an orchestrator.
- An orchestrator would add a single point of failure, always-on idle cost, and
  coordination complexity to solve a coordination problem that does not exist at one
  user with a handful of nightly/weekly jobs.
- **Trigger to revisit:** only if there are ever ≥3 AI roles that genuinely must share
  reasoning and negotiate priority. Build it then, against a concrete need.

---

## 10. Why Repository RAG Is Not Currently Necessary

- The repo is a single Next.js/TypeScript codebase that fits comfortably in a modern
  context window. RAG adds an embedding store, a retrieval step, and staleness bugs to
  solve a problem (a corpus too large to fit) that does not exist here.
- For AI code reasoning, use a **hand-maintained map of decision-relevant files** plus
  the specific files a proposal touches ("changed-files + small static index"), not RAG.
- **Trigger to revisit:** only if the repo stops fitting in context.

---

## 11. Railway Deployment Approach

- **In-process, not a separate service.** Run the AI jobs as scheduled tasks inside the
  existing app, gated by the same DB lease that already prevents double-execution.
- **Scheduled, not continuous.** Fire miss-diagnosis after close, stats rollup weekly,
  recap after close. No always-on AI daemon (nothing for it to do between closes).
- **Single replica, out of the hot path.** LLM calls run as detached scheduled tasks
  with their own timeout, writing results to a table on completion — never blocking the
  scanner loop or the boot health check.
- **Escape hatch (later, if ever needed):** a Managed-Agent scheduled deployment runs
  the cron'd job off the box entirely. Keep in pocket; do not build now.

---

## 12. Model Routing Between Lower-Cost and Stronger Models

- **Lower-cost tier** — nightly miss-report narration, X-draft wording, daily recap
  prose. These are narration jobs; frontier reasoning is unnecessary.
- **Mid tier** — weekly strategy-improvement proposal reasoning and tradeoff
  explanation (the one place worth a stronger model).
- **Frontier tier** — not used for any routine job here.
- **Cost levers, in priority order:** (1) summarize before sending — never raw trades;
  (2) right-size the model per job; (3) schedule, don't poll — no idle spend;
  (4) prompt-cache the static parts (repo map, report template) so repeat jobs pay
  cache-read rates; (5) keep the deterministic model doing the numeric learning so an
  LLM is never paid to do statistics.

---

## 13. Estimated Single-User Monthly Cost

| Component            | Monthly cost | Notes |
|----------------------|--------------|-------|
| Railway hosting      | ~$5–20       | Single replica + small persistent volume. |
| Database             | ~$0          | SQLite on the Railway volume. No managed DB. |
| AI usage (the jobs)  | ~$1–10       | A few dozen calls/month on summarized inputs. |
| Market data provider | (existing)   | Already paid; not an AI cost. |
| **Incremental for AI** | **~$5–25/mo** | Dominated by hosting already paid, not AI. |

AI usage is cheap **because** the jobs are scheduled (not continuous) and consume
summarized stats (small inputs). The architecture that keeps it cheap is exactly the
scheduled/summarized/in-process one above; an always-on orchestrator with raw-trade RAG
is what would make it expensive.

---

## 14. Permanent Safety Boundaries

These are architectural invariants, not toggles. They do not expire.

- **No AI-controlled live trade decisions.** AI never decides entries, exits, or sizing.
- **No automatic production code edits.** AI proposes patches/diffs; a human applies.
- **No automatic merges.** `IMPROVEMENT_AUTOMATION` / `IMPROVEMENT_AUTO_MERGE` stay off.
- **No fabricated statistics.** Every number an AI job emits must trace to a real,
  recorded row. Empty input yields nulls, never invented figures.
- **No bypassing deterministic gates.** AI cannot relax, skip, or override any
  eligibility/freshness/liquidity/risk gate.
- **No changing the existing bearish or real-money safeguards.** `BEARISH_ACTIONABLE`
  stays off (puts remain research-only); no live brokerage; paper stays simulated with
  all signals/quotes from the real provider path.

---

## Future Implementation Sequence

1. Finish and verify the existing OptiScan roadmap.
2. Prepare Railway deployment readiness.
3. Add X drafts for every qualifying callout using deterministic templates.
4. Add nightly miss-diagnosis reporting.
5. Add minimal lessons and decision memory.
6. Add weekly strategy-improvement proposals.
7. Add optional LLM wording for X drafts and daily recaps.
8. Add proposal testing and experiment comparison later.

---

*This document is a design roadmap only. No AI feature is to be implemented until the
deterministic OptiScan roadmap is finished and verified, and each step above is
approved individually.*

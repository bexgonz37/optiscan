# Current Task Packet

Task ID: high-asymmetry-paper-lane-deploy-disabled (PAUSED — see resume point)

## Active position

- Branch: `main`
- Previous deployed commit: `6c15d3b` (docs `c9c5851` on top)
- This work: the automatic paper-trading lane, built and **DISABLED**
- Verified locally: `npm test` 2802/2802, `tsc --noEmit` clean,
  `npm run build` clean, `git diff --check` clean, `graphify update .` run

## Completed — High-Asymmetry paper lane

| Feature | Status |
| --- | --- |
| Separate lane `HIGH_ASYMMETRY_PAPER` (own tables) | BUILT_DISABLED |
| Automatic entry on EARLY_ASYMMETRY / CONFIRMING / HIGH_ASYMMETRY | BUILT_DISABLED |
| Deterministic sizing (FIXED_CONTRACT + FIXED_RISK) | BUILT_DISABLED |
| Versioned management and exits (`HIGH_ASYMMETRY_PAPER_V1`) | BUILT_DISABLED |
| Scheduler job `asymmetryPaper` (60s, clamped) | BUILT_DISABLED |
| Deterministic Quant cohorts, holdout, associations, proposals | BUILT_DISABLED |
| Daily paper report in the EOD review | BUILT_DISABLED |
| Report delivery via recap webhook | BLOCKED_CONFIG (DISCORD_RECAP_ENABLED=0, owner) |
| AI budget: 1 call/session, cached, daily+monthly limits | BUILT_DISABLED |
| Private diagnostics extended | BUILT_DISABLED |
| Owner-private send transport (defect fix) | BUILT — active as soon as a case transitions |
| Executed against a live candidate | MISSING — the radar has still never captured one |
| Subscriber SEND authority | MISSING (permanently, by design) |

## Feature flags

- `HIGH_ASYMMETRY_CAPTURE_ENABLED` — **enabled** (unchanged)
- `HIGH_ASYMMETRY_PRIVATE_ENABLED` — **enabled** (unchanged)
- `HIGH_ASYMMETRY_PRIVATE_WEBHOOK` — **configured** (unchanged, never displayed)
- `HIGH_ASYMMETRY_PAPER_ENABLED` — **NOT SET. Requires owner approval.**

I changed no Railway variable. The paper lane ships inert.

## The defect this work uncovered

`notifyPrivateAsymmetry` takes an OPTIONAL injected `send` and the scheduler
never injected one, so every owner-private notification returned
`NOT_CONFIGURED` while diagnostics reported `enabled: true,
webhookConfigured: true`. **No private message could have been delivered on
Friday.** Fixed and covered by `tests/high-asymmetry-private-send.test.mjs`.

This is the same class of failure the acceptance gate exists to catch — a
module that exists, type-checks, and is fully unit-tested but is not reachable
from anything that runs. The unit tests all injected a sender, so none of them
could see it.

## Second defect — MY defect, found by deploying

The daily paper report was delivered to the recap Discord channel on the first
EOD tick after deploy, without anyone enabling the paper lane.

Two mistakes compounded:

1. `resolveReportDelivery` read the raw `DISCORD_WEBHOOK_RECAP` URL. Production
   also sets `DISCORD_RECAP_ENABLED=0` — the owner's kill switch, and the
   reason `/api/discord/health` reports `recap: false` while the URL is
   present. Reading a webhook URL is not the same as being allowed to use it.
2. The delivery hook hangs off the EOD job, which is gated by CAPTURE, not by
   `HIGH_ASYMMETRY_PAPER_ENABLED`. So a deploy alone was enough to fire it.

It also bypassed `postToDiscord`, so the send never reached the delivery
ledger: `/api/discord/health` still reports `sent24h: 2` against the pre-deploy
baseline. The message was real; the ledger simply never saw it. **Do not treat
that ledger as proof of what this lane has sent.**

Fixed in `15dff21`: both gates are checked before the URL is looked up, with
regression tests written against the exact configuration that shipped.

The lesson to keep: a new outward-facing path must be gated on its OWN feature
flag, not merely inherit the gate of whatever job it was attached to.

## What remains unproven

- **The radar has never executed against a live candidate. Zero cases exist, so
  zero paper positions exist and none of the five paper tables has been created
  on the production volume.**
- Everything in the lane is proven by unit test and by source-level graph
  acceptance. None of it has run against a real quote.
- The OCC-matching question is still open and now matters twice: if
  `fetchOptionChain` returns a contract whose `optionSymbol` does not match the
  stored OCC, both `markRejections` AND the paper lane's entry will fill with
  NO_QUOTE / WRONG_OCC. Safe, but zero positions and zero graded outcomes.
- The private send path has never actually posted a message.

## Pre-session OCC analysis (2026-07-31 01:45 ET, before the open)

The open question has been "will the stored OCC match what the provider
returns". Static tracing narrows it considerably:

- Capture stores `res.contract.optionSymbol`, produced by `mapOptionContracts`.
- `getQuote` matches with `mapOptionContracts(...).find(x => x.optionSymbol === optionSymbol)`.

Same producer, same field, exact string equality. The FORMAT will match.

The windows differ, and that is the part to watch:

| Path | DTE | maxPages |
| --- | --- | --- |
| capture (`getChain`) — stores the OCC | 0-14 | 2 |
| `getQuote` — marks and paper | 0-60 | 3 |

A wider window is not automatically safer: 0-60 returns far more contracts than
0-14, so a 3-page cap could in principle truncate before reaching the target.
Polygon's snapshot pages are ordered by option ticker, and an OCC encodes the
expiration immediately after the underlying, so alphabetical order approximates
expiration ascending and a 0-14 contract should land in the first pages. That
is reasoning about ordering, NOT a guarantee from the provider.

**If NO_QUOTE dominates on Friday, this pagination/window mismatch is the
leading hypothesis, and the smallest safe fix is to align `getQuote`'s window
with capture's rather than to raise page counts.** Do not pre-emptively change
it: the gate must observe the real behaviour first.

## Exact next bounded checkpoint — AUTOMATIC, NO HUMAN REQUIRED

Task ID: `high-asymmetry-automatic-activation`

Activation no longer needs Claude, a terminal, or the owner's computer. The
scheduler proves the quote path and flips a PERSISTED state on its own.

### Two independent locks

A paper entry requires BOTH. Either alone opens nothing.

1. `HIGH_ASYMMETRY_PAPER_ENABLED=1` — the owner's master authorization
2. persisted activation state `ACTIVE` — the machine's own live proof

`activationActive` defaults to FALSE in the entry writer, so a caller that
forgets to pass it cannot open a position by omission.

### States

`DISABLED` (no master flag) · `ARMED_WAITING_FOR_LIVE_PROOF` · `ACTIVE` ·
`BLOCKED_INSUFFICIENT_EVIDENCE` · `BLOCKED_QUOTE_PATH_DEFECT`

Per trading day. A quote path that worked yesterday proves nothing about today,
so each session re-arms and must re-prove itself.

### What the gate proves

ONE query: a case joined to a mark on the same session AND the same
`option_symbol`, where the case had a fresh ask, the mark has a real bid, and
the mark came LATER than detection. Conditions 2-5 hold simultaneously or not
at all — checking them separately would admit a combination that never
co-occurred.

The gate makes NO provider call of its own. It judges the marks the real
mark-runner produced, so it cannot pass on a parallel path that succeeds where
production fails.

### Classification is deliberate about blame

- dominant `WRONG_OCC` or `NO_QUOTE` over >= 6 attempts, zero accepted
  -> `BLOCKED_QUOTE_PATH_DEFECT` + one owner-private notice
- dominant `PROVIDER_ERROR` -> `INSUFFICIENT`, NOT a defect. An outage must not
  send anyone to change code that is correct.
- thin data -> stays `ARMED`, retries until 11:30 ET, criteria never relaxed
- past 11:30 ET without proof -> `BLOCKED_INSUFFICIENT_EVIDENCE` + one notice

### Window and cadence

09:40-11:30 ET, checked every 2 minutes (clamped), gate job ordered BEFORE the
paper sweep so activation and the day's first entry can land on the same beat.
Before 09:40 the gate refuses outright — an equity premarket print must never
be mistaken for proof that the OPTION quote path works.

### Idempotency

The activation UPDATE is guarded on the row still being `ARMED`. Repeated ticks
and concurrent processes produce exactly one winner, a block cannot demote an
ACTIVE day, arming cannot overwrite a state today already reached, and a
redeploy re-reads the state rather than re-proving it. All asserted by test.

### What the owner must do

Set exactly one variable, tonight:

    HIGH_ASYMMETRY_PAPER_ENABLED=1

Expected immediately after: `activationState: ARMED_WAITING_FOR_LIVE_PROOF`,
`paperEntriesAllowed: false`, `nextGateCheck` counting down to 09:40 ET.

Tomorrow the system verifies and activates by itself, or blocks itself with a
persisted reason and one owner-private message. No computer needs to be on.

### Where to look afterwards

`/api/research/asymmetry/live` -> `paperActivation`:
`masterPaperAuthorized`, `activationState`, `paperEntriesAllowed`,
`activationTimestamp`, `nextGateCheck`, `gateAttempts`, `gateEvidence`,
`gateBlockReason`, `firstAcceptedAsk`, `firstAcceptedBid`.

If it reads `BLOCKED_QUOTE_PATH_DEFECT`, the pre-session hypothesis above
(capture 0-14 DTE / 2 pages vs getQuote 0-60 DTE / 3 pages) is the first thing
to check, and the smallest safe fix is aligning the windows — NOT raising page
counts.

## Stop conditions

- do not set any Railway variable without explicit owner approval
- do not enable `HIGH_ASYMMETRY_PAPER_ENABLED` as part of verification
- do not send any Discord test message
- do not touch trading gates, ranking, or subscriber delivery
- do not stage Obsidian line-ending noise, `graph.json`, `workspace.json`,
  `graphify-out/`, or unrelated files
- do not use `git add .`, `git reset`, or force-push
- do not describe the paper lane as active: it is built and disabled, and has
  never opened a position

## Relevant notes

- [[../02 Components/High-Asymmetry Radar]]
- [[../02 Components/safety]]
- [[../02 Components/deployment]]
- [[../02 Components/Discord Alerts]]
- [[../02 Components/AI Learning System]]

# Current Task Packet

Task ID: high-asymmetry-paper-lane-deploy-disabled

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

## Exact next bounded checkpoint

1. Deploy with `HIGH_ASYMMETRY_PAPER_ENABLED` unset. Verify:
   - `/api/research/asymmetry/live` returns `paperTrading.enabled: false`
   - the `asymmetryPaper` job is registered and reports the flag reason
   - Discord byte-identical to baseline; scanner unaffected
2. Observe the first live session with the paper lane still DISABLED.
3. Only then request approval for `HIGH_ASYMMETRY_PAPER_ENABLED=1`.

Watch, in order, during the first live session:
1. `activeCases` non-zero — the live call site fires.
2. `markRejections` — NO_QUOTE means the OCC does not match; PROVIDER_ERROR
   means an outage.
3. `privateNotification.notifiedCount` — the first message the fix makes
   possible.
4. After 20:15 ET, the EOD review persists with the paper section present and
   `deliveryStatus: BLOCKED_CONFIG`.

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

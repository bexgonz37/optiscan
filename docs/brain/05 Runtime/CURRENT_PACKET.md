# Current Task Packet

Task ID: high-asymmetry-observe-first-live-session

## Active position

- Branch: `feature/high-asymmetry-radar`, merged with `origin/main`
- `origin/main` before this work: `49b2174`
- Merged and deployed commit: **`cdfcfc7`** (deployment `5686432103`, success)
- Production verified inert on 2026-07-31

## Completed — production hardening (already live on main)

| Commit | Concern | Status |
| --- | --- | --- |
| `08bb849` | Browser connection-pool exhaustion (poll guard) | LIVE_AND_VERIFIED |
| `0b67ba8` | `/api/now` alert-lookup indexes (14s → 2.5s p95 3.06s) | LIVE_AND_VERIFIED |
| `cb89c03` | Discord panel authenticated reads | LIVE_AND_VERIFIED |
| `be68a12` | Watchlist copy signed-move fix | DEPLOYED_UNPROVEN |

All four survived the merge, verified by grep for their distinguishing symbols.

## Completed — High-Asymmetry runtime graph

Every node has a real caller or scheduler. All five tables have both a writer
and a reader. Off by default at every stage.

| Feature | Status |
| --- | --- |
| Live call site in `options/loop.ts` | BUILT_DISABLED |
| Shadow-case persistence (5 additive tables) | BUILT_DISABLED |
| Transition runner + scheduler (`asymmetryTransitions`, 60s) | BUILT_DISABLED |
| Owner-private notifier wiring | BUILT_DISABLED |
| Forward marks + scheduler (`asymmetryMarks`, 60s due-work) | BUILT_DISABLED |
| Outcome aggregation | BUILT_DISABLED |
| EOD Quant review (`asymmetryEod`, hourly) | BUILT_DISABLED |
| AI advisory (injected, post-persistence) | BUILT_DISABLED |
| Private diagnostics route | BUILT_DISABLED |
| Verified quote provider | BUILT_DISABLED |
| Merged to main and deployed | LIVE_AND_VERIFIED (disabled) |
| Executed against a live candidate | MISSING |
| Asymmetry tables on the production volume | MISSING (created lazily on first enabled write — correct) |
| Subscriber SEND authority | MISSING (permanently, by design) |

## Feature flags — all unset

- `HIGH_ASYMMETRY_CAPTURE_ENABLED` — unset. Gates capture, transitions, marks,
  and the EOD review. Unset means the entire radar does zero work.
- `HIGH_ASYMMETRY_PRIVATE_ENABLED` — unset.
- `HIGH_ASYMMETRY_PRIVATE_WEBHOOK` — unset.

None has been created or set. Capture is deliberately separate from
notification so the radar can collect silently before anything is surfaced.

## What remains unproven

- **The radar has never executed against a live candidate. Zero cases exist.**
- The quote provider is verified at the INTERFACE level — the export exists,
  arity is 2, `providerTimestamp` is mapped to the field `validateMark` reads,
  and `PROVIDER_ERROR` is distinct from `NO_QUOTE` — but it has never been
  called against the live chain. Whether `fetchOptionChain` returns a contract
  whose `optionSymbol` matches a stored OCC exactly is untested in production.
  If it does not, marks record `NO_QUOTE`: safe, but zero graded outcomes.
- Graphify cannot prove the three scheduler → runner edges. The scheduler uses
  dynamic `require()` (26 of them, the convention for every job in that file),
  which the AST extractor cannot resolve; the pre-existing
  `watchlistPlanningJob` shows the identical artefact. Those edges are proven by
  source and tests instead, not by a multi-hop Graphify path.

## Exact next bounded checkpoint

Observe one live session with the radar DISABLED, then decide on activation.

Steps 1 and 2 are DONE and verified in production at `cdfcfc7`:
- all three scheduler jobs ran and declined with the exact flag reason, errors []
- diagnostics 200, zero cases, `canSendSubscriber false`, no webhook exposed
- Discord byte-identical to baseline (sent24h 2, same lastSentAt); nothing sent
- scanner `running: true`; all seven routes 200

Remaining: request owner approval for the three variables, then observe ONE live
session with capture enabled and notification still off, before surfacing
anything.

## Stop conditions

- do not set any Railway variable without explicit owner approval
- do not enable capture or private notification as part of verification
- do not send any Discord test message
- do not touch trading gates, ranking, or subscriber delivery
- do not stage Obsidian line-ending noise, `graph.json`, `workspace.json`,
  `graphify-out/`, or unrelated files
- do not describe the radar as active: it is built and disabled, and has never
  observed a live candidate

## Relevant notes

- [[../02 Components/High-Asymmetry Radar]]
- [[../02 Components/safety]]
- [[../02 Components/deployment]]
- [[../02 Components/Discord Alerts]]

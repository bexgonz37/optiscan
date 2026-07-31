# Current Task Packet

Task ID: observe-watchlist-copy-and-professional-window

## Active position

- Repo: `C:\Users\bexgo\Downloads\optiscan-main`, branch `main`
- Local HEAD: `be68a12`
- `origin/main`: `be68a12`
- Deployed production commit: **`be68a12`**

## Completed this session

Four separate commits, each one concern, each pushed and deployed:

| Commit | Concern | Status |
| --- | --- | --- |
| `08bb849` | Browser connection-pool exhaustion (poll guard) | LIVE_AND_VERIFIED |
| `0b67ba8` | `/api/now` alert-lookup indexes | LIVE_AND_VERIFIED |
| `cb89c03` | Discord panel authenticated reads | DEPLOYED_UNPROVEN |
| `be68a12` | Next-session Watchlist copy sign fix | DEPLOYED_UNPROVEN |

## Verified locally

- `08bb849`: 10/10 focused, 2510/2510 full
- `0b67ba8`: 7/7 focused, 2517/2517 full
- `cb89c03`: 8/8 focused, 2525/2525 full
- `be68a12`: 9/9 focused, **2534/2534** full
- Every commit: tsc clean, build clean, `git diff --check` clean

## Verified in production

- `/api/healthz` serves `be68a12`, `schemaOk: true`, `schemaMissing: []`,
  `lifecycle.active: true`
- `/api/now` latency after the index fix: median **2.49s**, p95 **3.06s**,
  measured over 10 requests (was 13–15s). First request after a deploy is
  ~20s cold.
- All seven routes return 200: `/`, `/watchlist`, `/callouts`, `/quant`,
  `/discord`, `/paper`, `/ai`
- Poll-guard soak: `/watchlist` held ~3.5 min produced 11 requests, all 200,
  **zero pending** — previously multiple concurrent `/api/now` hung forever

## What remains unproven

- **`cb89c03`** — the Discord panel fix is deployed but I have NOT re-opened
  `/discord` in a browser to confirm Options/Watchlist now read CONFIGURED and
  the ledger shows real sends. Only the render contract is unit-tested.
- **`be68a12`** — the corrected copy has NOT appeared in a real Discord
  message. Verified from a deterministic fixture only. Next real send is the
  18:00 ET window.
- The professional Watchlist has still never built or published in production.
  It has only been observed declining at the flag gate.

## Feature status

| Feature | Status |
| --- | --- |
| Poll guard / connection-pool fix | LIVE_AND_VERIFIED |
| `/api/now` indexes | LIVE_AND_VERIFIED |
| Discord panel authenticated reads | DEPLOYED_UNPROVEN |
| Next-session Watchlist copy | DEPLOYED_UNPROVEN |
| Legacy next-session Watchlist plan | LIVE_AND_VERIFIED (5 rows, sent 18:01 ET) |
| Professional Watchlist | DEPLOYED_UNPROVEN (flag off, never published) |
| Daily recap | MISSING (webhook never configured, zero sends ever) |
| Earlier-entry / loss-protection research | RESEARCH_ONLY |
| High-Asymmetry private notify (other worktree) | BUILT_DISABLED |

## Feature flags

- Disabled: `PROFESSIONAL_WATCHLIST_ENABLED` (unset)
- Unset: `DISCORD_WEBHOOK_RECAP`
- Enabled: `OWNER_RESEARCH_DISCORD_ENABLED`, `AI_ENABLED`

No Railway variable has been created, changed, or removed at any point.

## Known blockers

1. `/api/now` still costs ~2.4s at floor — the 546-alert loop in
   `buildPaperChainDiagnostic`. Reducing it changes what the endpoint returns,
   so it needs an owner decision on the contract.
2. Recap requires `DISCORD_WEBHOOK_RECAP`, an owner-only Railway change.
3. Professional Watchlist enablement is an owner-only Railway change.
4. `paperLinkFailure` metric name is misleading (counts pre-delivery
   rejections, not delivered-but-unlinked). Diagnostic clarity only.

## Exact next bounded checkpoint

Two read-only confirmations, no code:

1. Open `/discord` in a browser and confirm ALERTS + WATCHLIST read
   **Configured**, RECAPS reads **NOT CONFIGURED**, and the ledger lists real
   sends. This closes `cb89c03`.
2. After the next 18:00 ET window, read the delivered
   `owner_next_session_watchlist` payload from the ledger and confirm no
   positive move is described as a decline. This closes `be68a12`.

## Stop conditions

- do not change a Railway variable without explicit owner approval
- do not enable a feature flag as part of verification
- do not send a manual Discord test message
- do not touch trading gates, ranking, or the asymmetry worktree
- do not stage Obsidian line-ending noise, `graph.json`, `workspace.json`,
  `graphify-out/`, or unrelated files
- do not describe a deployed-but-unobserved change as verified

## Relevant notes

- [[../02 Components/Discord Alerts]]
- [[../02 Components/watchlist]]
- [[../02 Components/delivery]]
- [[../02 Components/deployment]]
- [[../02 Components/safety]]

# OPTIONS_DISCORD_PRIVATE_BETA

Gated, private-beta options Discord delivery for the operator's own testing (no paying subscribers).
`lib/research/options/delivery.ts`. HARD no-op unless BOTH `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1`
AND `EARLY_OPTIONS_CALLOUTS_ENABLED=1` (and `OPTIONS_CALLOUTS_KILL` unset). Reuses the existing
approved options webhook (`DISCORD_WEBHOOK_OPTIONS` via `postToDiscord({webhook:"options"})`, 12s
timeout, secret never logged). No real money; the message carries a PAPER/BETA label.

## When exactly ONE message is sent
All true: both flags on; candidate READY; a real OCC contract selected; contract + underlying
freshness pass; spread/liquidity pass; chase threshold NOT exceeded; dedup/cooldown pass; not a
research-only put. Delivery RE-VERIFIES freshness/spread/chase at send time.

## Format (`callout.ts` + label)
```
HOOD CALL
$XX — MM/DD
Entry: $X.XX–$X.XX
Targets: $X.XX / $X.XX
Why: <one short reason>

PAPER/BETA TEST — NOT FINANCIAL ADVICE
```
No second confirmation message.

## Calls vs puts
Calls: fully evaluated, paper-traded, and (when valid + early) delivered. Puts: fully evaluated and
paper-traded but **RESEARCH_ONLY** — they are NEVER sent as actionable callouts (state `REJECTED`,
reason `research_only_put_suppressed`, counted). `bearish-gate.ts` stays the final authority;
`BEARISH_ACTIONABLE` stays off. The bearish gate is NOT weakened to create more alerts.

## Safety
Idempotent `alertId` (symbol|strategy|contract|5-min bucket); dedup (no second message, no duplicate
after an ambiguous timeout); bounded retry with backoff (never on a timeout/HTTP failure); Discord
failure never blocks the monitor; instant disable by unsetting one flag; `OPTIONS_CALLOUTS_KILL=1`
kill switch; stale-quote / chase-exceeded → no send. Webhook secret never logged or exposed in the API.

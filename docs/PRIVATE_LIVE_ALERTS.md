# Private Live Discord Alerts — Controlled Rollout

This document defines the **private live-alert mode** for OptiScan: real Discord
openings to a **private test channel only**, with shadow evidence collection
continuing, billing disabled, and no paid subscribers.

> **Honest limitation:** The final delivery gate is designed to block alerts that
> are measurably late or chased. It cannot guarantee zero late alerts. Every
> delivered alert preserves timing data (detection → Discord latency, pre-move %,
> entry-quality dimensions) so we can audit whether it was genuinely actionable.

## Exact Private Live Railway Profile

Set these variables in Railway (private test channel webhook only):

```env
SUBSCRIBER_OPTIONS_DISCORD_OWNER=independent
AGENT_CALLOUT_DISCORD=0
SUBSCRIBER_CONFIG_STRICT=1

INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1
OPTIONS_PORTFOLIO_DELIVERY_ENABLED=1
EARLY_OPTIONS_CALLOUTS_ENABLED=1
REAL_OPTION_PAPER_ENABLED=1
OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED=1

MARKET_SESSION_GUARD=enforce
ENTRY_QUALITY_GATE=enforce
SUBSCRIBER_SHADOW_MODE=1

OPTIONS_CALLOUTS_KILL=0

BILLING_ENABLED=0
TWITTER_DRAFTS_ENABLED=0

OPTIONS_MAX_DELIVER_PER_FLUSH=1
OPTIONS_OPENING_MAX_ALERTS=2
OPTIONS_READY_TTL_MS=120000
OPTIONS_0DTE_DELIVERY_CUTOFF_MINUTES=60
OPTIONS_0DTE_CHASE_LIMIT_PCT=0.4

DISCORD_WEBHOOK_OPTIONS=<your private test channel webhook>
SCAN_API_TOKEN=<set>
ALERT_DB_DIR=/app/data
POLYGON_API_KEY=<set>
```

Keep `OPTIONS_CALLOUTS_KILL=1` until all pre-flight checks pass, then flip to `0`.

## Checks Before Kill Switch Is Disabled

Run in order against production (`/api/healthz`, `/api/runtime/status`,
`/api/research/options/shadow-soak` with `x-scan-token`):

1. **Deployed commit is correct** — `/api/healthz` `commitShort` matches intended `main` SHA.
2. **Production schema is healthy** — `schemaOk: true`, no instrumentation fallback storm.
3. **Owner is `independent`** — runtime status / pipeline health shows independent owner.
4. **Supervisor options delivery is blocked** — `AGENT_CALLOUT_DISCORD=0`.
5. **Legacy options delivery is blocked** — subscriber config validator passes; no legacy sends.
6. **Market-session guard is `enforce`** — outside-session candidates blocked (not shadow-only).
7. **Entry-quality gate is `enforce`** — late/chased setups blocked at delivery (not shadow-only).
8. **Cross-session expiry is active** — `EXPIRED_TRADING_SESSION` on prior-session READY rows.
9. **0DTE dual cutoff is active** — wall-clock ET + minutes-to-close (stricter wins).
10. **Discord webhook points only to private test channel** — verify webhook URL destination manually.
11. **Billing remains disabled** — `BILLING_ENABLED=0`, no Stripe keys required.
12. **No public subscribers have access** — no subscriber role sync, no public marketing URLs.

Only after all 12 pass: set `OPTIONS_CALLOUTS_KILL=0` and redeploy (or hot-update var).

## Final Pre-Discord Revalidation Flow

Immediately before every Discord opening (after batch ranking and lifecycle claim):

```
1. EXPIRED_TRADING_SESSION     — candidate session ≠ current ET session
2. STALE_READY_CANDIDATE       — READY TTL expired or batch wait exceeded
3. Entry-quality six dimensions — composite enforce verdict
4. MOVE_ALREADY_COMPLETED      — T1 nearly reached after large underlying move
5. MOMENTUM_EXHAUSTED          — decelerating momentum on CALL
6. SPREAD_TOO_WIDE / QUOTE_STALE — contract quality hard blocks
7. CHASED_OPTION_PREMIUM       — underlying chase or option premium expansion
8. If all pass → format private live message → SEND_ATTEMPTED → Discord
```

If blocked after lifecycle claim, the active opportunity index row is released.

## What Causes an Alert to Send

- Independent options discovery + portfolio delivery + early callouts enabled.
- Kill switch **off** (`OPTIONS_CALLOUTS_KILL=0`).
- Regular-session market guard allows subscriber delivery.
- Candidate ranked #1 within flush cap (`OPTIONS_MAX_DELIVER_PER_FLUSH=1`).
- Correlation / opening-window caps not exceeded.
- Entry-quality composite `SEND` under **enforce** mode.
- Final pre-Discord revalidation passes with timing class **EARLY** or **TIMELY**.
- CALL side only (PUTs remain research-only).
- Frozen entry, T1, T2, stop preserved from first READY snapshot.

## What Causes an Alert to Be Blocked

Explicit rejection codes at the final gate:

| Code | Meaning |
|------|---------|
| `LATE_ENTRY` | Underlying/option pre-move exceeded timely thresholds |
| `CHASED_OPTION_PREMIUM` | Underlying chase or option premium expanded too far |
| `MOVE_ALREADY_COMPLETED` | Most expected move captured; T1 nearly reached |
| `INSUFFICIENT_UPSIDE_REMAINING` | Remaining upside to T1 below minimum |
| `STALE_READY_CANDIDATE` | READY TTL expired or waited too long in batching |
| `QUOTE_STALE` | Option quote older than max age |
| `WRONG_DIRECTIONAL_STRUCTURE` | Bearish structure on CALL / missing confirmation |
| `MOMENTUM_EXHAUSTED` | Decelerating momentum — continuation unlikely |
| `SESSION_TOO_LATE` | 0DTE dual cutoff (ET wall clock or minutes-to-close) |
| `EXPIRED_TRADING_SESSION` | Candidate from prior trading session |
| `SPREAD_TOO_WIDE` | Non-executable spread |

Alerts classified **LATE**, **CHASED**, **STALE**, or with insufficient remaining
opportunity are never sent.

## Six Entry-Quality Dimensions

Each dimension scores 0–100 with PASS / WARN / FAIL. Composite blocking requires
dimension failures — a moved trade is **not** auto-blocked if continuation and
remaining opportunity remain strong.

### 1. Setup Quality

| | |
|---|---|
| **Inputs** | higherHighs/higherLows, aboveVwap, vwapDistPct, momentumAccel, underlyingMove5m |
| **Thresholds** | FAIL if lower highs + lower lows on CALL; FAIL if below VWAP materially; WARN on deceleration |
| **Weight** | Contributes to composite; FAIL blocks independently |
| **Independent block** | Yes — bearish structure on CALL |
| **Avoids post-breakout wait** | Uses structure confirmation, not full breakout completion |
| **Preserves continuation** | Strong HH/HL + above VWAP passes even after initial move |

### 2. Entry Earliness

| | |
|---|---|
| **Inputs** | underlying pre-move since detection (60m), option pre-move (30m), chase limit |
| **Thresholds** | EARLY < timely u60/o30; TIMELY < late; LATE < max; CHASED ≥ max |
| **Weight** | FAIL alone does not block unless remaining/setup also weak |
| **Independent block** | No — paired with remaining opportunity or setup |
| **Avoids post-breakout wait** | TIMELY band accepts modest pre-move (not zero confirmation) |
| **Preserves continuation** | Strong continuation with reasonable premium still passes |

### 3. Contract Quality

| | |
|---|---|
| **Inputs** | spreadPct, quoteAgeMs |
| **Thresholds** | spread > `ENTRY_MAX_SPREAD_PCT` (10%); quote > `ENTRY_MAX_QUOTE_AGE_MS` (15s) |
| **Weight** | Hard block — immediate FAIL |
| **Independent block** | Yes |
| **Avoids post-breakout wait** | Liquidity checked at send time, not at discovery only |
| **Preserves continuation** | N/A — quality gate only |

### 4. Remaining Opportunity

| | |
|---|---|
| **Inputs** | current underlying vs frozen T1/T2 |
| **Thresholds** | FAIL if upside to T1 < `ENTRY_MIN_UPSIDE_TO_T1_PCT` (8%) |
| **Weight** | FAIL blocks independently |
| **Independent block** | Yes |
| **Avoids post-breakout wait** | Allows entry with partial move if T1/T2 room remains |
| **Preserves continuation** | Trend continuation with 8%+ to T1 passes despite prior move |

### 5. Session Risk

| | |
|---|---|
| **Inputs** | DTE, ET wall clock, minutesToSessionClose |
| **Thresholds** | 0DTE dual cutoff — stricter of ET cutoff and min minutes-to-close |
| **Weight** | FAIL blocks independently |
| **Independent block** | Yes |
| **Avoids post-breakout wait** | Time risk, not confirmation delay |
| **Preserves continuation** | Earlier 0DTE entries before cutoff pass |

### 6. Market Alignment

| | |
|---|---|
| **Inputs** | marketAligned, sectorAligned, directional structure |
| **Thresholds** | FAIL on wrong structure; PASS with market/sector aligned bonus |
| **Weight** | FAIL blocks independently |
| **Independent block** | Yes |
| **Avoids post-breakout wait** | Alignment checked at delivery, not end-of-day |
| **Preserves continuation** | Index-led continuation with alignment passes |

## First-Session Monitoring Checklist

During the first private live session, verify on `/shadow-soak` and Pipeline Health:

- [ ] Alerts actually sent (`deliveryMetrics.sent`, `liveDelivery.alertsSent24h`)
- [ ] Alerts blocked with exact block reasons (`liveDelivery.blockReasons`)
- [ ] Detection-to-Discord latency (`avgDetectionToDiscordMs`)
- [ ] Underlying and option pre-move at delivery (instrumentation JSON)
- [ ] Entry-quality dimensions on shadow decisions
- [ ] Session validation (no EXPIRED_TRADING_SESSION sends)
- [ ] Allowed vs blocked shadow outcome comparisons
- [ ] No alert became late during batching (`batchingLateBlocks`)
- [ ] No supervisor or legacy send attempted (`supervisorSendAttempts24h` = 0)
- [ ] Max one opening per flush
- [ ] Emergency kill switch tested (`OPTIONS_CALLOUTS_KILL=1` blocks within one cycle)

## Emergency Rollback

Immediate (no redeploy required):

```
OPTIONS_CALLOUTS_KILL=1
```

Full shadow-only rollback:

```
OPTIONS_CALLOUTS_KILL=1
MARKET_SESSION_GUARD=shadow
ENTRY_QUALITY_GATE=shadow
```

Verify: `/shadow-soak` shows `killSwitch: true`, `actuallyDelivered: 0` on new cycles,
Pipeline Health shows kill engaged.

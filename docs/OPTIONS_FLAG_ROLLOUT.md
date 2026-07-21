# OPTIONS_FLAG_ROLLOUT

All flags default OFF. Nothing here sends public Discord automatically or executes real money.

| Flag | Only observes | Creates paper entries | Can send Discord | Provider calls | AI cost |
|---|---|---|---|---|---|
| INDEPENDENT_OPTIONS_DISCOVERY_ENABLED | yes (records candidates) | no | no | chain fetch per candidate | no |
| REAL_OPTION_PAPER_ENABLED | no | **YES** (options_paper_trades) | no | quote at entry/exit | no |
| EARLY_OPTIONS_CALLOUTS_ENABLED | builds the message | no | **only when a delivery layer is wired + approved** (not wired here) | no | no |
| OPTIONS_ACTIVITY_DISCOVERY_ENABLED | yes | no | no | present-time chain (existing) | no |
| EARNINGS_DISCOVERY_ENABLED | yes | no | no | **needs a paid earnings feed** | no |
| AI_SHADOW_ENABLED | yes | no | no | Anthropic key | **YES** |

## Safest Railway activation order
1. `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1` — observe candidates + strategy selection (no paper, no
   Discord). Watch `GET /api/research/options`.
2. `REAL_OPTION_PAPER_ENABLED=1` — start real-option paper (still no Discord). Verify REAL_OPTION_PAPER
   rows + conservative fills + separate report buckets.
3. (later, explicit approval + a wired+gated delivery layer) `EARLY_OPTIONS_CALLOUTS_ENABLED=1`.

## Rollback
Unset the flag (Railway redeploys). No schema rollback needed (additive tables). In-flight shadow tasks
drain harmlessly; the live scanner + stock radar are unaffected at all times.

## Expected cost
- Provider: 1 chain fetch per candidate (bounded by universe + cadence + minute budget). No new AI cost
  unless AI_SHADOW_ENABLED. Real-option paper adds an exit-quote fetch per open trade.

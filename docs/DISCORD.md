# OptiScan Discord — channel design, ping formats, and implementation map

The product: a $15/mo Discord where the scanner's callouts land in real time,
graded honestly in public. Two callout channels + an automated track record.
Everything below reuses the EXISTING alert pipeline — same gates, same
verdicts, same accuracy math. Nothing new in the signal path.

---

## 1. Server layout

| Channel | Who posts | What |
|---|---|---|
| `#options-callouts` | webhook A | Actionable options BUY tickets as a single canonical contract line (see §Options line format) |
| `#stock-callouts` | webhook B | Shares LONG/SHORT momentum — premarket, RTH, and after-hours (re-enable `lib/stock-signals.ts` engine behind `STOCK_CALLOUTS=1`, capture with `asset_class='stock'`) |
| `#track-record` | webhook C | Auto daily scoreboard at 4:05 PM ET + weekly recap Sunday. Read-only. |
| `#how-it-works` | manual | One pinned post: what fires a callout, what the grades mean, disclaimers |

Env vars: `DISCORD_WEBHOOK_OPTIONS`, `DISCORD_WEBHOOK_STOCKS`,
`DISCORD_WEBHOOK_RECAP`. The legacy `DISCORD_WEBHOOK_URL` remains an options
fallback only. Stocks require their own `DISCORD_WEBHOOK_STOCKS`; recap is
optional and separate.

With `STOCK_CALLOUTS=1`, shares run in premarket, regular hours, and after-hours.
During regular hours the unchanged 0DTE path runs in parallel. Each product has
its own per-symbol cooldown, so one product cannot suppress the other. The
stock crossing latch may rescue a fast stock setup, but only into the same
ACTIONABLE_NOW stock capture path; WAIT/WATCH/near-miss states are never posted.

## Options line format (supervisor path)

Every actionable options callout on the supervisor path (`CALLOUT_CANONICAL_PATH=supervisor`)
is delivered as ONE line and nothing else — no embed, greeks, confidence, targets,
entry zones, or setup names:

```
$NVDA 18 JUL 26 $180 CALL $3.25
$SPY 17 JUL 26 $625 PUT $2.14
```

- `$NVDA` underlying · `18 JUL 26` expiration (DD MON YY) · `$180` strike · `CALL`/`PUT`
  · `$3.25` contract price at alert time (**midpoint** preferred, else **ask** — no
  separate last-trade field on the verified contract).
- The line is built by `lib/callouts/option-line.ts` straight off the callout's verified
  `contract` — the **same** `AgentResult.selectedContract` the paper bridge trades — so
  Discord can never publish a different contract than the one OptiScan paper-trades. The
  runtime asserts this identity (`sameOptionContract`) before sending.
- **Block, never fabricate.** If the exact contract cannot be verified (missing OCC symbol,
  strike, expiration, or a usable mid/ask price) the alert is **withheld** with a recorded
  `CONTRACT DATA INCOMPLETE — <reason>` status; OptiScan never sends a generic options alert.
- Routing is unchanged (options → `DISCORD_WEBHOOK_OPTIONS`). Stock/momentum callouts keep
  their existing compact card (untouched).

Rules that make it worth $15:
- **BUYs only ping.** WATCH posts are quiet (no @role mention). 2–6 BUYs/day by design.
- **Every BUY gets its result edited into the same message** at +5 and +10 minutes.
  Losers are never deleted. The 5-minute expiry is stated on every ping.
- **One WATCH per ticker per 30 min max.** No spam, no "eyes on" filler.
- Market open/close: one status line each, nothing overnight.

---

## 2. `#options-callouts` — BUY ping

Push-notification line (`content`, keep under ~90 chars):

```
🟢 BUY — TSLA $400 PUT 0DTE @ ~$2.52 · spread 1.2% · needs 0.62%   @0DTE
```

Embed payload (webhook JSON):

```json
{
  "content": "🟢 BUY — TSLA $400 PUT 0DTE @ ~$2.52 · spread 1.2% · needs 0.62% <@&ROLE_ID>",
  "embeds": [{
    "color": 15885146,
    "author": { "name": "OPTISCAN · options" },
    "title": "BUY TSLA $400 PUT · 0DTE",
    "description": "Tesla is falling fast with real volume behind it — down 0.30%/min with sellers in control. Closest strike, tight spread, premium needs just a 0.6% move to pay.\n\n**Every gate passed** — speed ✓ volume ✓ trend ✓ fillable ✓",
    "fields": [
      { "name": "Entry (mid)", "value": "$2.52", "inline": true },
      { "name": "Spread",      "value": "1.2%",  "inline": true },
      { "name": "Needs",       "value": "0.62% move", "inline": true },
      { "name": "Delta",       "value": "−0.48", "inline": true },
      { "name": "Speed now",   "value": "−0.30%/min", "inline": true },
      { "name": "Volume",      "value": "4.4× normal", "inline": true }
    ],
    "footer": { "text": "Fresh for 5 minutes — after that, don't chase · research signal, not financial advice" },
    "timestamp": "2026-07-07T15:20:17Z"
  }]
}
```

Color code: calls `0x35D07F` (3395711 dec is wrong — use 3526783? compute: 0x35D07F = 3526783? No: 0x35D07F = 3,526,783? 0x35=53, 53*65536=3473408 + 0xD0*256=53248 + 0x7F=127 → 3526783). Puts `0xF2635A` → 15885146.
Practical rule: **calls green `3526783`, puts coral `15885146`**, expired/graded → neutral `2895667`.

Result edits (PATCH the same webhook message — post with `?wait=true`, store
the returned message `id` in `notification_events.payload_json`):

- **+5 min** — append field `{ "name": "5 min", "value": "mid $2.94 · +17% ✅ running" }`
- **+10 min** — append field + retitle if done:
  - paid: `{ "name": "Result", "value": "**+31%** · topped $3.31 at 11:26 · paid in 6 min ✅" }`
  - failed: `{ "name": "Result", "value": "**−12%** · never paid · expired ❌" }` and set color to neutral.

WATCH post (no mention, compact, neutral color `2895667`):

```json
{
  "embeds": [{
    "color": 2895667,
    "description": "👀 **WATCH CALL — NVDA $189C** · armed, not ready\nSpread 2.1% ✓ · delta 0.44 ✓ · needs speed ≥ 0.20%/min (now +0.14)\n*No action — this either fires as a BUY or dies quietly.*"
  }]
}
```

---

## 3. `#stock-callouts` — shares ping (day trading, all sessions)

Current stock callouts use the compact deterministic stock card only: stock,
verified price, live NBBO entry range, ACTIONABLE NOW status, session, and ET
time. No options contract line, no AI prose, and no fabricated entry. LONG-only
stock alerts route to `DISCORD_WEBHOOK_STOCKS`; bearish stock remains protected
by the existing bearish-actionable safeguards.

```json
{
  "content": "🟢 LONG — RIVN shares @ ~$16.98 · premarket · moving −0.45%/min off news <@&ROLE_ID>",
  "embeds": [{
    "color": 3526783,
    "author": { "name": "OPTISCAN · stocks · premarket" },
    "title": "LONG RIVN · shares @ ~$16.98",
    "description": "Rivian gapping with 3.1× normal volume and holding the move — clean directional tape, breaking yesterday's high.\n\n**Every gate passed** — speed ✓ volume ✓ trend ✓ clean tape ✓",
    "fields": [
      { "name": "Entry area", "value": "$16.95 – 17.02", "inline": true },
      { "name": "Speed now",  "value": "+0.48%/min",     "inline": true },
      { "name": "Volume",     "value": "3.1× normal",    "inline": true },
      { "name": "Day move",   "value": "+6.4%",          "inline": true },
      { "name": "Session",    "value": "Premarket",      "inline": true },
      { "name": "Risk line",  "value": "back under $16.60 = thesis dead", "inline": true }
    ],
    "footer": { "text": "Fresh for 10 minutes · shares move slower than 0DTE · research signal, not financial advice" },
    "timestamp": "2026-07-07T12:41:02Z"
  }]
}
```

Grading for stocks: favorable move ≥ +0.75% within 10 min = paid (reuses
`alert_performance` checkpoints exactly like options; `EARLY_MOVE_WIN_PCT`).
Result edit at +10 min, same pattern as options.

---

## 4. `#track-record` — daily scoreboard (auto, 4:05 PM ET)

Posted by the tracker after EOD finalize. Data source:
`tradeSignalAccuracy({ days: 1 })` + the 10-minute payback query.

```json
{
  "embeds": [{
    "color": 3526783,
    "title": "Tuesday, July 7 — scoreboard",
    "description": "**5 of 7 callouts paid · 71% on the order**\nAvg winner **+24%** · avg loser **−19%** · graded entry mid → best mid, never the chart\n\n**62%** of this month's pings paid within **10 minutes** of the notification.",
    "fields": [
      { "name": "🟢 TSLA $400P",  "value": "+31% · paid in 6 min",  "inline": true },
      { "name": "🟢 QQQ $707P",   "value": "+18% · paid in 9 min",  "inline": true },
      { "name": "🔴 NVDA $189C",  "value": "−22% · never paid",     "inline": true },
      { "name": "🟢 META $715C",  "value": "+24% · paid in 14 min", "inline": true },
      { "name": "🟢 SPY $706P",   "value": "+23% · paid in 7 min",  "inline": true },
      { "name": "🟢 RIVN shares", "value": "+2.1% · premarket long","inline": true }
    ],
    "footer": { "text": "Every callout counted, losers included · full dashboard: yoursite/alerts" }
  }]
}
```

Weekly recap (Sunday 12 PM ET): same embed, `days: 7`, plus best/worst callout
of the week and the win-rate-by-side split. If the week was red, the headline
says so — the honesty IS the product.

---

## 5. Implementation map (for Cursor — same backend, same logic)

1. **`lib/alert-format.js`** — add `buildOptionsBuyEmbed(alert)`,
   `buildStockBuyEmbed(alert)`, `buildWatchEmbed(alert)`,
   `buildScoreboardEmbed(stats, rows)`. Pure functions returning the JSON
   payloads above; unit-test them like the existing formatters. Keep
   `containsBannedPublicLanguage` guard for public mode.
2. **`lib/notifications.ts`** — `postToDiscord(payload, { webhook })`:
   accept full payload objects (not just content), POST with `?wait=true`,
   persist returned message `id` + webhook into
   `notification_events.payload_json`. Add `editDiscordMessage(webhook, id, patch)`.
3. **Result edits** — in `alert-tracker.ts`, when the 5m/10m checkpoints
   record for an alert that has a sent Discord message, PATCH the embed with
   the result field (options: option mid return; stocks: favorable move).
   Never blocks the sweep (fire-and-forget like catalysts).
4. **Stock channel** — `STOCK_CALLOUTS=1` routes stock captures in premarket,
   RTH, and after-hours. During RTH this runs beside the unchanged 0DTE path.
   Stock BUYs notify `DISCORD_WEBHOOK_STOCKS` only.
5. **Scoreboard cron** — after EOD finalize in the tracker: build + post the
   daily embed to `DISCORD_WEBHOOK_RECAP`. Sunday: weekly variant.
6. **Role mentions** — `DISCORD_ROLE_0DTE`, `DISCORD_ROLE_STOCKS` env vars,
   only on BUY pings.

Compliance notes (repeat on the sales page and #how-it-works pin):
research/education signals, not financial advice, not an advisory service;
results shown are scanner grades, not executed trades; talk to a securities
attorney before charging — wording above is written to stay on the research
side of the line.

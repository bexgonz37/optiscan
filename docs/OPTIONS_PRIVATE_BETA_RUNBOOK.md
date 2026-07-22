# OPTIONS_PRIVATE_BETA_RUNBOOK

Test real options callouts in YOUR OWN private Discord (no paying subscribers). No real money.

## 0. One-time: set the webhook (Railway env)
`DISCORD_WEBHOOK_OPTIONS = <your private options webhook URL>` (kept secret).

## 1. Transport test FIRST (no market callout)
```powershell
$BASE="https://YOUR-APP.up.railway.app"; $H=@{ "x-scan-token"=$TOKEN }
Invoke-RestMethod -Method Post -Uri "$BASE/api/research/options" -Headers $H -ContentType "application/json" -Body (@{action="transport_test"} | ConvertTo-Json)
```
Expect `{ ok:true, configured:true, status:204 }` and one "transport test" message in your channel.

## 2. Turn on monitoring + paper (still NO Discord callouts)
Railway env: `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1`, `REAL_OPTION_PAPER_ENABLED=1`. Redeploy.
Watch `GET /api/research/options` → `monitor` (candidates/stages) + `report.paper` (REAL_OPTION_PAPER).

## 3. Enable private-beta callouts
Railway env: `EARLY_OPTIONS_CALLOUTS_ENABLED=1`. Redeploy. Now a READY call candidate with a real,
liquid, fresh, not-chased contract sends ONE message (with the PAPER/BETA label). Puts are suppressed
(research-only) and reported. Watch `GET /api/research/options` → `delivery` (sent/failed/latency/
putsSuppressed/linkedPaper).

## Kill / rollback (instant)
- Stop sends now: set `OPTIONS_CALLOUTS_KILL=1` OR unset `EARLY_OPTIONS_CALLOUTS_ENABLED`.
- Stop paper: unset `REAL_OPTION_PAPER_ENABLED`. Stop everything: unset
  `INDEPENDENT_OPTIONS_DISCOVERY_ENABLED`. Redeploy. Additive schema — nothing to roll back.

## Notes
- Feature coverage is still limited (level/market-context feeds not fully wired), so callouts will be
  sparse — that's expected; do not read it as "no setups".
- No performance is claimed until forward REAL_OPTION_PAPER evidence accrues. Do not present these as
  advice; the PAPER/BETA label is mandatory and automatic.
- The Stock Momentum Radar is untouched by all of the above.

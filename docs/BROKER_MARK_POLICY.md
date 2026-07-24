# Broker V2 Mark-to-Market Policy (B3)

Version: **1** (`MARK_POLICY_VERSION`)

This policy governs how open positions are valued for **dollar account equity**.
It is research/developer-facing while `PAPER_BROKER_V2_ENABLED=0` by default.
Legacy paper remains authoritative for production dashboards.

## Entry valuation basis

| Instrument | Basis |
|---|---|
| Options (long) | Fill premium per share; dollar notional = premium × contracts × **100** |
| Equity | Fill price × shares |

## Open-position mark source

1. Prefer a **fresh two-sided quote** (bid > 0 and ask > 0).
2. Long inventory mark: **conservative sell** — `mid - (mid - bid) × slipFraction` (default slipFraction **0.6**).
3. Short inventory mark: **conservative cover** — toward the ask with the same slipFraction.
4. If only a last-trade is available (no book), use it only when fresh.

## Bid / ask / midpoint rules

- Mid = `(bid + ask) / 2` when both sides are valid.
- **One-sided quotes are refused** — we do not invent the missing side (`ONE_SIDED`, unusable).

## Stale quote handling

- `quoteAgeMs > BROKER_V2_MARK_MAX_QUOTE_AGE_MS` (default 15m) ⇒ `STALE`.
- Stale marks are **unusable** unless `BROKER_V2_MARK_RETAIN_STALE=1` and age ≤ `BROKER_V2_MARK_MAX_STALE_RETAIN_MS` (default 1h).
- Unusable stale marks **must not** silently inflate equity; snapshots become `INCOMPLETE` / `PARTIAL`.

## Spread handling

- `spreadPct = (ask - bid) / mid × 100`.
- If `spreadPct > BROKER_V2_MARK_MAX_SPREAD_PCT` (default 40%), status = `WIDE_SPREAD` and completeness is at best `PARTIAL`.

## Market-closed behavior

- If `marketOpen === false`: retain last usable quote only under the retain-stale window; otherwise `MARKET_CLOSED` / unusable.

## Expiration behavior

- At/after expiration with a usable two-sided quote: mark normally.
- At/after expiration **without** a usable quote: **`WORTHLESS` at markPrice = 0** (honest zero, never a fabricated mid).

## Missing quote behavior

- Status `MISSING`, `markPrice = null`, `usable = false`.
- Equity snapshots set `completeness_status` to `INCOMPLETE` or `PARTIAL`.
- Position market value contributes **$0** until a usable mark exists — never last-known-good by accident.

## Equity identity

```
totalEquity = cash + Σ(marked position market value in dollars)
buyingPower = cash - reserved
```

Equity curves are built from append-only `broker_equity_snapshots.net_equity` (dollars), **not** cumulative return percentages.

## Completeness status

| Status | Meaning |
|---|---|
| `COMPLETE` | All open positions have usable marks |
| `PARTIAL` | Some positions marked; others missing/stale/wide |
| `INCOMPLETE` | Open positions exist but none have usable marks (or all missing) |

## Env knobs (optional)

```
BROKER_V2_MARK_SLIP_FRACTION=0.6
BROKER_V2_MARK_MAX_QUOTE_AGE_MS=900000
BROKER_V2_MARK_MAX_STALE_RETAIN_MS=3600000
BROKER_V2_MARK_MAX_SPREAD_PCT=40
BROKER_V2_MARK_RETAIN_STALE=0
```

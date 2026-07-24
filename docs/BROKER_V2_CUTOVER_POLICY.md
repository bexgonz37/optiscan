# Brokerage V2 Cutover Policy (B6)

Version: **1** (`CUTOVER_POLICY_VERSION`)

Label: **Brokerage V2 Migration Readiness — No Production Cutover**

B6 builds controls and evidence to decide whether V2 is **later** safe to replace
legacy paper-accounting reads. B6 does **not** make V2 authoritative.

After B6 ships, production enters an **Operational Validation (Soak)** phase —
see `docs/BROKER_V2_SOAK.md`. Daily readiness reports are auto-generated; cutover
still requires explicit human approval.

## Feature flags (all default OFF)

| Flag | Role |
|---|---|
| `PAPER_BROKER_V2_ENABLED` | Dual-write / V2 research APIs |
| `PAPER_BROKER_V2_SHADOW_READ_ENABLED` | Parallel V2 calc; legacy still returned |
| `PAPER_BROKER_V2_READS_ENABLED` | Switch approved reads to V2 (**must stay 0 in B6 production**) |

### Invalid combinations (startup / config guard)

1. `READS_ENABLED=1` while `ENABLED=0` → reject (cannot serve V2 without write/mirror path).
2. `READS_ENABLED=1` and `SHADOW_READ_ENABLED=1` → reject (no dual-authoritative / dual-mode).
3. Any other combo is allowed; defaults are all `0`.

## Response source labels

Every routed paper-accounting response must stamp exactly one of:

- `LEGACY` — authoritative today
- `V2_SHADOW` — never returned as user payload in B6; only recorded internally
- `V2` — only when `READS_ENABLED=1` (not enabled in B6 production)

Never combine legacy and V2 rows into one unlabeled metric.

## Readiness statuses

| Status | Meaning |
|---|---|
| `NOT_READY` | Blocking failures or orphans present |
| `OBSERVING` | Healthy so far but sample / window insufficient |
| `READY_FOR_SHADOW_READS` | Safe to enable shadow-read comparisons |
| `READY_FOR_CONTROLLED_CUTOVER` | Meets documented cutover gate (still requires human decision) |

Statuses are computed from explicit rules below — never subjective.

## Conservative thresholds (`READY_FOR_CONTROLLED_CUTOVER`)

All must pass:

| Requirement | Threshold |
|---|---|
| Unresolved critical reconciliation failures | **0** |
| Orphaned orders / fills / positions / ledger / snapshots | **0** |
| Duplicate mirrored fills / duplicate legacy links | **0** |
| Trade lifecycle coverage (eligible closed → mirrored exit) | **≥ 99.9%** (effectively 100% at integer counts) |
| Audit-chain completeness among mirrored trades | **≥ 99.9%** |
| Ledger / equity reconciliation success among checks | **≥ 99.9%** |
| Fill-price / realized P&L / return / lifecycle parity rates | each **≥ 99.5%** when sample ≥ min checks |
| Completed mirrored round-trips (sample size) | **≥ 50** |
| Distinct production trading days with ≥1 mirror | **≥ 5** |
| Continuous healthy parity duration | **≥ 72 hours** with no critical unmatched parity events |

If sample size or trading days or healthy duration is below threshold → status is at best
`OBSERVING` (never fabricate `READY_FOR_CONTROLLED_CUTOVER`).

## `READY_FOR_SHADOW_READS` requirements

- No unresolved **critical** failures
- No orphaned financial records
- No duplicate mirrors
- Mirrored trade sample ≥ **10**
- Distinct trading days ≥ **2**
- Dual-write flag may be on or off; shadow flag is independent but recommended after dual-write soak

## `OBSERVING`

Returned when there are no blocking failures but one or more cutover/shadow requirements
are unmet. Response lists **exact missing requirements**.

## `NOT_READY`

Returned when any blocking condition is true (critical failures, orphans, duplicates).

## Critical vs non-critical parity failures

**Critical:** `fill_price`, `realized_pnl`, `position_lifecycle`, `audit_chain`, `account_equity`,
orphans, duplicates, missing mirrored closed trades.

**Non-critical (warn only):** stale/missing marks counts (surface in data quality; block cutover
only when incomplete equity snapshots imply reconciliation cannot be proven — counted via
`incomplete equity-snapshot` hard fail if any open positions rely on incomplete latest snapshot
for readiness equity rate &lt; threshold).

## Historical reconciliation (dry-run)

- Compare eligible legacy history (`options_paper_trades`, `paper_trades`) to V2 links/ledger.
- Identify gaps and mismatches.
- **Do not** automatically rewrite, delete, or mutate financial history in B6.
- Future backfill (post-B6) must be: explicit, idempotent, versioned, dry-run capable,
  append-only for financial records, and emit an audit event.

## Shadow-read mode

When `PAPER_BROKER_V2_SHADOW_READ_ENABLED=1`:

- User-visible APIs still return **legacy** results (`source: LEGACY`)
- V2 metrics computed in parallel
- Differences + latency recorded as `broker_parity_events` with `check_kind` prefix `shadow_read_*`
- No scanner / delivery / gate / threshold / AI changes

## Controlled read cutover

When `PAPER_BROKER_V2_READS_ENABLED=1` (future, not B6 production):

- Only approved paper-accounting / research-reporting **reads** switch to V2 via
  `resolvePaperReadSource()` in `lib/broker/routing.ts`
- Must not affect scanner, candidate evaluation, Discord, option selection, gates,
  thresholds, AI authority, or entry/exit decisions

## Rollback

- Disable `PAPER_BROKER_V2_READS_ENABLED` → instantaneous return to legacy reads
- No migration / destructive writes / deletion of legacy history required
- Dual-write and V2 tables remain intact for forensics

## Recommended next actions (dashboard)

| Status | Recommended next action |
|---|---|
| `NOT_READY` | Resolve critical parity / orphans; do not enable shadow or reads |
| `OBSERVING` | Keep dual-write soaking; meet sample/day/duration gates |
| `READY_FOR_SHADOW_READS` | Enable `PAPER_BROKER_V2_SHADOW_READ_ENABLED=1` in a controlled env |
| `READY_FOR_CONTROLLED_CUTOVER` | Human review only — do not auto-enable reads in B6 |

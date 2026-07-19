# Next Market-Session Validation Checklist

Run at/around the next market open. All research flags remain OFF unless you are deliberately
running a staged activation (see `FEATURE_FLAGS_AND_ACTIVATION.md`). With flags OFF this checklist
verifies the rebuild changed nothing in production.

## Deployment & migrations
- [ ] Deployed SHA on Railway matches `origin/main` HEAD (`GET /api/runtime/status` → `deploy.commit`).
- [ ] App booted clean; `migrate()` ran (new tables exist; no migration error in logs).
- [ ] `npm test` / `tsc` / `build` were green on the deployed commit.

## Scanner & provider
- [ ] Scanner loop healthy (`/api/runtime/status`).
- [ ] Provider success/error rate normal (`/api/system/provider-health`).
- [ ] Market-session detection correct (regular/premarket/afterhours/closed).

## Production (must be unchanged from baseline)
- [ ] Production candidate counts in the normal range.
- [ ] Discord considered / emitted / delivered unchanged vs baseline.
- [ ] **No Research/Challenge content in Production Discord** (options channel shows only production callouts).

## Research capture / routing (only if Stage 1–2 enabled)
- [ ] `setup_candidates` accruing during RTH; tier distribution sane (`/api/research/overview`).
- [ ] Tier counts present for all four tiers.
- [ ] `lane_routes` counts present; **no duplicate routes** (UNIQUE(setup_id,lane)).
- [ ] No duplicate enrollments / no duplicate paper trades on retries.

## Fill honesty & portfolios (only if Stage 4–5 enabled)
- [ ] Quote freshness enforced; fill provenance recorded (`entry_quote_source`).
- [ ] REJECTED_INVALID never filled; no executed P&L for rejected.
- [ ] Primary can take one contract when it fits every hard cap.
- [ ] Cooldown isolation: one ticker's loss does not freeze others; one lane's loss does not freeze another.
- [ ] Challenge independent (no Primary trade required); Research independent.

## Safety invariants
- [ ] Options puts remain research-only (never PRODUCTION_QUALITY / never Primary / never Discord).
- [ ] `BEARISH_ACTIONABLE` off; `bearish-gate.ts` authoritative.
- [ ] AI advisory-only; no proposals APPROVED without a human; nothing auto-applied.
- [ ] Historical replay bounded/OFF unless explicitly enabled; options replay INACTIVE_MISSING_PROVIDER.
- [ ] `/api/research/overview` contains **no** secret / token / key / webhook / env value.

## Rollback readiness
- [ ] Know the current SHA to `git revert` if needed (never force-push).
- [ ] Know which flags are set; unsetting any flag is an immediate no-op rollback.

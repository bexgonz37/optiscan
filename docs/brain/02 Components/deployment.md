# Deployment

Status: LOCAL VALIDATION PASSED — NOT PUSHED, NOT DEPLOYED

## Current state

- Local branch: `main`
- Local HEAD before this phase: `9c2d1c8` (professional Watchlist core)
- Local HEAD after this phase: the Watchlist integration commit
- Remote `origin/main` (production baseline): `efaf2be`
- Ten local commits are ahead of the remote and none have been deployed:
  `da21b4d`, `c54fc4d`, `4688136`, `6b0c73f`, `e944a15`, `1bde178`, `baf4efa`,
  `895f904`, `9c2d1c8`, plus this integration commit.

## Local validation on this checkpoint

- 2500/2500 tests pass, 0 fail, 0 skipped
- `npx tsc --noEmit --incremental false` clean
- `npm run build` compiled successfully
- `git diff --check` clean
- Migrations additive and repeat-safe; the new
  `watchlist_professional_publications` table is `CREATE TABLE IF NOT EXISTS`
  plus `CREATE INDEX IF NOT EXISTS`, and is deliberately NOT in the required
  schema-readiness table list, so `schemaOk` is unaffected.

**No production verification exists for any of this.** Nothing has run on
Railway. Every statement above is a local result only.

## Environment

This phase introduced **no new environment variable** and requires **no Railway
change**. `PROFESSIONAL_WATCHLIST_ENABLED` is unset, which is OFF; publication
also requires the already-provisioned `OWNER_RESEARCH_DISCORD_ENABLED=1` and the
existing watchlist webhook.

## Rules

- Validate before pushing
- Do not modify Railway variables without approval
- Do not claim production success until Railway is verified
- Preserve unrelated untracked files

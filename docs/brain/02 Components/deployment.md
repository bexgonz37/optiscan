# Deployment

Status: PUSHED AND DEPLOYED — VERIFIED 2026-07-30

## Current state

- Local branch: `main`, HEAD `0be1530`
- Remote `origin/main`: `0be1530` (identical — fast-forward push, no force)
- **Deployed production commit: `0be1530`**, confirmed by `/api/healthz`
- Previous production baseline: `efaf2be`
- Eleven commits shipped in one push: `da21b4d`, `c54fc4d`, `4688136`,
  `6b0c73f`, `e944a15`, `1bde178`, `baf4efa`, `895f904`, `9c2d1c8`, `5c51949`,
  `0be1530`.

## Railway deployment (verified, not assumed)

- Deployment id `5682002117`, environment `optiscan / production`,
  created 2026-07-30T20:41:48Z, **final state `success`**.
- The deployment was matched to the pushed SHA `0be1530` explicitly via the
  GitHub deployments API — not by assuming the most recent deployment.
- Build ran ~2 minutes. `/api/healthz` flipped from `efaf2be` to `0be1530`
  during polling, which is the authoritative confirmation the new image serves
  traffic.

## Production verification on `0be1530` (read-only; nothing enabled, nothing sent)

- `/api/healthz` → 200, `ok: true`, `db: true`, `dbError: null`,
  `schemaOk: true`, `schemaMissing: []`, `lifecycle.active: true`.
  No startup crash.
- `/api/runtime/schema` → 200, `schema.ok: true`, `missing: []`,
  `missingLegacyColumns: []`. **No migration failure.** The additive
  `watchlist_professional_publications` / `watchlist_setup_*` tables are outside
  the required-table list, so `schemaOk` was unaffected exactly as designed.
- Secret scan across every verified response: **0 credential-pattern hits**, no
  webhook URL, no token, no raw Discord configuration.

## Local validation on this checkpoint

- 2500/2500 tests pass, 0 fail, 0 skipped
- `npx tsc --noEmit --incremental false` clean
- `npm run build` compiled successfully
- `git diff --check` clean
- Migrations additive and repeat-safe.

## Environment

This phase introduced **no new environment variable** and required **no Railway
change** — and none was made. `PROFESSIONAL_WATCHLIST_ENABLED` remains unset,
confirmed live by `enabled: false` on the professional endpoint. Publication
also requires the already-provisioned `OWNER_RESEARCH_DISCORD_ENABLED=1` and the
existing watchlist webhook.

## Not yet deployed

The documentation commit recording this verification is a **separate, later
commit**. Confirm its own Railway deployment before treating the brain notes as
live on the deployed image.

## Rules

- Validate before pushing
- Do not modify Railway variables without approval
- Do not claim production success until Railway is verified
- Preserve unrelated untracked files

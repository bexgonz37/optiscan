# Incident 2026-08-04 — Database Init Outage

Status: RESOLVED · Permanent regression coverage landed

## One line

An index over a migrated column was declared in `SCHEMA`, so on a long-lived
database it ran before the `ALTER` that creates the column, threw `no such
column`, and aborted the first statement every database open executes — taking
every route down, not only the content ones.

## Timeline (Railway deployment records, UTC)

| Time | Deployment | State |
| --- | --- | --- |
| 15:13:04 | `0cc84fb` | **Defect deployed — outage begins** |
| 15:14:57 | `607e8d1` | docs-only; still broken |
| 15:29:54 | `1a4131a` | **Hotfix deployed — outage ends** |
| 15:45:26 | `005dd49` | Current production, SUCCESS |

**Duration: ~16m50s** of production serving a broken database init, bounded
deploy-start to deploy-start. The intervening `607e8d1` deploy did not change
the defect.

## Commits

- **Defective:** `0cc84fb` — *fix(content): a busy channel was deleting drafts as though it had rejected them*
- **Hotfix:** `1a4131a` — *fix(db): an index on a migrated column took the whole database init down*
- **Verification:** `005dd49`

## Affected routes

Every route, because `db.exec(SCHEMA)` is the first thing `getDb()` runs and the
throw propagates out of database init before any route logic. Confirmed
symptoms: `503 SCHEMA_MISMATCH` or `500`. The three routes carried as explicit
regression coverage, chosen because they span unrelated domains and so
demonstrate the blast radius:

- `/api/discord/health`
- `/api/opportunity-cases`
- `/api/content-drafts`

## Root cause

```sql
CREATE INDEX IF NOT EXISTS idx_content_drafts_delivery_reason
  ON content_drafts(discord_delivery_status, discord_delivery_reason)
```

was placed inside `SCHEMA`, adjacent to the `CREATE TABLE` that declares
`discord_delivery_reason`.

On a **fresh** database this is correct: `CREATE TABLE` runs, the column exists,
the index builds. On a **long-lived** one it is fatal:

1. `CREATE TABLE IF NOT EXISTS` is a no-op against the existing table.
2. The reason columns arrive later, via `CONTENT_DRAFT_COLUMN_MIGRATIONS` in `migrate()`.
3. The index therefore executes against a column that does not yet exist.

The migrations were individually **idempotent**. They were not **ordered**.
Idempotent is not the same as ordered — that distinction is the whole incident.

The fix moves the index to immediately after the `ALTER`s that create its column.
An index on a migrated column belongs after the migration that creates it.

## The missing test

`tests/content-drafts-migration.test.mjs` was written alongside the hotfix and
guards the shape of the fix, but it **re-declares the migration list locally**.
It can only prove that a *copy* of production's ordering is safe, while the
defect lived in the ordering *between* `SCHEMA` and `migrate()` inside
`lib/db.ts`.

Measured directly: with the defect reintroduced into `lib/db.ts`, that test still
reports **3 pass / 0 fail** while production is down.

The deeper reason the gap existed: `lib/db.ts` imports through the `@/` alias,
which the `node:test` runner did not resolve. With the real `getDb()`
unimportable, every content fixture built its own in-memory table — and a fresh
in-memory table is precisely the case where the defect is invisible.

## Permanent regression coverage

- **`tests/helpers/register-alias.mjs`** — a synchronous `module.registerHooks`
  resolver teaching `node:test` the `@/` mapping tsconfig already declares, plus
  the extensionless relative imports bundler resolution allows. No loader thread,
  no new dependency, no duplicated production logic. This is what makes the real
  `getDb()` testable at all.

- **`tests/legacy-database-upgrade.test.mjs`** — seeds a realistic
  pre-migration `content_drafts` **file on disk**, with rows in the delivery
  states production actually holds, then runs the real `getDb()` against it.
  Asserts: first/second/third initialization, rows preserved, new nullable fields
  remain `NULL` rather than invented, `discord_attempt_count` takes its declared
  default, the dependent index exists only after its column, and all three routes
  above can open the migrated database.

  Verified to actually catch the outage: with the defect reintroduced,
  **7 fail / 0 pass** — including the three route tests, reproducing the real
  blast radius.

## The rule this establishes

An index over a column added by migration must be created **in the migration that
adds the column**, never in `SCHEMA`. `SCHEMA` may only index columns its own
`CREATE TABLE` is guaranteed to have produced — which, on an existing table, is
none of them.

Any future test that claims to cover migration safety must exercise
`getDb()` through the alias harness against a seeded legacy **file**. A test that
applies isolated `ALTER` statements to a fresh in-memory table cannot observe
this class of defect.

## Related notes

- [[Missing Discord Alerts]]
- [[../02 Components/delivery]]

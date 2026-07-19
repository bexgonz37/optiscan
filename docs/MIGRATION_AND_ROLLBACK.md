# Migrations & Rollback

## Guarantees
- **Additive only.** Every schema change is `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
  EXISTS`, or a guarded `ADD COLUMN` (applied only when the column is absent, via
  `PRAGMA table_info` checks in `lib/db.ts:migrate`).
- **Repeat-safe.** Running `migrate()` any number of times is a no-op after the first — proven by
  double-`exec` tests in every research test file.
- **No destructive changes.** No table/column is dropped, renamed, or retyped. No data migration.
- Migrations run automatically on `getDb()` at boot (Railway); no manual step required.

## Tables added by the rebuild (all additive)
| Phase | Tables / columns |
|---|---|
| P1 | `setup_candidates`, `setup_gate_results` |
| P2 | `lane_routes` |
| P3 | `paper_trades`: `+setup_id,+strategy_agent,+setup_tier,+lane`; `setup_candidates`: `+option_bid,+option_ask,+option_mid` |
| P5 | `research_experiments`, `research_enrollments`, `counterfactual_outcomes` |
| P6 | `ai_research_runs`, `ai_research_findings`, `research_proposals`, `ai_training_rows` |
| P7 | `replay_runs`, `replay_outcomes` |

Fills/outcomes reuse the existing `paper_trades` (one execution model — no new fill table).

## Rollback
Because every change is additive and every new runtime path is flag-gated OFF:
1. **Behavioral rollback = unset the flag(s).** The runtime path becomes a hard no-op immediately;
   no schema change is needed. Rollback order: reverse of activation (see
   `FEATURE_FLAGS_AND_ACTIVATION.md`).
2. **Code rollback** (if ever needed) = `git revert` the phase commit(s) on `main` (never
   force-push). The additive tables/columns are harmless if left in place (nothing reads them
   unless a flag is on).
3. **Data**: additive rows can be ignored or archived; they never affect production reads.

## Repeat-safety verification
Run `npm test` — the research suites create each table with the exact DDL twice and assert no
error, plus assert idempotent inserts on retries.

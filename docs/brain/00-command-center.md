# OptiScan Command Center

## Current repository state

- Branch: main
- Local HEAD, origin/main, and deployed production are all `df9c01c`
- Previous production baseline: efaf2be (superseded 2026-07-30)
- Both Railway deployments verified by SHA and reached success; healthz confirms
  the deployed commit, schemaOk true, no migration failure
- PROFESSIONAL_WATCHLIST_ENABLED is unset (OFF). The first 18:00 ET window was
  observed: the professional job WAS reached and recorded outcome DISABLED,
  publishing nothing. Scheduler wiring is proven; the legacy plan ran normally.

## Current objective

Decide whether to enable PROFESSIONAL_WATCHLIST_ENABLED. That is a Railway
variable change and requires explicit owner approval. The path is proven
reachable and proven inert while disabled, but has never built or published in
production.

## How this brain works

- Graphify maps code structure and relationships.
- Obsidian stores decisions, status, blockers, and plans.
- Agents begin with the current task packet.
- Agents load only notes relevant to the current task.

## Tooling limitations (known, accepted)

- **Agent hook configs are machine-specific.** `.claude/settings.json` and
  `.codex/hooks.json` invoke Graphify by absolute path
  (`C:/Users/bexgo/.local/bin/graphify.EXE`). This is not a hand-edit: Graphify's
  own installer (`graphify claude install`) resolves and writes its binary's
  absolute path, and re-running the installer reproduces the same string byte for
  byte. The `hook-guard` / `hook-check` subcommands these hooks call are internal
  and undocumented in `graphify --help`, and no flag emits a PATH-resolved or
  relative command. The hooks will therefore not fire on another machine or in
  CI; the fix there is to re-run `graphify claude install` locally rather than to
  edit the JSON. Nothing else in the repo depends on this path.
- **Obsidian's `workspace.json` is not tracked.** It is machine-local UI state
  that rewrites on every vault session, so it is ignored. The vault's real
  content — every note plus `core-plugins.json` — is tracked.

## Main areas

- [[01 Projects/OptiScan]]
- [[05 Runtime/CURRENT_PACKET]]
- [[02 Components/safety]]
- [[02 Components/deployment]]
- [[02 Components/session-audit]]
- [[02 Components/earlier-entry]]
- [[02 Components/loss-protection]]
- [[02 Components/delivery]]
- [[02 Components/watchlist]]
- [[02 Components/Options Scanner]]
- [[02 Components/Discord Alerts]]
- [[02 Components/Market Data]]
- [[02 Components/Opportunity Lifecycle]]
- [[02 Components/AI Learning System]]
- [[02 Components/High-Asymmetry Radar]] (feature branch only — shadow research)
- [[04 Bugs/Missing Discord Alerts]]

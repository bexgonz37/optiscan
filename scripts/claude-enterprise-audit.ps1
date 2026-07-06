# OptiScan — Claude enterprise audit runner
# Usage (PowerShell, from repo root):
#   .\scripts\claude-enterprise-audit.ps1
#   .\scripts\claude-enterprise-audit.ps1 -OpenPrompt   # opens prompt in notepad after generating
#
# Then paste scripts/CLAUDE_AUDIT_PROMPT.md into Claude Code (or claude.ai with the repo zipped).

param(
    [switch]$OpenPrompt,
    [string]$RepoUrl = "https://github.com/bexgonz37/optiscan.git"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "`n=== OptiScan pre-audit checks ===" -ForegroundColor Cyan

# 1. Baseline health
Write-Host "`n[1/4] npm test..." -ForegroundColor Yellow
npm test 2>&1 | Tee-Object -Variable testOut | Out-Null
$pass = ($testOut | Select-String "# pass (\d+)").Matches.Groups[1].Value
$fail = ($testOut | Select-String "# fail (\d+)").Matches.Groups[1].Value
Write-Host "  tests: pass=$pass fail=$fail"

Write-Host "`n[2/4] TypeScript..." -ForegroundColor Yellow
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) { Write-Host "  TYPECHECK FAILED" -ForegroundColor Red; exit 1 }
Write-Host "  ok"

Write-Host "`n[3/4] Production build..." -ForegroundColor Yellow
npm run build 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "  BUILD FAILED" -ForegroundColor Red; exit 1 }
Write-Host "  ok"

# 2. Git context for the auditor
$branch = git branch --show-current
$head = (git rev-parse --short HEAD)
$remote = (git remote get-url origin 2>$null)
$status = git status --short

# 3. Write audit prompt with live context
$promptPath = Join-Path $Root "scripts\CLAUDE_AUDIT_PROMPT.md"
$date = Get-Date -Format "yyyy-MM-dd HH:mm"

$prompt = @"
# OptiScan Enterprise Audit — $date

You are a senior staff engineer auditing **OptiScan**, a local-first 0DTE options momentum scanner (Next.js 15, SQLite, Polygon.io). The operator is a retail trader who needs **correct BUY CALL / BUY PUT signals**, **1-second live refresh**, and **beginner-friendly UX**. Treat this like a pre-production review for a paid trading research platform.

## Repo
- URL: $RepoUrl
- Branch audited: $branch @ $head
- Remote: $remote
- Uncommitted changes: $(if ($status) { $status } else { "(clean)" })

## Your mission
1. **Verify correctness** — TRADE verdicts must require live direction-aligned speed (≥0.15%/min or volume surge), never day-move/RVOL alone. Popups and Discord only on TRADE. Research-tier / swing-path alerts never BUY.
2. **Find bugs** — race conditions in 1s polling, stale verdicts, popup leaks for WAIT/SKIP, scanner-loop vs UI desync, SQLite migration gaps.
3. **Enterprise hardening** — error boundaries, observability, rate-limit backoff, env validation, secrets hygiene, test gaps, type safety, accessibility, performance under 1s refresh.
4. **UX audit** — Dashboard, Alerts (Right now / History / Journal), /guide, ChartPanel, popups: is a complete beginner able to follow "see popup → chart → decide"?
5. **Implement fixes** — Make focused PR-quality changes. Do not over-engineer. Match existing code style. Add tests for every behavior change.

## Read these files first (in order)
1. ``lib/trade-verdict.ts`` — TRADE/WAIT/SKIP gates, ``hasLiveSpeedProof``, ``isTradeEligible``
2. ``lib/alert-capture.ts`` — capture tier, Discord gating
3. ``lib/scanner-loop.ts`` — 1s loop, shouldTrigger, chain fetch gating
4. ``components/AlertPopup.tsx`` — TRADE-only popups + live tape
5. ``components/AlertsCommandCenter.tsx`` — hero + single list
6. ``components/ScannerDashboard.tsx`` — 1s refresh, pause, filters
7. ``hooks/useLiveTapeMap.ts`` — shared live tape
8. ``app/guide/page.tsx`` — instructions
9. ``tests/trade-verdict.test.mjs`` — extend with edge cases you find

## Acceptance criteria (must all pass after your work)
- [ ] ``npm test`` — all green
- [ ] ``npx tsc --noEmit`` — clean
- [ ] ``npm run build`` — clean
- [ ] Slow flat ticker (e.g. +0.2% day, 0.05%/min speed) → WAIT only, no popup
- [ ] Fast aligned mover → TRADE hero + popup + correct contract line
- [ ] Stalled TRADE downgrades to WAIT when live tape slows
- [ ] ``alert_tier=research`` never TRADEs
- [ ] 1s dashboard/alerts refresh does not cause runaway requests or UI jank
- [ ] No secrets in repo; ``.env.local`` documented in README/guide

## Audit output format
Produce a report with:
1. **Executive summary** (5 bullets: ship / no-ship, top risks)
2. **Correctness findings** (severity: critical / high / medium / low)
3. **Enterprise gaps** (observability, tests, ops, security)
4. **UX findings** (beginner confusion points)
5. **Changes made** (file list + why)
6. **Remaining backlog** (prioritized, with effort estimate)

## Constraints
- Deterministic scanner path — no LLM in alert firing
- Catalysts never block alerts
- Options chains only on trigger / chart open (not every 1s tick)
- Private vs public language modes must stay compliant
- Minimize scope per fix; prefer extending existing functions over new abstractions

## Commands to run
``````bash
npm test
npx tsc --noEmit
npm run build
npm run dev   # http://localhost:8780 — verify Dashboard, Alerts, /guide during market hours
``````

Begin by reading the files above, running tests, then audit and fix.
"@

Set-Content -Path $promptPath -Value $prompt -Encoding UTF8
Write-Host "`n[4/4] Wrote audit prompt:" -ForegroundColor Yellow
Write-Host "  $promptPath" -ForegroundColor Green

Write-Host "`n=== Next steps ===" -ForegroundColor Cyan
Write-Host "  Option A — Claude Code (recommended):"
Write-Host "    cd $Root"
Write-Host "    claude"
Write-Host "    Then: Read and follow scripts/CLAUDE_AUDIT_PROMPT.md"
Write-Host ""
Write-Host "  Option B — Cursor: open this repo, paste CLAUDE_AUDIT_PROMPT.md into Agent"
Write-Host ""
Write-Host "  Option C — claude.ai: zip the repo (exclude node_modules, .next, data/) and attach"
Write-Host ""
Write-Host "  Main branch (latest): https://github.com/bexgonz37/optiscan"
Write-Host "  Feature branch:       https://github.com/bexgonz37/optiscan/tree/feature/alert-lab"
Write-Host ""

if ($OpenPrompt) { notepad $promptPath }

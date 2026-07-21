# OPTIONS_CALLOUT_RUNTIME_FLOW

One public message per play. Internal states FORMING / READY / SENT / REJECTED / TOO_LATE / EXPIRED.

## Flow (`lib/research/options/loop.ts evaluateOptionsCandidate`)
```
candidate (decision-time) → selectOptionsStrategy → selectContractFromChain (nearest delta in band)
  → evaluateCallout (contract gate + freshness/chase) → READY? build public message
  → (REAL_OPTION_PAPER_ENABLED) real-option paper entry
  → AFTERWARD, async & off critical path: AI shadow + analog shadow + strategy/missed comparison
```
The callout is produced by DETERMINISTIC evidence only. It does NOT wait for AI, analog, deep
research, nightly analysis, or historical replay — those run asynchronously for grading/improvement.

## Public format (`formatCallout`) — built, NOT auto-sent
```
HOOD CALL
$XX — MM/DD
Entry: $X.XX–$X.XX
Targets: $X.XX / $X.XX
Why: breakout forming with accelerating volume and liquid call activity.
```
Only a READY play yields a message; there is NO second public confirmation message. Public delivery is
gated by `EARLY_OPTIONS_CALLOUTS_ENABLED` (OFF) and is NOT wired to a webhook in this step — a
research-only put must never be delivered as public actionable. `runOptionsCandidate` is fire-and-
forget and cannot affect the live scanner.

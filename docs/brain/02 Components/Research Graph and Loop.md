# Research Graph and Loop

Graph Engineering and Loop Engineering memory for the OptiScan research arm.
Updated 2026-08-18. Companion to the AST graph in `graphify-out/` — that one is
generated, this one records the parts a parser cannot see: which identity a consumer
joins on, and which of them fail SILENTLY when the join is wrong.

---

## GRAPH — the live dependency chain

Read the identity column first. Every defect this repository has recorded in the last
month was a consumer joining on an identifier the object does not carry, returning the
empty set, and reporting it as a quiet day.

| # | Stage | Owns | Joined by | Silent-failure risk |
|---|---|---|---|---|
| 1 | LIVE OPPORTUNITY | `options_candidates`, the pending audit case | `opportunity_fingerprint` | — |
| 2 | STRATEGY EVALUATION | `case_json.strategyEvaluations[]` (~27 per case) | **`strategyId` of the SELECTED strategy** | Reading `[0]` or the strongest reports a strategy that was never traded |
| 3 | CALLOUT | `discord_deliveries` (`owner_intraday_actionable`, `OPENING`, `SENT`) | `opportunity_case_id` | The only proof an owner was *told*; a mirror proves only that a trade was tracked |
| 4 | OWNER CASE | the CLAIM `opportunity_cases` row minted at delivery | `opportunity_id` | **Two case rows per callout.** The pending audit case owns the observation; the claim case owns the mirror |
| 5 | EXACT OCC MIRROR | `options_paper_trades` where `paper_kind='OWNER_VALIDATION_PAPER'` | `feature_snapshot_json.opportunityCaseId` | **`alert_id` is NULL on every owner row** — 0 of 74. Six consumers joined on it and all returned the empty set |
| 6 | MARKS | `options_paper_marks` | `trade_id` **AND** `option_symbol` | A mark on a re-selected strike is a different instrument; it must never enter this decision's excursion |
| 7 | GRADING | realized return, MFE/MAE recomputed from same-contract marks | mirror id | Stored `mfe_pct` is wrong on 36 of 78 delivered cases — never read it |
| 8 | PRE_MOVE V1 | `opportunity_pre_move_discovery` (V1 columns) | the PENDING case id, claim id as fallback | Promotion keyed on the claim id alone matched ZERO rows for its entire life |
| 8b | **PRE_MOVE V2** | same row, `v2_*` columns | same two ids | `v2_captured=0` means NOT a V2 row — excluded, never counted UNGRADABLE |
| 9 | OWNER LEARNING | `buildOwnerLearningReportOnDb` | `owner-mirror-identity.ts` | The single resolver; a seventh consumer must not reinvent the broken one |
| 10 | NIGHTLY RESEARCH | `buildAiResearchContextOnDb` | the report above | An absent section reads exactly like a quiet one |
| 11 | WEEKLY RESEARCH | `runWeeklyResearchOnDb` + the same context | week key | Same |
| 12 | HISTORICAL PROBABILITY | `HISTORICAL_COHORT_V1:paperKind=OWNER_VALIDATION_PAPER` | case ids via the mirror | A null `session_date` is an independence count of ZERO, not a missing label |
| 13 | SHADOW EXPERIMENT | `OWNER_SELECTION_STRENGTH_GATE_V1` scoreboard | owner learning rows | Both arms must share ONE population; 41 vs 67 is two populations |
| 14 | PRIVATE APP | `/api/research/command-center` | the builders above | — |
| 15 | ASK OPTISCAN | `advisory-chat` + `explain-target` | **stable IDs only** | A trade resolved from ticker text has more than one answer |
| 16 | OWNER DISCORD | `DISCORD_WEBHOOK_RECAP` / owner opening | — | — |
| 17 | SUBSCRIBER DISCORD | `options_alerts` + `DELIVERED_ALERT_PAPER` | `alert_id` | **Structurally cannot see an owner callout** — that is the safety property |
| 18 | CONTENT / TWITTER | `content_drafts` → `DISCORD_WEBHOOK_CONTENT` | `verifyContentClaimForCase` | Requires a SENT alert with a delivered mirror; an owner callout has neither |

### Shared fields and every downstream consumer

Before changing one of these, this is the list to walk.

- **`opportunity_case_id`** — the pending/claim pair. Consumers: pre-move V1 + V2,
  owner mirror identity, owner learning, cohort membership, content claim integrity,
  explain-target. `preMoveCaseIdForFingerprint` derives the pending id as a pure
  function of the fingerprint; it is never stored.
- **`option_symbol` (exact OCC)** — mirror, marks, excursion, cohort, content, explain.
  An OCC mismatch is CENSORED, never priced.
- **`paper_kind`** — the ONLY thing separating owner from subscriber in one table.
- **`session_date`** — independence counting everywhere. Validated: a weekend never
  counts toward a floor.
- **`v2_captured`** — new. Divides the V2 population from everything that predates it.

---

## LOOP — what runs without the owner

```
OBSERVE      scanner tick → pre-move V1 observation (write-once detection)
   ↓
CALLOUT      delivery-decision → Discord opening → exact-OCC mirror
             → pre-move V1 alert promotion
             → PRE_MOVE V2 alert-instant snapshot        ← NEW, write-once at the send
   ↓
TRACK        marks on the frozen contract only
   ↓
GRADE        realized return, MFE/MAE recomputed, path label, stop/gap evidence
   ↓
LEARN        owner learning report → findings store
   ↓
COMPARE      historical cohort probabilities (20 trades / 5 independent sessions)
   ↓
SHADOW TEST  OWNER_SELECTION_STRENGTH_GATE_V1 scoreboard, prospective only
   ↓
PROSPECTIVE  nightly (after 20:15 ET, trading weekdays) — deterministic first,
VALIDATION   AI narration second and optional
             weekly (Fri ≥21:00 ET or Sat) — the ONLY place an experiment status moves
   ↓
HUMAN REVIEW /research/command-center · Explain This · READY_FOR_HUMAN_REVIEW at most
   ↓
OBSERVE AGAIN
```

### What is automatic

- The scanner loop, the callout, the mirror, the marks and the grading.
- **Both** pre-move captures. V2 needs no separate job: it writes at the send.
- The nightly and weekly schedules, both gated on the combined `$20/month` AI cap and
  both structured so the deterministic half survives any model failure.
- The experiment scoreboard, recomputed on every read from persisted outcomes.

### What is NOT automatic, by construction

- Promotion of any experiment. The best reachable status is `READY_FOR_HUMAN_REVIEW`.
- Subscriber enablement. A named human act, taken elsewhere.
- Posting to X/Twitter. Drafts are generated, held and copied by hand.
- Any change to a threshold, target, stop, exit or ranking weight.

### Where the loop can go quiet without erroring

1. A consumer joining on `alert_id` for an owner row → empty set, reads as a quiet day.
   Guarded by `tests/cross-output-consistency.test.mjs`, which requires six surfaces to
   agree about one callout that definitely exists.
2. A research context section that fails to build → `null`, reads as nothing to report.
   Guarded by the no-empty-object assertion in
   `tests/weekly-wiring-and-lane-separation.test.mjs`.
3. A webhook variable holding a copy of another lane's URL → every diagnostic reads
   CONFIGURED. Guarded by `lib/notifications/lane-separation.ts`.

---

## Frozen definitions

Do not update a recorded hash to make a check pass. Register the next version.

| Definition | Hash | Prospective from |
|---|---|---|
| `LHC_SELECT_V1` | `80e5c5d878f5f9e185661981c87afc63` | — |
| `OWNER_SELECTION_STRENGTH_GATE_V1` | `9b4f77b3c6268bf9e94781dc849ad2ef` | 2026-08-19 |
| `PRE_MOVE_DISCOVERY_V2` | `e6eb1148e3bbd29fc4b71c657afbcafc` | at first capture |

Each hash is content-addressed by BEHAVIOUR, not source text: the definition is probed
across a sweep of inputs, so a moved threshold or a reordered branch changes the hash
even when the constants still read the same. Reordering the branches is exactly what
went wrong in PRE_MOVE V1.

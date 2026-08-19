# Canonical OptiScan Terminology

> GENERATED from `lib/terminology.ts`. Do not hand-edit definitions here.

Registry version: `TERMINOLOGY_V1`

## NBBO

National Best Bid and Offer: the highest displayed bid and lowest displayed ask across reporting US venues for the exact contract.

- Formula: `max(venue bids) / min(venue asks)`
- Unit: price
- Interpretation: Tighter and fresher is generally more executable.
- Authority: `MARKET_STANDARD`
- Entry convention: A buy-at-ask label must use the contemporaneous ask; exits must name their bid/mid convention.
- Point-in-time caveat: A later NBBO cannot be substituted for the evaluation-time quote.
- Evidence requirement: Exact OCC, bid, ask, provider timestamp, observation timestamp, and freshness policy.
- Aliases: national best bid and offer, best bid/ask

## OCC contract

The exact option symbol used to prevent marks, trades, or outcomes from a nearby contract being joined to the evaluated contract.

- Interpretation: Identity must match exactly; similarity is not enough.
- Authority: `MARKET_STANDARD`
- Entry convention: Not applicable
- Point-in-time caveat: The contract must be frozen at evaluation; re-selection after the outcome is leakage.
- Evidence requirement: Exact normalized OCC plus session and episode/case identity.
- Aliases: exact OCC, option symbol, contract identity

## MFE

Maximum favorable excursion over a declared forward horizon, computed from the exact instrument and executable mark convention.

- Formula: `max(forward executable return)`
- Unit: %
- Interpretation: Higher means more favorable movement was available, not that it was realized.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: Must name entry and forward exit marks, such as buy at ask and mark at future bid.
- Point-in-time caveat: MFE is a forward label and is forbidden from the episode's evaluation-time state.
- Evidence requirement: Sufficient forward coverage with exact identity; otherwise null/censored.
- Aliases: maximum favorable excursion

## MAE

Maximum adverse excursion over a declared forward horizon, computed from the exact instrument and executable mark convention.

- Formula: `min(forward executable return)`
- Unit: %
- Interpretation: Closer to zero means less adverse movement; it is not automatically a stop recommendation.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: Must use the same declared entry/mark convention as the outcome family.
- Point-in-time caveat: MAE is a forward label and is forbidden from evaluation-time features.
- Evidence requirement: Sufficient forward coverage with exact identity; otherwise null/censored.
- Aliases: maximum adverse excursion

## Expectancy

The arithmetic mean of realized or explicitly labeled returns for one named population, convention, and horizon.

- Formula: `mean(return) = win_rate×avg_win − loss_rate×avg_loss`
- Unit: % or currency per observation
- Interpretation: Positive is favorable only when sample quality, independence, and tail dependence are acceptable.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: All returns in the population must share an explicit convention.
- Point-in-time caveat: Historical expectancy may inform research but cannot be inserted as a future fact in a frozen episode.
- Evidence requirement: Named cohort, sample size, independent sessions, coverage, censoring, and tail diagnostics.
- Aliases: expected return, average return per trade

## Profit factor

A cohort-level payoff statistic that must be reported with sample size and sensitivity to the largest winner.

- Formula: `sum(positive returns) / abs(sum(negative returns))`
- Unit: ratio
- Interpretation: Above 1 means measured gains exceeded losses; it does not prove durable edge.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: Population returns must use one consistent convention.
- Point-in-time caveat: Computed only after outcomes exist, and one unusually large winner can make an otherwise weak population look durable.
- Evidence requirement: Closed supported outcomes, PF excluding best winner, independent sessions, and cohort definition.
- Aliases: PF, profit factor

## Baseline

The predeclared control used to measure whether a shadow rule improves losses without sacrificing winners or changing the eligible population.

- Interpretation: A comparison is invalid if the baseline population or period changes after results are seen.
- Authority: `OPTISCAN_RESEARCH_GOVERNANCE`
- Entry convention: Not applicable
- Point-in-time caveat: Freeze before prospective outcomes accrue.
- Evidence requirement: Version/hash, population, dates, inclusion rules, and unchanged comparator.
- Aliases: control, benchmark arm

## Shadow

A parallel evaluation recorded at decision time so it can be compared later while leaving strategies, gates, subscribers, and execution unchanged.

- Interpretation: Shadow evidence can support human review; it cannot authorize itself.
- Authority: `OPTISCAN_RESEARCH_GOVERNANCE`
- Entry convention: Not applicable
- Point-in-time caveat: Definition and hash must be frozen before outcomes.
- Evidence requirement: Immutable definition/hash, prospective registration, population identity, and outcome coverage.
- Aliases: shadow experiment, research only

## Winner retention

The cost side of a proposed filter, always reported beside loss rejection on the same eligible population.

- Formula: `kept baseline winners / all baseline winners`
- Unit: %
- Interpretation: Higher is better, but uncertainty matters with few winners.
- Authority: `OPTISCAN_RESEARCH_GOVERNANCE`
- Entry convention: Not applicable
- Point-in-time caveat: The filter must be fixed before prospective outcomes are labeled.
- Evidence requirement: Same eligible population for baseline and shadow, with missing evidence excluded rather than called rejected.
- Aliases: winner keep rate

## Loss rejection

The measured benefit of a proposed filter, meaningful only with winner retention on the same population.

- Formula: `rejected baseline losses / all baseline losses`
- Unit: %
- Interpretation: Higher is favorable only if winner retention remains acceptable.
- Authority: `OPTISCAN_RESEARCH_GOVERNANCE`
- Entry convention: Not applicable
- Point-in-time caveat: The filter must be fixed before prospective outcomes are labeled; this number is meaningless without winner retention beside it.
- Evidence requirement: Same eligible population, complete outcome accounting, and explicit unknown bucket.
- Aliases: loser rejection

## Evidence quality

A structural status describing identity, timestamps, entry convention, forward coverage, censoring, sample independence, and source reliability.

- Interpretation: Verified exact evidence is strongest; missing is unknown, never zero.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: Included in the quality assessment.
- Point-in-time caveat: Quality at evaluation and quality of later labels are separate fields.
- Evidence requirement: Provenance, as-of time, quality status, and missing reason for every canonical value.
- Aliases: data quality, evidence grade

## Independent sessions

A guard against treating many observations from one market day as independent repetitions of an effect.

- Formula: `count(distinct validated trading_session)`
- Unit: sessions
- Interpretation: More regime-diverse sessions generally strengthen evidence.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: Not applicable
- Point-in-time caveat: Session membership must come from contemporaneous timestamps and the exchange calendar.
- Evidence requirement: Validated session dates; holidays and malformed dates do not count.
- Aliases: session count, independent days

## Reward remaining

A point-in-time feature comparing current state with a target known at evaluation; it is not the later maximum return.

- Formula: `remaining target distance / total modeled target distance`
- Unit: ratio or %
- Interpretation: Higher may mean more room, but only after the feature demonstrates out-of-sample discrimination.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: Not applicable
- Point-in-time caveat: Target inputs must be frozen at T0; the current near-constant implementation has not discriminated anything yet, and no session high or later outcome may enter.
- Evidence requirement: Frozen target method/version and nondegeneracy checks.
- Aliases: remaining opportunity

## Move consumed

A point-in-time chase feature; bullish and bearish movement must be signed consistently and must not use later extrema.

- Formula: `consumed favorable distance / modeled total distance`
- Unit: ratio or %
- Interpretation: Lower generally means earlier, provided the denominator is legitimate.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: Not applicable
- Point-in-time caveat: Use only levels known at T0; later HOD/LOD is leakage.
- Evidence requirement: Direction, frozen origin/target, formula version, and valid denominator.
- Aliases: confirmation cost, move already used

## Discovery stage

A prospective stage classification from the frozen PRE_MOVE_DISCOVERY_V2 definition; it describes state at observation and is evaluated only after independent forward outcomes accrue.

- Interpretation: Earlier is useful only when later confirmation and executable outcomes support it.
- Authority: `OPTISCAN_RESEARCH_GOVERNANCE`
- Entry convention: Not applicable
- Point-in-time caveat: Never recompute the stage using later prices; use the frozen definition hash.
- Evidence requirement: Prospective V2 capture, frozen hash, valid T0 fields, closed outcomes, and independent sessions.
- Aliases: pre-move stage, earliness stage

## Setup episode

SetupEpisodeV2 stores provenance-bearing underlying, option, and OptiScan state separately from actions and forward outcome labels.

- Interpretation: It is the canonical market-memory unit, not necessarily a trade.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: Exact-option evidence names its contract and quote convention.
- Point-in-time caveat: Zone A rejects future timestamps and outcome fields.
- Evidence requirement: Durable identity, T0, config digest, feature versions, provenance, and explicit missing reasons.
- Aliases: episode, SetupEpisodeV2

## Historical analog

A historical SetupEpisode state used for empirical next-event evidence without importing its outcome into the current feature vector.

- Interpretation: Useful only with adequate independent samples and stable similarity features.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: Outcome comparisons must use compatible instruments and conventions.
- Point-in-time caveat: Similarity uses Zone A only; outcomes remain labels.
- Evidence requirement: Point-in-time-safe episodes, frozen similarity version, distances, sample/session counts, and drift checks.
- Aliases: analog, nearest historical setup

## Expected value

A deterministic empirical estimate from actual forward labels, including adverse outcomes and costs; it is not an LLM opinion.

- Formula: `sum(probability_i × payoff_i) − modeled costs`
- Unit: % or currency per opportunity
- Interpretation: Positive is favorable only when calibrated, stable, and supported out of sample.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: Entry, exit, spread, and cost conventions must be explicit.
- Point-in-time caveat: At live T0, only a precomputed historical estimate may be read; current future outcomes are unavailable.
- Evidence requirement: Calibrated empirical distribution, sample/session count, quality, drift, and uncertainty.
- Aliases: EV, expected return

## Capture efficiency

It compares realized return with MFE under compatible entry and marking conventions.

- Formula: `realized favorable return / MFE`
- Unit: %
- Interpretation: Higher means more of the available favorable excursion was retained.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: Realized return and MFE must share the same frozen entry basis.
- Point-in-time caveat: This is a post-outcome management label, never an evaluation-time feature.
- Evidence requirement: Realized return, MFE, exact identity, and compatible conventions.
- Aliases: capture efficiency

## Delta band

It constrains contract sensitivity for one strategy/version and is not itself a probability forecast.

- Formula: `min_delta ≤ abs(delta) ≤ max_delta`
- Unit: delta
- Interpretation: Inside means eligible for that selector rule; outside does not mean intrinsically bad.
- Authority: `OPTISCAN_RESEARCH_GOVERNANCE`
- Entry convention: Not applicable
- Point-in-time caveat: Use the delta available with the evaluation-time contract evidence.
- Evidence requirement: Exact contract, delta source/as-of time, and selector version.
- Aliases: delta band, delta range

## T1

T1 is a target level defined by the governing strategy/exit policy at entry.

- Unit: option price
- Interpretation: A target is a policy level, not a guaranteed outcome.
- Authority: `OPTISCAN_RESEARCH_GOVERNANCE`
- Entry convention: Frozen from the same entry policy as the trade.
- Point-in-time caveat: It may not be moved after seeing the outcome when evaluating policy performance.
- Evidence requirement: Strategy/config version, entry basis, and frozen target value.
- Aliases: first target

## T2

T2 is a farther target level defined by the governing strategy/exit policy at entry.

- Unit: option price
- Interpretation: A target is a policy level, not a guaranteed outcome.
- Authority: `OPTISCAN_RESEARCH_GOVERNANCE`
- Entry convention: Frozen from the same entry policy as the trade.
- Point-in-time caveat: It may not be moved after seeing the outcome when evaluating policy performance.
- Evidence requirement: Strategy/config version, entry basis, and frozen target value.
- Aliases: second target

## 0DTE

A same-day-expiry contract with high gamma and rapid time decay; strategy permissions remain separately versioned.

- Formula: `expiration_date = trading_date`
- Interpretation: A horizon/risk class, not a quality rating.
- Authority: `MARKET_STANDARD`
- Entry convention: Not applicable
- Point-in-time caveat: DTE must be computed from the evaluation session and exact expiration.
- Evidence requirement: Exact OCC, expiration, trading session, and DTE calculation.
- Aliases: same-day expiry

## VWAP

VWAP summarizes traded price weighted by volume using only bars available through T0.

- Formula: `sum(typical_price × volume) / sum(volume)`
- Unit: underlying price
- Interpretation: Price relative to VWAP can describe session control; it is not sufficient alone.
- Authority: `MARKET_STANDARD`
- Entry convention: Not applicable
- Point-in-time caveat: Only bars ending by T0 may enter; extended-hours inclusion must be explicit.
- Evidence requirement: Timestamped underlying bars, session convention, and formula version.
- Aliases: volume-weighted average price

## Counterfactual

A structurally separate research action recording what would be measured under an exact contract and explicit entry convention.

- Interpretation: It can teach opportunity quality but must never be reported as an actual trade.
- Authority: `OPTISCAN_RESEARCH_GOVERNANCE`
- Entry convention: Requires exact OCC and defensible contemporaneous entry.
- Point-in-time caveat: Eligibility and entry are frozen before outcomes.
- Evidence requirement: Observation episode, exact contract, fresh executable quote, explicit convention, and no paper/trade claim.
- Aliases: would-have-traded, untraded eligible setup

## Paper trade

A structurally recorded simulated action with its own entry, position lifecycle, marks, and exits; it is distinct from observations and counterfactuals.

- Interpretation: Useful forward evidence, but simulated fills are not live-money fills.
- Authority: `OPTISCAN_EVIDENCE`
- Entry convention: Uses the frozen paper entry/exit policy recorded with the action.
- Point-in-time caveat: The action time and entry cannot be backfilled from later favorable marks.
- Evidence requirement: Paper action row, exact identity, fill convention, timestamps, and complete outcome coverage.
- Aliases: simulated trade, paper position

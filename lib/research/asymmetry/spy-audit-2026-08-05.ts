/**
 * spy-audit-2026-08-05.ts — the frozen result of the called-versus-missed audit.
 *
 * PURE DATA. No DB, no provider, no clock. Every number here was produced by
 * NBBO verification against historical /v3/quotes and by OptiScan's own notify
 * journal, and is recorded so the owner surface cannot drift from what was
 * actually measured.
 *
 * THIS IS HISTORY, NOT A SIGNAL. Nothing in this module may be rendered beside
 * live opportunities, and nothing here can create an alert, select a contract,
 * or change a threshold. Every contract named below has already expired.
 */

export const SPY_AUDIT_VERSION = "SPY_AUDIT_2026_08_05_V1" as const;

/** How each number was obtained, so a reader can weigh it. */
export type EvidenceGrade =
  /** Historical NBBO: an ask that could have been paid, a bid that could have been hit. */
  | "NBBO_VERIFIED"
  /** OptiScan's own persisted decision rows. */
  | "JOURNAL"
  /** Trade-derived aggregates. Shows where it printed, not what was payable. */
  | "TRADE_DERIVED"
  /** A stratified sample, not the full population. */
  | "SAMPLED";

export interface MissedWinner {
  occ: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
  dte: number;
  /** The number a last-trade percentage display would have shown. Not payable. */
  apparentGainPct: number;
  /** Ask at 10:30 ET — one fixed instant for every contract, chosen from the
   *  underlying alone before any contract was priced. No hindsight. */
  decisionAsk: number;
  entrySpreadPct: number;
  peakBid: number;
  peakBidET: string;
  peakBidSize: number;
  /** Executable ask-to-bid return from the decision instant. */
  mfePct: number;
  maePct: number;
  contractVolume: number;
  whyMissed: string;
  classification: string;
}

/**
 * Every SPY contract on 2026-08-05 that a real buyer could have paid for at a
 * fixed 10:30 ET instant and later sold into a real bid for a material gain.
 *
 * ALL TWELVE ARE PUTS. SPY's best UP leg that session was +0.30%; its best DOWN
 * leg was -0.94%. There was no call opportunity to miss.
 */
export const VERIFIED_MISSED_WINNERS: readonly MissedWinner[] = Object.freeze([
  { occ: "O:SPY260805P00772000", side: "put", strike: 772, expiration: "2026-08-05", dte: 0, apparentGainPct: 358, decisionAsk: 0.90, entrySpreadPct: 1.11, peakBid: 2.73, peakBidET: "12:09:23", peakBidSize: 34, mfePct: 203, maePct: -39, contractVolume: 537970, classification: "VERIFIED_EXECUTABLE_WINNER", whyMissed: "0DTE contract. OptiScan never requested the 0DTE part of the SPY chain that day, so this contract was never seen, never ranked and never quoted." },
  { occ: "O:SPY260805P00771000", side: "put", strike: 771, expiration: "2026-08-05", dte: 0, apparentGainPct: 750, decisionAsk: 0.69, entrySpreadPct: 1.45, peakBid: 2.09, peakBidET: "12:09:23", peakBidSize: 167, mfePct: 203, maePct: -71, contractVolume: 770105, classification: "VERIFIED_EXECUTABLE_WINNER", whyMissed: "0DTE contract, never fetched." },
  { occ: "O:SPY260805P00773000", side: "put", strike: 773, expiration: "2026-08-05", dte: 0, apparentGainPct: 336, decisionAsk: 1.17, entrySpreadPct: 0.85, peakBid: 3.48, peakBidET: "12:09:23", peakBidSize: 34, mfePct: 197, maePct: -10, contractVolume: 347024, classification: "VERIFIED_EXECUTABLE_WINNER", whyMissed: "0DTE contract, never fetched." },
  { occ: "O:SPY260805P00770000", side: "put", strike: 770, expiration: "2026-08-05", dte: 0, apparentGainPct: 3450, decisionAsk: 0.53, entrySpreadPct: 1.89, peakBid: 1.56, peakBidET: "12:09:23", peakBidSize: 256, mfePct: 194, maePct: -87, contractVolume: 668320, classification: "VERIFIED_EXECUTABLE_WINNER", whyMissed: "0DTE contract, never fetched. The headline 3,450% is the 0.02 close-of-day low against the 0.71 high; from a payable 10:30 ask it was +194%." },
  { occ: "O:SPY260805P00774000", side: "put", strike: 774, expiration: "2026-08-05", dte: 0, apparentGainPct: 323, decisionAsk: 1.53, entrySpreadPct: 0.65, peakBid: 4.38, peakBidET: "15:59:56", peakBidSize: 150, mfePct: 186, maePct: -8, contractVolume: 252270, classification: "VERIFIED_EXECUTABLE_WINNER", whyMissed: "0DTE contract, never fetched." },
  { occ: "O:SPY260805P00769000", side: "put", strike: 769, expiration: "2026-08-05", dte: 0, apparentGainPct: 2200, decisionAsk: 0.41, entrySpreadPct: 2.44, peakBid: 1.14, peakBidET: "12:09:23", peakBidSize: 164, mfePct: 178, maePct: -93, contractVolume: 341643, classification: "VERIFIED_EXECUTABLE_WINNER", whyMissed: "0DTE contract, never fetched. The headline 2,200% is a four-minute 0.01-to-0.23 move in the closing minutes." },
  { occ: "O:SPY260805P00775000", side: "put", strike: 775, expiration: "2026-08-05", dte: 0, apparentGainPct: 301, decisionAsk: 1.98, entrySpreadPct: 0.51, peakBid: 5.38, peakBidET: "15:59:56", peakBidSize: 150, mfePct: 172, maePct: -7, contractVolume: 216540, classification: "VERIFIED_EXECUTABLE_WINNER", whyMissed: "0DTE contract, never fetched." },
  { occ: "O:SPY260805P00768000", side: "put", strike: 768, expiration: "2026-08-05", dte: 0, apparentGainPct: 600, decisionAsk: 0.32, entrySpreadPct: 3.13, peakBid: 0.82, peakBidET: "12:09:23", peakBidSize: 220, mfePct: 156, maePct: -94, contractVolume: 284418, classification: "VERIFIED_EXECUTABLE_WINNER", whyMissed: "0DTE contract, never fetched." },
  { occ: "O:SPY260805P00767000", side: "put", strike: 767, expiration: "2026-08-05", dte: 0, apparentGainPct: 247, decisionAsk: 0.25, entrySpreadPct: 4.00, peakBid: 0.58, peakBidET: "12:09:23", peakBidSize: 581, mfePct: 132, maePct: -96, contractVolume: 158613, classification: "VERIFIED_EXECUTABLE_WINNER", whyMissed: "0DTE contract, never fetched." },
  { occ: "O:SPY260805P00766000", side: "put", strike: 766, expiration: "2026-08-05", dte: 0, apparentGainPct: 231, decisionAsk: 0.20, entrySpreadPct: 5.00, peakBid: 0.41, peakBidET: "11:18:10", peakBidSize: 73, mfePct: 105, maePct: -95, contractVolume: 133087, classification: "VERIFIED_EXECUTABLE_WINNER", whyMissed: "0DTE contract, never fetched." },
  { occ: "O:SPY260805P00765000", side: "put", strike: 765, expiration: "2026-08-05", dte: 0, apparentGainPct: 200, decisionAsk: 0.16, entrySpreadPct: 6.25, peakBid: 0.32, peakBidET: "11:18:11", peakBidSize: 162, mfePct: 100, maePct: 19, contractVolume: 143254, classification: "VERIFIED_EXECUTABLE_WINNER", whyMissed: "0DTE contract, never fetched." },
  { occ: "O:SPY260806P00770000", side: "put", strike: 770, expiration: "2026-08-06", dte: 1, apparentGainPct: 226, decisionAsk: 1.48, entrySpreadPct: 1.35, peakBid: 2.77, peakBidET: "12:09:24", peakBidSize: 50, mfePct: 87, maePct: -13, contractVolume: 80042, classification: "VERIFIED_EXECUTABLE_WINNER", whyMissed: "1DTE, so the chain WAS fetched. OptiScan looked at the 774 strike on this expiry, not the 770. Wrong contract selected, not a missing chain." },
]);

/**
 * The contract OptiScan DID see, on the right side, and rejected. This one is
 * not a coverage gap — it is the gate refusing a good entry on a clock rule.
 */
export const REJECTED_BUT_GOOD = Object.freeze({
  occ: "O:SPY260806P00774000",
  session: "2026-08-05",
  firstSeenET: "10:05:47",
  firstSeenAction: "OWNER_WATCH",
  firstSeenReason: "CONFIRMING_EVIDENCE_INCOMPLETE_9",
  rejectedET: "10:09:01",
  rejectedReason: "ENTRY_TOO_LATE_6M",
  rejectedAsk: 2.58,
  spreadPct: 1.16,
  askSize: 222,
  peakBid: 5.08,
  peakBidET: "12:09:23",
  peakBidSize: 70,
  mfePct: 97,
  maePct: -15,
  ceilingThatRejectedItMs: 30_000,
  plainLanguage:
    "OptiScan found this trade, on the correct side, in a liquid contract with a "
    + "1.2% spread. It then refused to mention it because the setup had first been "
    + "noticed six minutes earlier. The ceiling it breached was THIRTY SECONDS, "
    + "borrowed from the strategy's quote-freshness setting — for a strategy whose "
    + "own declared holding horizon is 'hours to 2 days'. From the exact moment it "
    + "was called too late, the contract rose 97% over two hours, having first dipped "
    + "only 15%.",
});

/** What the alerts that DID go out actually did. Stratified sample of 862. */
export const ALERT_SCORECARD = Object.freeze({
  evidence: "NBBO_VERIFIED" as EvidenceGrade,
  sampling: "SAMPLED" as EvidenceGrade,
  sessions: ["2026-07-31", "2026-08-03", "2026-08-04", "2026-08-06"],
  alertsIssuedTotal: 862,
  sampled: 181,
  scored: 167,
  reachedPlus25Pct: 18.6,
  immediateFailurePct: 59.9,
  medianMfePct: 1.6,
  medianMaePct: -15.8,
  medianEndOfDayPct: -9.0,
  profitFactor: 0.49,
  expectancyPct: -7.2,
  perSession: Object.freeze([
    { session: "2026-07-31", cases: 135, alerts: 72, alertToCapturePct: 53.3, sampled: 54, goodPct: 17, immediateFailPct: 70, medianMfePct: 0.0 },
    { session: "2026-08-03", cases: 989, alerts: 394, alertToCapturePct: 39.8, sampled: 53, goodPct: 21, immediateFailPct: 58, medianMfePct: 2.0 },
    { session: "2026-08-04", cases: 887, alerts: 395, alertToCapturePct: 44.5, sampled: 59, goodPct: 17, immediateFailPct: 53, medianMfePct: 3.3 },
    { session: "2026-08-05", cases: 502, alerts: 0, alertToCapturePct: 0.0, sampled: 0, goodPct: null, immediateFailPct: null, medianMfePct: null },
    { session: "2026-08-06", cases: 189, alerts: 1, alertToCapturePct: 0.5, sampled: 1, goodPct: 100, immediateFailPct: 0, medianMfePct: 70.3 },
  ]),
});

/** The single alert produced by the rebuilt gate, and what it did. */
export const FIRST_HIGH_ASYMMETRY_ALERT = Object.freeze({
  fingerprint: "2026-08-06|O:NFLX260807P00074000",
  symbol: "NFLX",
  occ: "O:NFLX260807P00074000",
  direction: "PUT",
  strategy: "pullback_continuation",
  decidedAtMs: 1786024048994,
  decidedET: "09:47:28",
  entryAsk: 0.74,
  entryBid: 0.72,
  spreadPct: 2.7,
  dte: 1,
  delta: -0.472,
  qualityScore: 88,
  premiumChasePct: 0,
  captureToNotifyMs: 10763,
  quoteAgeMs: 434,
  sendLatencyMs: 1872,
  delivered: true,
  deliveryEvidence: "notify_outcome=SENT on the journal row, and the matching asymmetry_transitions row carries notified=1 with notify_outcome=SENT.",
  mfePct: 70.3,
  maePct: -17.6,
  peakBidET: "10:12:00",
  verdict: "GOOD",
  plainLanguage:
    "It was delivered, and it was a good alert. Entered at a 0.74 ask with a 2.7% "
    + "spread and no premium expansion, it reached +70% within 25 minutes against a "
    + "17.6% drawdown. One alert is one alert — it is not yet evidence that the gate "
    + "is right, only that it is no longer wrong in the way it was.",
});

/** Why the counters disagreed. Resolved by proof, not by making them match. */
export const COUNTER_RECONCILIATION = Object.freeze({
  authoritative: "ratio.notified",
  authoritativeValue: 1,
  wrongCounter: "suppression.notifiedCaptures",
  wrongValue: 0,
  rootCause:
    "Number(url.searchParams.get('limit')) is 0 when the parameter is absent, and "
    + "Number.isFinite(0) is true, so the documented default of 200 was unreachable "
    + "and the endpoint read ONE row. ratio.* is a SQL aggregate over the whole "
    + "session and was correct. suppression.* and distributions.* are computed from "
    + "the row LIST, so they described a one-row session.",
  proof: "Same instant, same session: ?limit=1 gave notifiedCaptures 0 and immediateAlerts 0; ?limit=1000 gave 1 and 1, with ratio.decisions 199 in both.",
  collateralDamage:
    "The single surviving row was AVGO O:AVGO260810P00415000, rejected on "
    + "UNUSABLE_SPREAD_26.0. Because `distributions` was built from it, the previous "
    + "packet described the alert as strategy sr_reclaim. It was NFLX, "
    + "pullback_continuation.",
  historyChanged: false,
});

/** Causes, ranked by how much of the miss each explains. */
export const ROOT_CAUSES = Object.freeze([
  {
    cause: "THE 0DTE CHAIN IS NEVER REQUESTED",
    explains: "11 of the 12 verified missed winners",
    evidence: "JOURNAL" as EvidenceGrade,
    detail:
      "Across 5,562 journal rows and five sessions, 19 decisions (0.3%) involved a "
      + "contract expiring on the session date. On 2026-08-05 there were ZERO across "
      + "all 165 symbols and 1,056 decisions. Contract partitions are planned only "
      + "from the bands the matched strategy permits, and SPY matched only "
      + "pullback_continuation, sr_reclaim, reversal_bounce, breakout_forming and "
      + "longer_dated_swing — none of which permit 0DTE.",
    status: "PROVEN, NOT YET FIXED",
  },
  {
    cause: "THE INDEX AND BREAKDOWN STRATEGIES NEVER MATCH",
    explains: "why the 0DTE bands are never reachable for SPY",
    evidence: "JOURNAL" as EvidenceGrade,
    detail:
      "Eight of the twelve 0DTE-permitting strategies have never matched a single "
      + "candidate in any session with journal data — including zero_dte_index and "
      + "index_intraday_momentum, both written specifically for SPY and QQQ, and "
      + "momentum_breakdown, support_break_retest and bearish_opening_range_break, "
      + "the put-side strategies that describe exactly what SPY did on 2026-08-05.",
    status: "PROVEN, NOT YET FIXED",
  },
  {
    cause: "CANDIDATE AGE IS JUDGED BY A QUOTE-STALENESS CONSTANT",
    explains: "the one good SPY entry OptiScan found and refused",
    evidence: "JOURNAL" as EvidenceGrade,
    detail:
      "111 decisions were rejected as ENTRY_TOO_LATE on candidate age alone. Of "
      + "those, 82% still had at least 10% reward remaining and 91% had seen premium "
      + "expand by 10% or less, by the system's own measures. The ceilings in force "
      + "were 10 to 120 seconds because they are taken from strategy.freshnessMaxMs, "
      + "which describes how stale a QUOTE may be.",
    status: "FIX BUILT, OFF BY DEFAULT, EVIDENCE MIXED",
  },
]);

/** The proposed fix, and the honest verdict on its own replay. */
export const PROPOSED_FIX = Object.freeze({
  name: "Late-entry reprieve",
  flag: "ASYM_LATE_ENTRY_REPRIEVE_ENABLED",
  defaultState: "OFF",
  whatItDoes:
    "When a candidate is older than the age ceiling, it may still speak — but only "
    + "if premium expansion is under HALF the chase limit, the underlying is not "
    + "extended, reward remaining is above the strategy minimum, and the candidate "
    + "is under 15 minutes old. Any missing measure means no reprieve. Quote "
    + "staleness, spread, open interest, volume and chase gates are untouched.",
  replay: Object.freeze({
    evidence: "NBBO_VERIFIED" as EvidenceGrade,
    populationRejectedOnAge: 111,
    wouldRecover: 55,
    recoverySessions: ["2026-08-05", "2026-08-06"],
    recoveredReachedPlus25Pct: 20,
    recoveredImmediateFailurePct: 35,
    recoveredMedianMfePct: 9.9,
    recoveredMedianMaePct: -29.0,
    baselineReachedPlus25Pct: 18.6,
    baselineImmediateFailurePct: 59.9,
    baselineMedianMfePct: 1.6,
  }),
  verdict: "DO NOT ENABLE YET",
  verdictReason:
    "The recovered candidates fail immediately far less often (35% versus 60%) and "
    + "their median best-case is six times better (+9.9% versus +1.6%), but they "
    + "reach +25% barely more often (20% versus 18.6%) and draw down deeper "
    + "(-29% versus -15.8%). The case that motivated the rule went +97%; the MEDIAN "
    + "recovered case goes +9.9%. That is not repeated evidence, and the replay "
    + "covers only two sessions because earlier rows predate the metrics it needs. "
    + "It stays off and goes to shadow.",
  demotionTrigger:
    "If reprieved alerts show a lower +25% rate or a worse immediate-failure rate "
    + "than unreprieved ones over 30 shadow decisions, delete the rule.",
  providerCostImpact: "Zero. Every input is a value the gate already computes from rows already written.",
  evidenceStillMissing:
    "Sessions before 2026-08-05 carry no decisionMetrics, so the replay cannot reach "
    + "them. The 0DTE cause — which explains 11 of 12 misses — has no fix here at all.",
});

/** The headline the owner asked for, in plain language. */
export const PLAIN_SUMMARY = Object.freeze({
  question: "Did OptiScan miss SPY calls that produced extremely large returns on 2026-08-05?",
  answer:
    "No — because there were none. SPY's best upward leg that session was +0.30%; it "
    + "opened at 775.85, topped at 776.85 nine minutes in, and ground down to close at "
    + "769.79. Every call in the top-25 apparent-gain list is either a penny contract "
    + "moving from 0.01 to 0.05, or a single minute's high-to-low range at the close. "
    + "Not one SPY call was a verified executable winner.",
  whatWasActuallyMissed:
    "Twelve PUTS, eleven of them 0DTE. The best real trade available from a fixed "
    + "10:30 ET entry was +203%, not +3,450%.",
  biggestApparentVsReal: {
    occ: "O:SPY260805P00770000",
    apparentGainPct: 3450,
    executableGainPct: 194,
    why: "The 3,450% compares a 0.02 low in the final fifteen minutes with a 0.71 high. Nobody could have bought the 0.02.",
  },
  areAlertsGood:
    "Not in the audited window. Of 167 scored alerts from 2026-07-31 to 2026-08-04, "
    + "60% never gained more than 5%, the median alert's best moment was +1.6%, and "
    + "expectancy was -7.2% per alert with a profit factor of 0.49. The gate rebuilt "
    + "on 2026-08-06 has issued one alert, and that one was good (+70% in 25 minutes).",
  contractsWithVerified10000Pct: 0,
});

/**
 * metric-glossary.ts — the single source of truth for beginner education.
 *
 * Every metric, badge, score, and indicator shown anywhere in OptiScan has an
 * entry here. The <InfoTip> component renders these on hover (desktop) or tap
 * (mobile). One file to edit when wording changes; components never hardcode
 * explanations.
 *
 * Each entry answers, in plain English:
 *   what      — what the number/badge means
 *   why       — why it matters for options trading
 *   direction — whether higher or lower is generally better
 *   scoring   — how it feeds the overall scanner score / verdict
 *   risk      — limitations or ways it can mislead
 */
import { canonicalMetricGlossary } from "./terminology.ts";

export interface MetricInfo {
  label: string;
  what: string;
  why: string;
  direction: string;
  scoring: string;
  risk: string;
}

export const METRIC_GLOSSARY: Record<string, MetricInfo> = {
  speed: {
    label: "Speed (%/min)",
    what: "How fast the stock price is moving right now, measured as percent change per minute over the last ~10 seconds.",
    why: "0DTE options only pay when the stock moves NOW — a fast underlying move is what inflates a same-day option's value before time decay eats it.",
    direction: "Higher magnitude = stronger momentum (positive = up, negative = down). Near zero = nothing happening.",
    scoring: "This is the primary trigger: no callout fires unless speed clears the tunable threshold (default 0.17%/min).",
    risk: "Speed alone can be one big print or a spread-jump, not a real move — that's why volume surge and persistence must confirm it.",
  },
  surge: {
    label: "Volume surge",
    what: "Trading volume in the last ~15 seconds compared to the recent baseline. 2.0x means twice the normal pace.",
    why: "Price moves on real volume attract follow-through; moves on thin volume often snap back instantly.",
    direction: "Higher is better. Below ~1.3x the scanner treats a move as unconfirmed.",
    scoring: "Confirms the speed trigger — fast price + no volume = no callout.",
    risk: "A single block trade can spike surge for a moment. Surge decays fast; it says nothing about direction on its own.",
  },
  efficiency: {
    label: "Path efficiency",
    what: "How straight the price path is: net move divided by total back-and-forth travel. 1.0 = a straight line, near 0 = chop.",
    why: "A straight move means one side is in control — those moves extend. Choppy tape stops out option buyers over and over.",
    direction: "Higher is better. Below ~0.30 the scanner calls the tape 'choppy' and blocks directional callouts.",
    scoring: "A minimum efficiency is required to trigger; it also feeds the direction confidence.",
    risk: "Efficiency looks backward — a clean move can turn choppy the moment you enter.",
  },
  setupScore: {
    label: "Setup score (0–100)",
    what: "A combined 0–100 grade of the whole setup: speed, volume, efficiency, level breaks, VWAP position, and direction agreement.",
    why: "One number to rank opportunities — an 85 setup has more confirming evidence than a 65.",
    direction: "Higher is better. TRADE-tier callouts require roughly 84+; below ~60 is noise.",
    scoring: "It IS the headline score; the quality bar (TRADE vs WATCH) starts here.",
    risk: "A high score measures evidence, not certainty — plenty of 85s still lose. It cannot see news, halts, or what happens next.",
  },
  riskScore: {
    label: "Risk score (0–100)",
    what: "How dangerous this setup is: 0 = calm and liquid, 100 = extreme (wide spreads, thin volume, already-extended move).",
    why: "Even a good signal is untradable if fills are bad or the move is exhausted.",
    direction: "Lower is better. 75+ generally means skip regardless of setup score.",
    scoring: "High risk demotes or blocks callouts even when the setup score is strong.",
    risk: "Risk can change in seconds — a tight spread can blow out right as you click.",
  },
  spread: {
    label: "Bid/ask spread %",
    what: "The gap between what buyers pay and sellers ask, as a percent of the option's price. A $1.00 option quoted 0.95/1.05 has a ~10% spread.",
    why: "You pay the spread twice (entering and exiting). A 10% spread means the contract must move ~10% in your favor just to break even on the round trip.",
    direction: "Lower is better. OptiScan refuses to call any contract a BUY above 5%.",
    scoring: "Hard gate: a wide spread can never be a TRADE-tier callout no matter how fast the stock is moving.",
    risk: "Spreads widen exactly when things get volatile — the quote you saw may not be the fill you get.",
  },
  delta: {
    label: "Delta",
    what: "How much the option's price moves when the stock moves $1. A 0.50-delta call gains ~$0.50 per $1 up-move. Also a rough probability of expiring in the money.",
    why: "Delta is your exposure: too low and the stock move barely reaches the option; too high and you're paying for stock-like exposure with extra risk.",
    direction: "For momentum trades, the 0.35–0.65 zone balances payoff and probability. OptiScan requires it for BUY callouts.",
    scoring: "Contracts outside the delta zone are excluded from TRADE tier.",
    risk: "Delta changes as the stock moves (that's gamma) — a 0.40 delta can become 0.70 fast on a rip.",
  },
  iv: {
    label: "Implied volatility (IV)",
    what: "The market's guess at how much the stock will move, baked into the option's price. Higher IV = more expensive options.",
    why: "Buying high-IV options means the stock must move even more than expected for you to profit — you paid for the move in advance.",
    direction: "Context-dependent: cheap IV helps buyers; IV that collapses after you buy (e.g. post-earnings) hurts even if the stock goes your way.",
    scoring: "Feeds contract ranking and the worth-it check.",
    risk: "IV can crush suddenly after events. A winning direction can still be a losing trade if you overpaid on IV.",
  },
  openInterest: {
    label: "Open interest (OI)",
    what: "How many contracts of this exact strike/expiration exist. A measure of how established the market for it is.",
    why: "Higher OI usually means tighter spreads and easier exits — you're not stuck negotiating with one market maker.",
    direction: "Higher is better for tradability.",
    scoring: "Feeds the liquidity score.",
    risk: "OI updates only once a day (pre-market) — today's fresh strike can be liquid despite low OI.",
  },
  relVol: {
    label: "Relative volume (RVOL)",
    what: "Today's volume pace versus the stock's own normal at this time of day. 3x = trading three times its usual.",
    why: "Elevated RVOL means real participation — moves are more likely to follow through and fills are easier.",
    direction: "Higher is better; under 1x means quieter than normal.",
    scoring: "Confirms discovery promotion and feeds setup scoring.",
    risk: "RVOL is relative to the stock's own history — a 3x RVOL on an illiquid name can still be too thin to trade.",
  },
  vwap: {
    label: "VWAP",
    what: "Volume-Weighted Average Price — the day's average price weighted by volume. The institutional 'fair price' line for the session.",
    why: "Price above VWAP = buyers in control today; below = sellers. Momentum with VWAP on your side is much more reliable.",
    direction: "For calls you want price above VWAP; for puts, below.",
    scoring: "Counter-VWAP setups are blocked from BUY tier unless a level break confirms.",
    risk: "VWAP resets daily and means little in the first minutes; extended hours have thin-volume VWAPs.",
  },
  hodLod: {
    label: "HOD / LOD break",
    what: "Price breaking the High Of Day (HOD) or Low Of Day (LOD).",
    why: "Everyone watches these levels — breaks trigger stop orders and breakout buyers, which fuels continuation.",
    direction: "HOD break supports calls; LOD break supports puts.",
    scoring: "A level break lowers the other confirmation requirements slightly (it's strong evidence on its own).",
    risk: "False breaks are common: price pokes the level, triggers stops, and reverses. Persistence checks exist for this reason.",
  },
  confidence: {
    label: "Direction confidence",
    what: "How strongly the evidence agrees on a direction (bullish/bearish/choppy), from the vote margin of speed, acceleration, VWAP side, and level breaks.",
    why: "A directional option needs an actual direction — 'choppy' means both sides are fighting and premium burns while you wait.",
    direction: "Higher is better; 'choppy' at any confidence means stand aside.",
    scoring: "Low confidence blocks TRADE tier and lowers setup score.",
    risk: "Confidence measures agreement, not truth — unanimous evidence can still be wrong on a reversal.",
  },
  tier: {
    label: "TRADE / WATCH tier",
    what: "TRADE = every gate passed including a fillable contract — the highest-conviction callout. WATCH = interesting momentum that failed at least one gate.",
    why: "It separates 'this is the real thing' from 'keep an eye on it' so beginners don't chase every mover.",
    direction: "TRADE outranks WATCH; but a WATCH that keeps improving can graduate.",
    scoring: "The tier is the output of all other scores plus contract economics.",
    risk: "TRADE tier means gates passed at that instant — momentum can die seconds later. Always check the live verdict before acting.",
  },
  moveStatus: {
    label: "Move status",
    what: "Where in its lifecycle this move is: early, continuing, extended-but-tradable, chase-risk, or exhausted.",
    why: "Entering early pays; chasing an extended move buys someone else's exit.",
    direction: "'Early' and 'extended-tradable' qualify for BUY; 'chase-risk'/'exhausted' never do.",
    scoring: "Non-qualifying move status blocks TRADE tier.",
    risk: "Lifecycle labels come from today's tape only — a 'fresh' move can already be day three of a runner.",
  },
  mfe: {
    label: "Max favorable excursion (MFE)",
    what: "The best the trade EVER looked after entry — the peak unrealized gain before exit.",
    why: "Comparing MFE to your actual exit shows whether you're leaving money on the table or exiting well.",
    direction: "Higher MFE with an exit near it = good management. High MFE with a losing exit = the setup worked but the exit didn't.",
    scoring: "Used in accuracy grading and paper-trade lessons; never blended into realized returns.",
    risk: "MFE is hindsight — nobody exits at the exact peak. It's a learning metric, not a promise.",
  },
  mae: {
    label: "Max adverse excursion (MAE)",
    what: "The worst the trade looked after entry — the deepest unrealized loss before exit.",
    why: "Tells you how much heat this kind of setup takes before working, which is how you place stops that don't get clipped by noise.",
    direction: "Shallower (closer to zero) is better.",
    scoring: "Used in accuracy grading and stop-placement lessons.",
    risk: "One outlier MAE (a halt, a flash move) can distort averages — look at the distribution, not one trade.",
  },
  winRate: {
    label: "Win rate",
    what: "Percent of graded trades that closed profitable (realized returns only — peak moves don't count).",
    why: "Baseline health of the system — but only alongside average win/loss size.",
    direction: "Higher is better, but a 40% win rate with 3:1 winners beats a 70% win rate with 1:3 losers.",
    scoring: "Reported per score bucket and session so you can see WHERE the edge is.",
    risk: "Small samples lie. Under ~30 trades, win rate is mostly luck.",
  },
  profitFactor: {
    label: "Profit factor",
    what: "Total dollars won divided by total dollars lost. 1.5 means winners paid 1.5x what losers cost.",
    why: "Combines win rate and win size into one durability number.",
    direction: "Above 1.0 = profitable; 1.5+ is solid; below 1.0 = losing system.",
    scoring: "Headline stat on the paper-trading dashboard.",
    risk: "One giant winner can carry a bad system for weeks — check expectancy and drawdown too.",
  },
  expectancy: {
    label: "Expectancy",
    what: "Average profit/loss per trade: (win rate × avg win) − (loss rate × avg loss).",
    why: "The most honest single number: what one more trade of this system is worth on average.",
    direction: "Positive and stable is the goal.",
    scoring: "Headline stat on the paper-trading dashboard.",
    risk: "Assumes the future resembles the sample — regime changes reset everything.",
  },
  maxDrawdown: {
    label: "Max drawdown",
    what: "The largest peak-to-valley drop in cumulative P/L.",
    why: "Tells you the worst stretch you'd have had to sit through — the number that actually makes people quit systems.",
    direction: "Smaller is better.",
    scoring: "Headline stat on the paper-trading dashboard.",
    risk: "Past drawdown is a floor, not a ceiling — the worst drawdown is always ahead of you. Size accordingly.",
  },
  conviction: {
    label: "Conviction (0–100)",
    what: "How much independent evidence currently agrees with the strongest signal on screen: speed, volume, tape quality, direction agreement, and (when a callout is live) contract economics.",
    why: "One stable read of 'how seriously should I take what I'm seeing right now' — it is NOT a win probability and not a price target.",
    direction: "Higher = more agreeing evidence. The word matters more than the digits: LOW (<40) = nothing actionable, BUILDING (40–64) = watch, STRONG (65–84) = signal-grade, VERY STRONG (85+) = rare full agreement.",
    scoring: "Derived from the live verdict confidence or the leading candidate's speed+volume; sampled every 15 seconds so it reads as a level, not a jitter.",
    risk: "Evidence agreement is not certainty — very strong conviction setups still fail. If the band drops while you watch, that IS the information.",
  },
  setupGrade: {
    label: "Setup grade (A+ to F)",
    what: "A report-card grade for this TYPE of setup based on how it has actually performed historically: win rate, expectancy, profit factor, drawdown, and — critically — how many samples exist.",
    why: "It answers the question a raw alert can't: has this exact kind of move been worth trading before, or does it just look exciting?",
    direction: "A+/A = proven edge with real sample size. B = promising. C/D = unproven or weak. F = historically loses or almost no data.",
    scoring: "Grades require minimum sample sizes — a 90% win rate on 4 trades grades LOW, not high, because 4 trades proves nothing.",
    risk: "Historical edge is not a guarantee. Regimes change; an A setup can stop working. The grade tells you where the odds have been, not where they will be.",
  },
  sampleSize: {
    label: "Sample size (n)",
    what: "How many completed, graded trades of this setup type back the statistics.",
    why: "Every stat on this page is meaningless without it — small samples produce impressive-looking numbers by pure luck.",
    direction: "More is better. Under ~15, treat everything as noise; 30+ starts to mean something; 100+ is real evidence.",
    scoring: "Low sample size caps the confidence score and the grade no matter how good the other numbers look.",
    risk: "Even large samples came from past market conditions. n=500 from a bull market says little about a crash.",
  },
  quantPlan: {
    label: "Best Setup Plan",
    what: "A daily ranked summary: which setup types have historically earned their place (focus), which have not (avoid), with suggested stops, targets, and hold times derived from their own stats.",
    why: "Turns the scanner from 'something is moving' into 'this kind of move has/hasn't been worth your attention historically.'",
    direction: "Focus list = positive expectancy with acceptable samples. Avoid list = negative expectancy or F-grade.",
    scoring: "Built nightly from every graded outcome (paper trades, journal, tracked alerts).",
    risk: "Historical/statistical analysis, not financial advice — the plan describes the past, and the future is under no obligation to repeat it.",
  },
  swingScore: {
    label: "Swing score (0–100)",
    what: "Composite 1–4 week opportunity grade: trend alignment, momentum, volume, liquidity, contract economics, and event risk (see docs/SWING-SCANNER.md for every formula).",
    why: "Ranks slower, multi-week option setups by quality of evidence instead of any single indicator.",
    direction: "Higher is better. Treat as UNCALIBRATED until a month of tracked outcomes exists.",
    scoring: "It is the ranking for the swing scanner tab.",
    risk: "Research preview: formulas are principled but not yet validated against OptiScan's own outcome data. Do not trade it blind.",
  },
  heroCallout: {
    label: "Hero callout card",
    what: "The strongest actionable setup on screen right now: a live TRADE callout, a fillable momentum candidate, or (when nothing qualifies) the fastest core mover on tape.",
    why: "This is the one card to read first — it tells you what the scanner thinks matters most before you scroll the list.",
    direction: "TRADE + fillable contract = highest priority. Live tape only = not a callout yet.",
    scoring: "Ranked by capture tier, META-shaped quality, spread, and freshness.",
    risk: "Hero can show live tape between callouts — that is not a buy signal until the scanner fires and the contract validates.",
  },
  liveTracking: {
    label: "Live tracking panel",
    what: "Open callouts from today with checkpoint timers (5m / 15m / 30m) showing whether each signal is still moving your way.",
    why: "Lets you judge follow-through after entry — a callout that dies in the first 5 minutes is different from one that keeps running.",
    direction: "Green checkpoint progress + positive return = on track. Flat or red = thesis weakening.",
    scoring: "Uses realized checkpoint returns, not peak marks.",
    risk: "Checkpoints are timers, not guarantees — fast reversals can happen between polls.",
  },
  paperTrading: {
    label: "Paper trading desk",
    what: "Autonomous simulated options trades: the engine auto-enters fresh TRADE callouts (when enabled), fills at the ask, exits at the bid, and applies hard stops + smart thesis exits.",
    why: "Build trust in the system's timing and risk rules before real money — completely separate from the AI copilot.",
    direction: "Positive expectancy + controlled drawdown = the system is behaving. Refusals from the risk engine are features, not bugs.",
    scoring: "Every stat uses realized fills only; unrealized marks are for open-trade context.",
    risk: "Simulation ≠ live fills. Slippage, halts, and broker constraints are not modeled perfectly.",
  },
  nearMiss: {
    label: "Near-miss transparency",
    what: "Symbols that almost triggered but were blocked by a quality gate (speed, surge, spread, cooldown, etc.).",
    why: "Proves the scanner is awake but selective — fewer junk alerts is the design.",
    direction: "More near-misses with rising speed = watchlist heating up. Persistent blocks = bar is doing its job.",
    scoring: "Not scored — diagnostic only.",
    risk: "A near-miss can become a full callout seconds later if gates clear.",
  },
  // -- Research & performance vocabulary --------------------------------------
  //
  // These are the terms the private research view uses. They are DEFINITIONS, never
  // recommendations: none of them says a number is good enough to act on, and none says a
  // threshold makes anything subscriber-ready. A profit factor above 1 means gains outweighed
  // losses in one measured population - it is not a readiness verdict and is never written
  // as one here.

  meanReturn: {
    label: "Mean return",
    what: "The simple average realized return across every trade in the population being measured.",
    why: "It is what expectancy is built from, and it answers 'what did the average trade do'.",
    direction: "Higher is better. Negative means the average trade lost money.",
    scoring: "Descriptive only - no gate reads it.",
    risk: "One enormous winner drags the average up while most trades lost. Always read it beside the median: when the mean sits far above the median, a few trades are carrying it.",
  },
  medianReturn: {
    label: "Median return",
    what: "The middle realized return: half the trades did better, half did worse.",
    why: "It describes the TYPICAL trade where the mean describes the average one. The owner lane's mean is -9.19% and its median is -40.29%, and that gap is the whole story of the lane.",
    direction: "Higher is better.",
    scoring: "Descriptive only.",
    risk: "It ignores the size of the tails entirely, so a strategy that survives on rare large winners looks worse by median than it is. Neither number is the truth on its own.",
  },
  averageWinner: {
    label: "Average winner",
    what: "The mean return of the trades that finished positive.",
    why: "Half of expectancy. A system can win rarely and still be profitable if its winners are large enough.",
    direction: "Higher is better, but only meaningful next to the average loser and the win rate.",
    scoring: "Descriptive only.",
    risk: "On its own it says nothing. An average winner of +50% is worthless if the average loser is -60% and losses are twice as frequent.",
  },
  averageLoser: {
    label: "Average loser",
    what: "The mean return of the trades that finished at or below zero.",
    why: "The other half of expectancy, and the one loss control is judged by.",
    direction: "Closer to zero is better.",
    scoring: "Descriptive only.",
    risk: "It hides its own tail: one -85% stop-leakage exit and a run of -40% exits average to a number that looks like neither.",
  },
  baselineProfitFactor: {
    label: "Baseline PF",
    what: "The profit factor of what actually happened - the current, real decision population.",
    why: "It is the thing any experimental rule has to beat. Without it, a shadow arm's profit factor is a number with nothing to compare against.",
    direction: "Higher is better; above 1 means gains outweighed losses.",
    scoring: "Reported beside every shadow result. Never a gate.",
    risk: "It must be measured on the SAME trades the experimental rule could decide. A baseline over a larger population than the shadow arm is two samples, not a comparison.",
  },
  shadowProfitFactor: {
    label: "Shadow PF",
    what: "The profit factor an experimental rule WOULD have produced, computed without changing a single real callout.",
    why: "It lets a rule be measured before it is ever trusted with a decision.",
    direction: "Higher is better, and it means nothing except relative to baseline PF.",
    scoring: "Shadow only. No shadow figure has ever changed what was delivered.",
    risk: "Measured on the sessions a rule was invented from, it cannot fail - that is in-sample and is labelled as such. Only prospective evidence, gathered after the rule was frozen, can disprove it.",
  },
  profitFactorExBest: {
    label: "PF ex-best winner",
    what: "Profit factor recomputed with the single largest winner removed.",
    why: "It checks whether a result is a system or a lucky trade. LHC_SELECT_V1 reads PF 1.240, and 0.611 without its one +343.93% run - the same rule, two very different claims.",
    direction: "Higher is better. Staying above 1 without the best trade is a far stronger result than a high headline PF.",
    scoring: "Reported alongside every profit factor; a headline PF is never shown without it.",
    risk: "It is deliberately harsh. A strategy that legitimately depends on rare large winners will look bad by this measure, which is why it is a check and not a verdict.",
  },
  tailDependence: {
    label: "Tail dependence",
    what: "How much of a result rests on one or a few unusually large winners - reported as the share of total gains the best trade contributed.",
    why: "A result carried by a single trade will not repeat just because the sample grows.",
    direction: "Lower is better. A best winner contributing 7% of gains is a broad result; one contributing 80% is one trade.",
    scoring: "Descriptive only.",
    risk: "Low tail dependence is not the same as a good strategy - it only means the result is not one trade in disguise.",
  },
  probabilityTouch: {
    label: "P(+10) / P(+25) / P(+50) / P(+100)",
    what: "The observed share of supported trades whose EXACT called contract ever touched that return level at any point.",
    why: "It describes what was reachable, which is a different question from what was captured.",
    direction: "Higher is better, but read it against realized results.",
    scoring: "Reported only where the evidence floor is met. Below it the answer is INSUFFICIENT_EVIDENCE, not a number.",
    risk: "THIS IS NOT REALIZED PROFIT. The owner lane touched +25% on 54% of setups and still returned a profit factor of 0.67 - a lane that reaches these levels and gives them back. Touching a level and keeping it are different events.",
  },
  winnerRetention: {
    label: "Winner retention",
    what: "Of the trades that actually won, how many an experimental filter would have kept.",
    why: "It is the cost side of any filter, and the number a filter's advocate is least likely to volunteer.",
    direction: "Higher is better. 100% means the rule rejected nothing that worked.",
    scoring: "Reported before loss rejection, always.",
    risk: "Measured on however many winners the sample happens to contain. Retaining 22 of 23 is not evidence that no winner CAN be rejected - only that few were.",
  },
  lossRejection: {
    label: "Loss rejection",
    what: "Of the trades that actually lost, how many an experimental filter would have avoided.",
    why: "The benefit side of a filter.",
    direction: "Higher is better.",
    scoring: "Reported after winner retention, never instead of it.",
    risk: "A rule that rejects most losses AND most winners is not a filter, it is a smaller sample. This number is meaningless without winner retention beside it.",
  },
  independentSessions: {
    label: "Independent sessions",
    what: "The count of distinct, VERIFIED trading sessions the evidence spans - validated dates, not distinct calendar strings.",
    why: "Twenty trades from one afternoon are one observation repeated. Twenty across five sessions have survived five different market days.",
    direction: "Higher is better. Evidence floors require at least 5.",
    scoring: "A hard floor: below it, verdicts report INSUFFICIENT_EVIDENCE however good the numbers look.",
    risk: "A weekend, a market holiday or a corrupt timestamp all produce a well-formed date. Dates that fail validation are rejected and reported, never silently counted.",
  },
  selectionStrength: {
    label: "Selection strength",
    what: "A 0-100 score the scanner froze at callout, on the evaluation for the strategy that was ACTUALLY traded.",
    why: "It is a pre-entry opinion the system formed before any outcome existed, which makes it the cheapest thing to test as a filter.",
    direction: "Higher is believed better - and that belief is exactly what OWNER_SELECTION_STRENGTH_GATE_V1 is testing, in shadow.",
    scoring: "RESEARCH ONLY. No callout, ranking, contract choice or target reads it.",
    risk: "Some callouts carry no strength at all, because their case holds no evaluation matching the traded strategy. Missing is NOT low - those trades are excluded from the experiment's arms entirely.",
  },
  deliveryQuality: {
    label: "Delivery quality",
    what: "A separate 0-100 score recorded on the mirror's feature snapshot at delivery time.",
    why: "It measures the quality of the delivery decision, not the strength of the strategy signal.",
    direction: "Higher is believed better. Research only.",
    scoring: "Reads no gate.",
    risk: "It is NOT selection strength, and the two disagree - 100 versus 81 on the same callout. Substituting one for the other silently changes which question is being answered.",
  },
  rewardRemaining: {
    label: "Reward remaining",
    what: "How much of the move to Target 1 was still ahead at the moment of the callout.",
    why: "It is meant to answer whether a callout arrived early enough to be worth taking.",
    direction: "Higher is better - more of the move left to capture.",
    scoring: "Research only.",
    risk: "It currently reports its maximum on 65 of 70 owner rows. A metric that returns 1.0 for almost every trade has not discriminated anything yet, and must not be read as evidence that every callout was early.",
  },
  moveConsumed: {
    label: "Move consumed",
    what: "How much of the favourable move had already happened before the callout went out.",
    why: "Chasing a move that is mostly over is one of the specific failures the research is looking for.",
    direction: "Lower is better.",
    scoring: "Research only.",
    risk: "Direction-signed: for a PUT, 'favourable' means the underlying moving DOWN. A metric that measures position in the session range without signing it calls a put's latest possible entry its earliest.",
  },
  discoveryStage: {
    label: "Discovery stage",
    what: "How far into an opportunity's development OptiScan found it - from a pre-trigger watch through to too late.",
    why: "Finding winners early is worth more than finding them at all.",
    direction: "Earlier is better, provided the move actually confirms.",
    scoring: "Research only. No delivery decision reads the stage.",
    risk: "Every current owner row grades PRE_TRIGGER with a median detection-to-alert gap of 1.6 seconds. Over a 1.6-second window this is not measuring earliness, it is measuring that detection and delivery happen on the same tick.",
  },
  stopLeakage: {
    label: "Stop leakage",
    what: "The gap between the stop the callout froze and the price the exit actually filled at.",
    why: "A stop is only a risk control if the fill lands near it. One owner trade froze a 0.43 stop and filled at 0.104 - 75.81% beyond it.",
    direction: "Closer to zero is better.",
    scoring: "Measured and reported. No stop has been changed because of it.",
    risk: "Leakage is mostly an overnight-gap phenomenon, so it is a symptom of when a position was held rather than of where the stop was placed. Moving the stop would not have prevented the fills that caused it.",
  },
  giveback: {
    label: "Giveback",
    what: "Profit a trade reached and then handed back before it closed.",
    why: "It separates 'the idea was wrong' from 'the idea worked and the exit did not', which are opposite problems with opposite fixes.",
    direction: "Lower is better.",
    scoring: "Feeds the GOOD_MOVE_THEN_REVERSED path label. Reads no exit rule.",
    risk: "Large giveback does NOT by itself justify a trailing stop or a profit lock. The same pullbacks appear in trades that go on to hit Target 1, and a rule that cuts one cuts both.",
  },
  exactOcc: {
    label: "Exact OCC",
    what: "The precise option contract the callout froze - symbol, expiry, strike and side.",
    why: "It is what makes a result attributable. A mark on a re-selected strike belongs to a different instrument.",
    direction: "Not a scale. Either the evidence is on the exact contract or it is not priced at all.",
    scoring: "Any mirror not on the exact contract is counted as an OCC mismatch and contributes no performance figure.",
    risk: "Reading a nearby strike's marks as though they were the callout's is how a phantom +149% excursion once entered a report.",
  },
  evidenceQuality: {
    label: "Evidence quality",
    what: "Whether the measurement behind a number is good enough to support it: verified, reconstructed, or unavailable.",
    why: "A missing measurement and a bad result look identical in a table of numbers unless the difference is stated.",
    direction: "Verified is best.",
    scoring: "A figure without supporting evidence is reported as null, never as zero.",
    risk: "MISSING EVIDENCE IS NOT ZERO. Treating it as zero is how 13 unmeasured trades once merged into a filter's reject bucket and made a rule look twice as effective as it was.",
  },
  evidenceVerdict: {
    label: "Evidence verdict",
    what: "Where a research question or experiment stands. SUPPORTED: the sample clears the evidence floor. INSUFFICIENT_EVIDENCE: not enough closed prospective outcomes or sessions yet. PROMISING: the effect holds so far. WEAKENING: it is fading, or it rests on one trade. FAILED: prospective evidence contradicts it. READY_FOR_HUMAN_REVIEW: there is enough for your decision to be worth making.",
    why: "It states what the sample can carry, so a good-looking number from four trades is not read as a finding.",
    direction: "Not a scale. FAILED is as valuable as PROMISING - an experiment that cannot lose is not an experiment.",
    scoring: "Derived from prospective evidence only, behind fixed floors of 20 closed outcomes across 5 independent sessions.",
    risk: "NONE OF THESE IS AN APPROVAL. READY_FOR_HUMAN_REVIEW is a request for your attention, not permission, and there is deliberately no status an experiment can reach on its own that authorizes a live change or a subscriber claim.",
  },
  swingCandidate: {
    label: "Swing candidate card",
    what: "A 1–4 week options setup ranked by trend, momentum, volume, liquidity, and contract economics.",
    why: "Slower timeframe ideas for holds that don't need same-day speed — each factor line explains why it passed or failed.",
    direction: "Higher score + fillable contract = stronger candidate. Flags warn about gaps in the data.",
    scoring: "See factor breakdown on each card; total score is the rank.",
    risk: "Uncalibrated preview — earnings and macro events are not fully checked. Paper-trade before trusting.",
  },
  // Shared concepts are generated last so the typed canonical terminology
  // registry overrides legacy wording during the convergence period.
  ...canonicalMetricGlossary(),
};

export type MetricKey = keyof typeof METRIC_GLOSSARY;

export function metricInfo(key: string): MetricInfo | null {
  return METRIC_GLOSSARY[key] ?? null;
}

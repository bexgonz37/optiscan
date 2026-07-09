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
  swingCandidate: {
    label: "Swing candidate card",
    what: "A 1–4 week options setup ranked by trend, momentum, volume, liquidity, and contract economics.",
    why: "Slower timeframe ideas for holds that don't need same-day speed — each factor line explains why it passed or failed.",
    direction: "Higher score + fillable contract = stronger candidate. Flags warn about gaps in the data.",
    scoring: "See factor breakdown on each card; total score is the rank.",
    risk: "Uncalibrated preview — earnings and macro events are not fully checked. Paper-trade before trusting.",
  },
};

export type MetricKey = keyof typeof METRIC_GLOSSARY;

export function metricInfo(key: string): MetricInfo | null {
  return METRIC_GLOSSARY[key] ?? null;
}

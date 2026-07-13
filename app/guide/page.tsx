"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

/**
 * Guide — the beginner-friendly "How to use OptiScan" owner manual.
 *
 * Plain English, scannable, mobile-friendly, and searchable. It describes every
 * navigation page, the daily workflow, every callout status, the difference
 * between the scores/probabilities, worked examples, and the Railway owner
 * setup. It states measurements and limits only — no profitability claims.
 */

type Section = { id: string; title: string; tags: string; body: React.ReactNode; plain: string };

const PAGE_ROWS: [string, string, string, string, string][] = [
  // [page, what it is, when to open, key numbers/status, ignore / fix]
  ["Command Center", "Your home screen and daily starting point.", "Every time you open OptiScan.", "The “What needs my attention?” summary and status dots (Scanner, Provider, Discord, Paper).", "Ignore the peak-score details. If anything shows red, open System Health."],
  ["Callouts", "Every trade idea in one place, split by time horizon with tabs.", "Whenever you want to see current ideas.", "Status badge, horizon, contract, quote freshness, contract score.", "Ignore tabs with no matches. If all say DATA_STALE, check System Health."],
  ["Options Callouts", "The old options page — now merged into Callouts; kept for your accuracy and trade journal.", "Only to review past accuracy or your journal.", "Accuracy %, journal entries.", "You can ignore this in favor of Callouts + Performance."],
  ["Horizon Callouts", "The multi-horizon view — now the main Callouts page (0DTE–90DTE, calls + put research).", "Same as Callouts; this is Callouts.", "Same as Callouts.", "Nothing extra to do."],
  ["Swing Research", "1–4 week options research with its own scoring, now a tab inside Callouts.", "When you want multi-week ideas.", "Swing score, factors, fillable contract.", "This is a research preview — verify earnings first."],
  ["Watchlist", "The symbols the scanner is monitoring.", "When you want to confirm coverage.", "The list of tickers and whether they are core or promoted.", "Safe to ignore day-to-day."],
  ["Paper Trading", "Simulated trades with fake money — no real orders, ever.", "Daily, to watch how ideas would have played out.", "Open positions, entry/exit, simulated P/L.", "If a trade looks wrong, remember fills include slippage; nothing here is real money."],
  ["Performance", "The track record: alert accuracy and the paper account over time.", "Weekly.", "Win rate, average result, equity curve.", "Ignore day-to-day wiggle; look at the trend."],
  ["Research & Backtesting", "Setup statistics and historical backtests.", "When you want to study a setup type.", "Sample size, historical hit rate.", "Advanced — safe to ignore unless researching."],
  ["Research & Learning", "Model readiness, drift, and bounded continuous learning.", "Only when enough graded outcomes exist.", "Model state and how many more outcomes are needed.", "If it says still collecting outcomes, there is nothing to do yet."],
  ["System Health", "Data freshness, provider status, Discord delivery, and reliability.", "First thing each day, and any time something looks off.", "Provider connected, per-data freshness, Discord webhook status, database OK.", "If a webhook is red, set it in Railway. If the DB is red, that is separate from a token error."],
  ["Improvement Agent", "A propose-only code-improvement log. It never edits code by itself.", "Rarely. It is inactive unless you enable it in Railway.", "Mode and any pending proposals.", "If it says inactive, ignore it."],
  ["Settings", "Alerts, Discord, safety toggles, and the Lock Dashboard control.", "When you change preferences or need to lock/unlock.", "Your toggles and the “Forget token / Lock dashboard” button.", "Do not enable anything labeled research/experimental unless you understand it."],
  ["Guide", "This page — how to use OptiScan.", "Any time you are unsure.", "Use the search box at the top to jump to a topic.", "Nothing to fix here."],
];

const STATUS_ROWS: [string, string][] = [
  ["ACTIONABLE_NOW", "A confirmed entry on fresh data with a valid contract and acceptable risk. This is the strongest state for a call idea."],
  ["NEAR_TRIGGER", "Very close to confirming. Watch it — it may become actionable or fade."],
  ["DEVELOPING", "Still forming. Building conviction but not near a trigger yet."],
  ["WATCH", "On the radar. Being monitored, no action implied."],
  ["WAIT_FOR_PULLBACK", "The idea is valid but price ran ahead; a better entry may come on a dip."],
  ["EXTENDED", "Price already moved too far past the entry zone. Chasing it carries poor risk."],
  ["NO_VALID_CONTRACT", "No option contract met the quality bar (spread/liquidity). No contract is invented."],
  ["DATA_STALE", "The required market data is too old to trust, so the idea is not actionable."],
  ["INVALIDATED", "The setup broke its invalidation level — the idea is off."],
  ["RESEARCH_ONLY", "Information only, never actionable. All put/bearish ideas are RESEARCH_ONLY."],
  ["MODEL_EXPERIMENTAL", "A probability is shown but the model is early — treat it as research, not a forecast."],
  ["MODEL_INACTIVE", "No probability is shown because the model has not collected enough graded outcomes."],
  ["INSUFFICIENT_EVIDENCE", "Too few similar past cases to say anything statistically — shown for honesty."],
];

const METRIC_ROWS: [string, string][] = [
  ["Setup score", "A 0–100 quality rating of the setup right now. It is NOT a probability and does not predict profit — it just ranks how clean the setup looks."],
  ["Experimental probability", "An early model estimate, labeled EXPERIMENTAL. Limited data — research only, never a guarantee. Never overrides a safety gate."],
  ["Validated probability", "A model estimate shown only after strict thresholds are met (many graded outcomes, calibration). Still an estimate, not a promise."],
  ["Evidence status", "How much real past data backs this kind of setup. INSUFFICIENT_EVIDENCE means too few cases to lean on."],
  ["Risk verdict", "The risk engine's pass/fail on position sizing and rules. A failing verdict blocks a paper entry regardless of score."],
  ["Contract score", "A 0–100 rating of the specific option contract (spread, liquidity, delta). Low means the contract is poor even if the setup is good."],
];

const EXAMPLE_ROWS: [string, string][] = [
  ["0DTE call", "SPY breaks the morning high on strong volume with fresh data. A same-day call contract with a tight spread scores well → status ACTIONABLE_NOW. Fast-moving; the window is short."],
  ["Weekly call", "NVDA trends up into a Friday-expiry weekly. The 1–5 DTE tab shows a call with a valid contract and a passing risk verdict. More room than 0DTE, still time-sensitive."],
  ["Multi-week call", "META sets up on the daily. The 11–35 DTE tab shows a multi-week call; less gamma risk, needs a bigger move to pay. Often overlaps Swing Research."],
  ["Put research setup", "A symbol looks weak. A put idea appears as RESEARCH_ONLY in the Put Research tab — never actionable, shown for context only."],
  ["Stale-data rejection", "A name is moving but the quote feed lags. The idea shows DATA_STALE and is not actionable — OptiScan will not act on old prices."],
  ["No-valid-contract rejection", "The stock setup is clean but every nearby option has a wide spread. Status NO_VALID_CONTRACT — no contract is fabricated to fill the gap."],
  ["Paper trade outcome", "A confirmed call passes the risk engine and opens a simulated position. Later it hits its target or stop; the fake P/L and result post to Paper Trading and Performance. No real order was placed."],
];

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="guide-table-wrap">
      <table className="guide-table">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{j === 0 ? <strong>{c}</strong> : c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SECTIONS: Section[] = [
  {
    id: "start",
    title: "Start here — the 60-second version",
    tags: "intro start overview basics owner",
    plain: "OptiScan watches the market and posts research callouts. It runs on Railway. It never places real orders. Puts are research only.",
    body: (
      <>
        <p>OptiScan watches liquid stocks and options, and posts research callouts for you (and to Discord). It runs on a server (Railway) so it keeps working while your computer is off. A few ground rules:</p>
        <ul>
          <li>It places <strong>no real orders</strong>. Paper Trading is a simulation.</li>
          <li>Put/bearish ideas are always <strong>RESEARCH_ONLY</strong>.</li>
          <li>Scores and probabilities are measurements, <strong>not promises of profit</strong>.</li>
          <li>When data is old or a contract is poor, it says so instead of guessing.</li>
        </ul>
        <p>New here? Read the <a href="#workflow">Daily Workflow</a>, then skim the <a href="#pages">page guide</a>.</p>
      </>
    ),
  },
  {
    id: "workflow",
    title: "Daily workflow (6 steps)",
    tags: "daily routine workflow steps discord",
    plain: "Step 1 check system health. Step 2 review discord callouts. Step 3 review options horizon callouts. Step 4 monitor paper trading. Step 5 review performance weekly. Step 6 review research and learning only when enough outcomes exist.",
    body: (
      <ol className="guide-steps">
        <li><strong>Step 1 — Check System Health.</strong> Open <Link href="/data">System Health</Link>. Green across scanner, provider, and Discord means you are good to go.</li>
        <li><strong>Step 2 — Review Discord callouts.</strong> Check your Discord channel for anything posted overnight or during the session.</li>
        <li><strong>Step 3 — Review Options / Horizon Callouts.</strong> Open <Link href="/callouts">Callouts</Link> and scan the tabs (0DTE through 36–90 DTE).</li>
        <li><strong>Step 4 — Monitor Paper Trading.</strong> Open <Link href="/paper">Paper Trading</Link> to see how ideas are playing out in simulation.</li>
        <li><strong>Step 5 — Review Performance weekly.</strong> Once a week, open <Link href="/performance">Performance</Link> and look at the trend, not one day.</li>
        <li><strong>Step 6 — Review Research &amp; Learning only when enough outcomes exist.</strong> <Link href="/research-learning">Research &amp; Learning</Link> is only meaningful after many graded outcomes. Until then it will say it is still collecting.</li>
      </ol>
    ),
  },
  {
    id: "pages",
    title: "Every page in plain English",
    tags: "pages navigation command center callouts watchlist paper performance backtesting system health settings improvement swing guide research learning",
    plain: PAGE_ROWS.map((r) => r.join(" ")).join(" "),
    body: <Table head={["Page", "What it is", "When to open", "What matters", "Ignore / fix"]} rows={PAGE_ROWS.map((r) => [...r])} />,
  },
  {
    id: "statuses",
    title: "Callout statuses explained",
    tags: "status badges actionable near trigger developing watch pullback extended stale invalidated research only model",
    plain: STATUS_ROWS.map((r) => r.join(" ")).join(" "),
    body: <Table head={["Status", "What it means"]} rows={STATUS_ROWS.map((r) => [...r])} />,
  },
  {
    id: "metrics",
    title: "Scores vs probabilities vs verdicts",
    tags: "setup score experimental validated probability evidence risk verdict contract score difference",
    plain: METRIC_ROWS.map((r) => r.join(" ")).join(" "),
    body: (
      <>
        <p>These are different things. Do not read a score as a probability, or a probability as a guarantee.</p>
        <Table head={["Term", "What it is"]} rows={METRIC_ROWS.map((r) => [...r])} />
      </>
    ),
  },
  {
    id: "examples",
    title: "Worked examples",
    tags: "examples 0dte weekly multi-week put research stale no valid contract paper outcome",
    plain: EXAMPLE_ROWS.map((r) => r.join(" ")).join(" "),
    body: <Table head={["Example", "What you would see"]} rows={EXAMPLE_ROWS.map((r) => [...r])} />,
  },
  {
    id: "railway",
    title: "Railway owner setup (token, keys, webhooks)",
    tags: "railway setup token scan_api_token polygon discord webhook flags supervisor deploy password",
    plain: "SCAN_API_TOKEN is a private owner password not AI. Enter it in the Unlock OptiScan screen. Replace it if you change it in Railway. POLYGON_API_KEY is your market data key. Discord webhooks route options and stocks. Railway flags enable scanning versus discord sending. The app runs on Railway while your computer is off.",
    body: (
      <>
        <h3>Your access token</h3>
        <ul>
          <li><strong>SCAN_API_TOKEN is your private owner password — not an AI, not a data key.</strong> It simply unlocks your dashboard.</li>
          <li><strong>How to enter it:</strong> when the <em>Unlock OptiScan</em> screen appears, paste the token and press Unlock. You never need to open browser developer tools.</li>
          <li><strong>If you change it in Railway:</strong> the old token stops working; the Unlock screen reappears — paste the new one. You can also lock the dashboard yourself from <Link href="/settings">Settings → Lock dashboard</Link>.</li>
          <li>The token is stored only in your browser and sent only to your own server. It is never shown on the page or in a link.</li>
        </ul>
        <h3>Market data &amp; Discord</h3>
        <ul>
          <li><strong>POLYGON_API_KEY</strong> (or MASSIVE_API_KEY) is your market-data feed. Without it there are no live prices.</li>
          <li><strong>DISCORD_WEBHOOK_OPTIONS</strong> routes option calls and put research; <strong>DISCORD_WEBHOOK_STOCKS</strong> routes momentum stock callouts; <strong>DISCORD_WEBHOOK_RECAP</strong> routes recaps.</li>
        </ul>
        <h3>Which Railway flags do what</h3>
        <ul>
          <li><strong>Scanning:</strong> the scanner and paper engine run by default. <code>SCANNER_REALTIME=0</code> or <code>PAPER_TRADING_ENABLED=0</code> turn them off.</li>
          <li><strong>Automatic callouts:</strong> <code>SUPERVISOR_RUNTIME=1</code> enables the Supervisor cycle.</li>
          <li><strong>Discord sending:</strong> <code>AGENT_CALLOUT_DISCORD=1</code> plus <code>CALLOUT_CANONICAL_PATH=supervisor</code> makes the Supervisor the one options sender. With these off, nothing is sent.</li>
        </ul>
        <p><strong>The app runs on Railway.</strong> Once deployed it keeps scanning and posting to Discord even when your own computer is off.</p>
      </>
    ),
  },
  {
    id: "safety",
    title: "Safety &amp; limits",
    tags: "safety limits risk disclaimer bearish puts real money",
    plain: "No real brokerage. Paper only. Bearish and puts are research only. Nothing here guarantees profit. Not financial advice.",
    body: (
      <ul>
        <li>There is no brokerage connection — OptiScan cannot place a real trade.</li>
        <li>Bearish/put ideas are always research only.</li>
        <li>Scores and model outputs are estimates. Markets carry risk; nothing here guarantees a profit. This is not financial advice.</li>
      </ul>
    ),
  },
];

export default function GuidePage() {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!query) return SECTIONS;
    return SECTIONS.filter((s) =>
      `${s.title} ${s.tags} ${s.plain}`.toLowerCase().includes(query),
    );
  }, [query]);

  return (
    <div className="ui-page guide-page">
      <div className="guide-search">
        <input
          type="search"
          placeholder="Search the guide (e.g. “0DTE”, “token”, “stale”)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search the guide"
        />
      </div>

      {!query ? (
        <nav className="guide-toc" aria-label="Guide contents">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>{s.title.replace(/&amp;/g, "&")}</a>
          ))}
        </nav>
      ) : null}

      {shown.length === 0 ? (
        <p className="guide-empty">No section matches “{q}”. Try a shorter word.</p>
      ) : (
        shown.map((s) => (
          <section key={s.id} id={s.id} className="guide-section">
            <h2 dangerouslySetInnerHTML={{ __html: s.title }} />
            <div className="guide-body">{s.body}</div>
          </section>
        ))
      )}
    </div>
  );
}

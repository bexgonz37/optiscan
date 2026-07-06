"use client";

/**
 * /guide — full plain-English instructions for beginners.
 * Everything here describes research signals — nothing is financial advice.
 */

import { AppNav } from "@/components/AppNav";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel main guide-section">
      <h2 className="guide-section-title">{title}</h2>
      <div className="guide-section-body">{children}</div>
    </section>
  );
}

export default function GuidePage() {
  return (
    <div className="app">
      <AppNav />

      <div className="guide-intro panel main">
        <h1 style={{ margin: "0 0 6px", fontSize: 22 }}>How to use OptiScan</h1>
        <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
          OptiScan watches fast, liquid stocks every second. During market hours it looks for same-day
          (0DTE) option setups. Before and after the regular session it watches shares only. You always
          make the final decision — this is a research tool, not financial advice.
        </p>
      </div>

      <Section title="1. Quick start (every trading day)">
        <ol className="guide-list">
          <li>Start the app before or during market hours. The scanner loop starts on its own.</li>
          <li>Keep <strong>Live</strong> open to watch what&apos;s moving, or <strong>Alerts</strong> for signals that fired.</li>
          <li>Wait for a popup. Popups only appear for a clear live signal — never for &quot;watch&quot; or &quot;skip.&quot;</li>
          <li>When one fires: click <strong>Watch chart</strong> first. Confirm the move with your own eyes before doing anything.</li>
          <li>If you take the trade, click <strong>I took this trade</strong> so it lands in your journal.</li>
        </ol>
      </Section>

      <Section title="2. What the signals mean (market hours — options)">
        <ul className="guide-list">
          <li><strong>Buy call option ↑</strong> — the stock is moving UP at ≥ 0.15%/min right now, scores pass, and there&apos;s a liquid same-day call. The contract (strike + expiry) is on the card.</li>
          <li><strong>Buy put option ↓</strong> — same thing but the stock is moving DOWN fast right now.</li>
          <li><strong>Watch call/put setup</strong> — looks good but not moving fast enough yet. If speed comes back it can upgrade.</li>
          <li><strong>Skip — don&apos;t trade</strong> — choppy tape, exhausted move, spread too wide, or premium too expensive. Hidden by default.</li>
        </ul>
        <p className="muted">
          Labels re-check against the live tape every second. If a buy signal stalls, it downgrades to
          &quot;watch&quot; — what you see is always for <em>right now</em>, not when the alert first fired.
        </p>
      </Section>

      <Section title="3. After-hours stock signals (shares, not options)">
        <ul className="guide-list">
          <li><strong>Buy stock ↑</strong> — price is rising fast in premarket or after hours. This means buy shares (the actual stock), not an option contract.</li>
          <li><strong>Bet stock ↓</strong> — price is falling fast. This is a short/sell-shares idea — still shares, not options.</li>
          <li><strong>Watch ↑/↓ move</strong> — might go that direction but not fast enough yet.</li>
          <li>Option alerts do <strong>not</strong> fire outside 9:30am–4:00pm ET. After 4pm you only get share signals until 8pm.</li>
        </ul>
      </Section>

      <Section title="4. The Live page (market scanner)">
        <ul className="guide-list">
          <li>Every symbol is ranked by <strong>Score</strong> — how hot it is right now (0–100). Higher = more worth watching.</li>
          <li><strong>Speed</strong> is how fast price moves per minute — the most important number. Bold means it clears the trade bar.</li>
          <li><strong>Today %</strong> is the day&apos;s move so far. Speed matters more than a big day move alone.</li>
          <li>Click <strong>Show details</strong> for RVOL, volume surge, VWAP, and high/low-of-day breaks.</li>
          <li>Default view shows <strong>Moving now</strong> only. Click <strong>All</strong> for everything, or <strong>Pause</strong> to freeze the table.</li>
          <li>Click any row to open the chart. Expand <strong>Options research</strong> below for deeper momentum + unusual-flow tables.</li>
        </ul>
      </Section>

      <Section title="5. The Alerts page">
        <ul className="guide-list">
          <li><strong>Right now</strong> — one list, best first. The big card is the strongest signal at this moment.</li>
          <li><strong>Track record</strong> — did signals work 1m/5m after they fired? Early hit rate lives here.</li>
          <li><strong>Past alerts</strong> — every alert with verdict when it fired vs now.</li>
          <li><strong>My trades</strong> — your personal log with exits and outcomes.</li>
        </ul>
      </Section>

      <Section title="6. Popups and Discord">
        <ul className="guide-list">
          <li>Popups appear bottom-right for live buy signals only, with a sound. Snooze a ticker for an hour if needed.</li>
          <li>Desktop notifications work when the tab is in the background — allow notifications when asked.</li>
          <li>Discord sends automatic alerts with confidence %, contract (options) or direction (shares), speed, and why.</li>
        </ul>
      </Section>

      <Section title="7. A simple routine for beginners">
        <ol className="guide-list">
          <li>Trade only clear buy signals — ignore watch/skip until you&apos;re comfortable.</li>
          <li>Always open the chart first.</li>
          <li>For options: check the spread on the contract line before entering.</li>
          <li>0DTE options decay fast — decide your exit before you enter.</li>
          <li>Log every trade in My trades so you can see what actually works for you.</li>
        </ol>
      </Section>

      <div className="footer">
        OptiScan guide · research signals and measurements only · you decide entries, size, and exits · not financial advice
      </div>
    </div>
  );
}

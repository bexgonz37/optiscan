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
          OptiScan watches a universe of fast, liquid stocks every second and tells you when one is
          moving hard enough that a same-day (0DTE) call or put is worth a look. You always make the
          final decision — this is a research tool, not financial advice.
        </p>
      </div>

      <Section title="1. Quick start (every trading day)">
        <ol className="guide-list">
          <li>Start the app before or during market hours (9:30am–4:00pm ET). The scanner loop starts on its own.</li>
          <li>Keep the <strong>Dashboard</strong> open to watch what's heating up, or the <strong>Alerts</strong> page for direct signals.</li>
          <li>Wait for a popup. Popups only appear for a live <strong>BUY CALL</strong> or <strong>BUY PUT</strong> — never for WAIT or SKIP.</li>
          <li>When one fires: click <strong>Watch chart</strong> first. Confirm the move with your own eyes before doing anything.</li>
          <li>If you take the trade, click <strong>I took this trade</strong> so it lands in your journal.</li>
        </ol>
      </Section>

      <Section title="2. What the signals mean">
        <ul className="guide-list">
          <li><strong>BUY CALL</strong> — the stock is moving UP at ≥ 0.15%/min right now, the setup scores pass, and there's a liquid same-day call contract. The exact contract (strike + expiry) is shown on the card.</li>
          <li><strong>BUY PUT</strong> — same thing but the stock is moving DOWN fast right now.</li>
          <li><strong>WAIT — CALL/PUT SETUP</strong> — the setup looks good but the stock is not moving fast enough at this moment. Watch it; if speed comes back it can upgrade to BUY.</li>
          <li><strong>SKIP — DON'T TRADE</strong> — something disqualifies it: choppy tape, exhausted move, spread too wide, or premium too expensive. These are hidden by default.</li>
        </ul>
        <p className="muted">
          The label is re-checked against the live tape every second. If a BUY CALL stalls, it downgrades
          to WAIT in front of you — what you see is always the verdict for <em>right now</em>, not for when
          the alert first fired.
        </p>
      </Section>

      <Section title="3. The Dashboard (market scanner)">
        <ul className="guide-list">
          <li>Every symbol is ranked by <strong>Watch score</strong> — a 0–100 blend of speed, volume, VWAP position, and level breaks. Higher = more worth watching.</li>
          <li><strong>Speed</strong> is %/minute over the last few minutes — the single most important number. Bold means it clears the 0.15%/min trade bar.</li>
          <li><strong>RVOL</strong> — today's volume vs normal. 2x+ means real interest. <strong>Vol surge</strong> — volume burst in the last minute vs the minutes before.</li>
          <li><strong>VWAP</strong> — distance from the volume-weighted average price. Calls are healthier above VWAP, puts below. <strong>HOD/LOD</strong> — breaking the high or low of the day.</li>
          <li>The table refreshes every second. Click <strong>Pause</strong> to freeze it while you read; the default filter shows fast movers only — click <strong>All</strong> for everything.</li>
          <li>Click any row to open the chart with VWAP, EMAs, RSI, and the option reality check.</li>
        </ul>
      </Section>

      <Section title="4. The Alerts page">
        <ul className="guide-list">
          <li><strong>Right now tab</strong> — one list, best first. The big card at the top is the strongest signal at this moment: the verdict, the exact contract, live speed, and a Watch chart button. Click any row to load it into the card.</li>
          <li><strong>History tab</strong> — every alert the scanner ever fired, with two badges: the verdict <em>when it fired</em> and the verdict <em>now</em>. Great for seeing how fast signals go stale. Stats and the weekly report live here too.</li>
          <li><strong>Journal tab</strong> — your personal trade log. Fill in exits and outcomes so the weekly report can tell you what's actually working for you.</li>
        </ul>
      </Section>

      <Section title="5. Popups and Discord">
        <ul className="guide-list">
          <li>Popups appear on any page, bottom-right, only for a live BUY CALL / BUY PUT, with a sound. Snooze a ticker for an hour if it's spamming you.</li>
          <li>Desktop notifications work when the browser tab is in the background — allow notifications when asked.</li>
          <li>Discord (Settings page) sends the same BUY-only signals to your private channel. Off by default; requires your webhook in <code>.env.local</code>.</li>
        </ul>
      </Section>

      <Section title="6. A simple routine for beginners">
        <ol className="guide-list">
          <li>Trade only BUY signals — ignore everything else until you're comfortable.</li>
          <li>Always open the chart first. The signal says "moving fast now"; the chart tells you if you believe it.</li>
          <li>Check the spread on the contract line — the reality check in the chart panel flags wide spreads and expensive premium.</li>
          <li>0DTE options decay fast. These are quick momentum trades, not positions to hold — decide your exit before you enter.</li>
          <li>Log every trade in the journal. After a few weeks the weekly report shows which setups actually pay you.</li>
          <li>Signals get less reliable in the last hour before close (theta burn) and the first minutes after open (chaos). The scores account for time-to-close, but be extra careful there.</li>
        </ol>
      </Section>

      <Section title="7. Good to know">
        <ul className="guide-list">
          <li>The scanner is fully deterministic — same inputs, same answer, no AI in the signal path. Every alert stores its scores so you can audit it later.</li>
          <li>Old alerts and slow-scan (research tier) alerts can never show BUY — only the live 1-second loop with real speed data can.</li>
          <li>Everything runs locally on your machine against your Polygon subscription. Nothing is sent anywhere except your own Discord webhook if you enable it.</li>
        </ul>
      </Section>

      <div className="footer">
        OptiScan guide · research signals and measurements only · you decide entries, size, and exits · not financial advice
      </div>
    </div>
  );
}

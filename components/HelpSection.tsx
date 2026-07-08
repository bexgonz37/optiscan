"use client";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel main guide-section">
      <h2 className="guide-section-title">{title}</h2>
      <div className="guide-section-body">{children}</div>
    </section>
  );
}

export function HelpSection() {
  return (
    <div className="help-section">
      <div className="guide-intro panel main">
        <h2 className="settings-panel-title">How to use OptiScan</h2>
        <p className="muted settings-desc">
          OptiScan has two parallel products: 0DTE options during regular hours, and share-momentum
          LONG/SHORT callouts across premarket, regular hours, and after-hours. You always make the final
          decision — this is a research tool, not financial advice.
        </p>
      </div>

      <Section title="1. Quick start (every trading day)">
        <ol className="guide-list">
          <li>Start the app before or during market hours. The scanner loop starts on its own.</li>
          <li>Keep <strong>Live</strong> open to watch what&apos;s moving, or <strong>Alerts</strong> for signals that fired.</li>
          <li>Wait for a popup. Popups only appear for a clear live signal — never for &quot;watch&quot; or &quot;skip.&quot;</li>
          <li>When one fires: click <strong>Watch chart</strong> first. Confirm the move with your own eyes before doing anything.</li>
          <li>If you take the trade, log it in <strong>Journal</strong> on the Alerts page.</li>
        </ol>
      </Section>

      <Section title="2. Market hours — options">
        <ul className="guide-list">
          <li><strong>Buy call option ↑</strong> — stock moving UP fast with a liquid same-day call.</li>
          <li><strong>Buy put option ↓</strong> — stock moving DOWN fast with a liquid same-day put.</li>
          <li><strong>Watch</strong> — setup forming; <strong>Skip</strong> — don&apos;t trade (hidden by default).</li>
        </ul>
      </Section>

      <Section title="3. Market momentum — shares only">
        <ul className="guide-list">
          <li><strong>Buy stock ↑</strong> / <strong>Bet stock ↓</strong> — share signals only, no options.</li>
          <li>With <code>STOCK_CALLOUTS=1</code>, the shares path runs in every open session, including regular hours.</li>
          <li>Option alerts do <strong>not</strong> fire outside 9:30am–4:00pm ET.</li>
          <li>Stock BUYs appear in the Market hero and the dedicated stock Discord channel; browser popups remain options-only.</li>
        </ul>
      </Section>

      <Section title="4. Live page">
        <ul className="guide-list">
          <li><strong>Options</strong> — 0DTE hero, ticket, and options history. <strong>Market</strong> — shares-only LONG/SHORT hero and history.</li>
        </ul>
      </Section>

      <Section title="5. Alerts page">
        <ul className="guide-list">
          <li><strong>Right now</strong> — live buy signals. <strong>History</strong> — past alerts + track record. <strong>Journal</strong> — your log.</li>
        </ul>
      </Section>
    </div>
  );
}

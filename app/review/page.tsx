"use client";

/**
 * /review — plain-English explanation of how the scanner works, what it does
 * differently from a basic broker scanner, and what it deliberately does NOT
 * claim. Content comes from lib/system-explanation.ts (same source as the
 * /api/review/system-explanation endpoint).
 */

import { SYSTEM_EXPLANATION as X } from "@/lib/system-explanation";

const Section = ({ title, items }: { title: string; items: string[] }) => (
  <div className="panel main" style={{ padding: 16, marginBottom: 14 }}>
    <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>{title}</h2>
    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7, color: "var(--muted)" }}>
      {items.map((s, i) => <li key={i}>{s}</li>)}
    </ul>
  </div>
);

export default function ReviewPage() {
  return (
    <div className="app">
      <div className="topbar">
        <div className="logo"><span className="mark">O</span>OptiScan<small>how this scanner works</small></div>
        <div className="spacer" />
        <a className="pill btn" href="/alert-lab">Alert Lab</a>
        <a className="pill btn" href="/settings">Settings</a>
        <a className="pill btn" href="/">← Scanner</a>
      </div>

      <div className="panel main" style={{ padding: 16, marginBottom: 14 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>{X.title}</h2>
        <div style={{ fontSize: 13, lineHeight: 1.7, color: "var(--muted)" }}>{X.summary}</div>
      </div>

      <Section title="The pipeline" items={X.pipeline} />
      <Section title="Not just what's moving" items={X.notJustMovement} />
      <Section title="Compared to broker scanners" items={X.comparedToBrokerScanners} />
      <Section title="Design goals" items={X.designGoals} />
      <Section title="Honest limits" items={X.honestLimits} />

      <div className="footer">Educational system documentation · no performance claims · not financial advice</div>
    </div>
  );
}

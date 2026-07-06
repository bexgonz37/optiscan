"use client";

import { SYSTEM_EXPLANATION as X } from "@/lib/system-explanation";

const Section = ({ title, items }: { title: string; items: string[] }) => (
  <div className="panel main system-explanation-block">
    <h3 className="system-explanation-heading">{title}</h3>
    <ul className="system-explanation-list">
      {items.map((s, i) => <li key={i}>{s}</li>)}
    </ul>
  </div>
);

export function SystemExplanationSection() {
  return (
    <div id="how-it-works" className="system-explanation-section">
      <div className="panel main system-explanation-intro">
        <h2 className="system-explanation-title">{X.title}</h2>
        <p className="muted settings-desc">{X.summary}</p>
      </div>
      <Section title="The pipeline" items={X.pipeline} />
      <Section title="Not just what's moving" items={X.notJustMovement} />
      <Section title="Compared to broker scanners" items={X.comparedToBrokerScanners} />
      <Section title="Compared to options flow tools" items={X.comparedToFlowTools} />
      <Section title="Design goals" items={X.designGoals} />
      <Section title="Honest limits" items={X.honestLimits} />
      <p className="muted system-explanation-footer">
        Educational system documentation · no performance claims · not financial advice
      </p>
    </div>
  );
}

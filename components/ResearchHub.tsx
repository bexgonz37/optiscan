"use client";

import Link from "next/link";

const LINKS = [
  { href: "/quant", title: "Quant Lab", sub: "Lane performance and evidence" },
  { href: "/scanner", title: "Scanner", sub: "Live tape and universe" },
  { href: "/intelligence", title: "Strategy Lab", sub: "Opportunity cases and theses" },
  { href: "/ai", title: "AI Advisory", sub: "Advisory only — never auto-trades" },
];

export function ResearchHub() {
  return (
    <div className="ui-page cc-term hub-page">
      <h1 className="hub-title">Research</h1>
      <p className="hub-sub">Evidence, scanner, and strategy tools — not the live decision screen.</p>
      <div className="hub-grid">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="hub-card">
            <strong>{l.title}</strong>
            <span className="muted">{l.sub}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

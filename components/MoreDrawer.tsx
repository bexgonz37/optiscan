"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const PRIMARY = [
  { href: "/callouts", title: "AI Options", sub: "Ranked live options decisions" },
  { href: "/quant", title: "Quant", sub: "Delivered, shadow, and paper analytics" },
  { href: "/watchlist", title: "Watchlist", sub: "Live monitored symbols" },
  { href: "/discord", title: "Discord", sub: "Delivery health, retries, readiness" },
  { href: "/research", title: "Research Hub", sub: "Scanner, strategy, and AI research" },
  { href: "/content-drafts", title: "Content Drafts", sub: "Owner drafts, never auto-posted" },
  { href: "/settings", title: "Settings", sub: "Token, lock dashboard, preferences" },
];

const ADVANCED = [
  { href: "/alerts", title: "Alerts History" },
  { href: "/pipeline-health#readiness", title: "Paid Beta Readiness" },
  { href: "/pipeline-health", title: "Pipeline Health" },
  { href: "/data", title: "System Health" },
  { href: "/shadow-soak", title: "Shadow Soak" },
  { href: "/performance", title: "Performance" },
  { href: "/research-learning", title: "Research & Learning" },
  { href: "/pipeline-health/research-platform", title: "Research Platform Ops" },
  { href: "/guide", title: "Guide" },
  { href: "/improvement", title: "Improvement Agent" },
];

export function MoreDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="more-drawer-overlay" role="dialog" aria-modal="true" aria-label="More">
      <button type="button" className="more-drawer-backdrop" aria-label="Close" onClick={onClose} />
      <aside className="more-drawer-panel">
        <div className="more-drawer-head">
          <strong>More</strong>
          <button type="button" className="ui-btn" onClick={onClose}>Close</button>
        </div>
        <div className="hub-grid">
          {PRIMARY.map((l) => (
            <Link key={l.href} href={l.href} className="hub-card" onClick={onClose}>
              <strong>{l.title}</strong>
              <span className="muted">{l.sub}</span>
            </Link>
          ))}
        </div>
        <details className="more-advanced">
          <summary>Advanced diagnostics</summary>
          <ul className="more-advanced-list">
            {ADVANCED.map((l) => (
              <li key={l.href}>
                <Link href={l.href} onClick={onClose}>{l.title}</Link>
              </li>
            ))}
          </ul>
        </details>
      </aside>
    </div>
  );
}

/** Mobile/desktop MORE entry that opens the drawer without navigating away. */
export function MoreNavButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} aria-label="More menu">
        MORE
      </button>
      <MoreDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}

"use client";

import { useEffect, useState } from "react";

const LS_KEY = "optiscan:guide:";

export function UsageGuide({ page }: { page: "dashboard" | "scanner" | "alerts" }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY + page);
      if (saved === "0") setOpen(false);
    } catch { /* ignore */ }
  }, [page]);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      try { localStorage.setItem(LS_KEY + page, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }

  const dashboard = (
    <ol className="guide-list">
      <li><strong>What&apos;s moving</strong> — symbols ranked by score (speed + volume). Default shows movers only; click <em>All</em> or <em>Pause</em> as needed.</li>
      <li><strong>Session banner</strong> — tells you whether you&apos;re in options mode (market hours) or shares-only mode (premarket/after hours).</li>
      <li><strong>Alerts</strong> — go there when a signal fires (popups also appear bottom-right).</li>
      <li><strong>Options research</strong> — expand below the tape for deeper momentum + unusual-flow tables (optional).</li>
    </ol>
  );

  const scanner = (
    <ol className="guide-list">
      <li><strong>Options research</strong> — ranked momentum setups and unusual flow. Optional — Live page is enough for daily use.</li>
      <li><strong>Momentum vs Unusual flow</strong> — two tabs. Toggle <em>Strong only</em> to filter.</li>
      <li><strong>Charts</strong> — click any row to open the chart drawer with 0DTE contract cards.</li>
    </ol>
  );

  const alerts = (
    <ol className="guide-list">
      <li><strong>Right now</strong> — one list, best first. The big card is the strongest live signal.</li>
      <li><strong>Signals</strong> — buy signals only show while the stock is actually moving the right way. Watch = forming, not ready.</li>
      <li><strong>Track record</strong> — did signals work 1m/5m after they fired?</li>
      <li><strong>Popups</strong> — only fire for a live buy signal. Everything else stays in history.</li>
    </ol>
  );

  return (
    <section className="panel guide-panel">
      <button type="button" className="guide-toggle" onClick={toggle}>
        <span>{open ? "▾" : "▸"}</span>
        <span>How to use {page === "dashboard" ? "Live" : page === "scanner" ? "options research" : "Alerts"}</span>
      </button>
      {open ? (
        <div className="guide-body">
          {page === "dashboard" ? dashboard : page === "scanner" ? scanner : alerts}
          <p className="guide-foot muted">
            Full instructions on the <a href="/guide" style={{ color: "inherit", textDecoration: "underline" }}>How to use</a> page.
            Research signals only — you choose entries and size. Not financial advice.
          </p>
        </div>
      ) : null}
    </section>
  );
}

export function CollapsibleSection({
  id,
  title,
  subtitle,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`optiscan:section:${id}`);
      if (saved === "1") setOpen(true);
      if (saved === "0") setOpen(false);
    } catch { /* ignore */ }
  }, [id]);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      try { localStorage.setItem(`optiscan:section:${id}`, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }

  return (
    <section className={`panel main section-block${open ? "" : " section-collapsed"}`}>
      <button type="button" className="section-header-btn" onClick={toggle}>
        <div>
          <h2 className="section-title">{title}</h2>
          {subtitle ? <p className="section-sub">{subtitle}</p> : null}
        </div>
        <span className="section-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open ? children : null}
    </section>
  );
}

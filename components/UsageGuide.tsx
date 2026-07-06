"use client";

import { useEffect, useState } from "react";

const LS_KEY = "optiscan:guide:";

export function UsageGuide({ page }: { page: "dashboard" | "alerts" }) {
  const [open, setOpen] = useState(true);

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
      <li><strong>Market scanner</strong> — all symbols ranked by <em>Watch score</em> (speed + volume + VWAP + levels). Sort by any column. This is your “what’s worth looking at” board.</li>
      <li><strong>Default view shows fast movers</strong> — click <em>All</em> to see the full universe, or <em>Pause</em> to freeze the table while you read it.</li>
      <li><strong>Alerts page</strong> — go there for BUY CALL / BUY PUT / WAIT / SKIP when the scanner fires a trade signal.</li>
    </ol>
  );

  const alerts = (
    <ol className="guide-list">
      <li><strong>Right now tab</strong> — one list, best first. The big card at the top is the strongest signal at this moment; click any row to load it and see the chart.</li>
      <li><strong>Signals</strong> — BUY CALL/PUT only shows while the stock is actually moving the right way (≥ 0.15%/min). WAIT = setup forming, not ready. SKIP/slow rows are hidden by default.</li>
      <li><strong>Popups</strong> — only fire for a live BUY CALL / BUY PUT. Everything else stays quiet in this page's history.</li>
      <li><strong>History and Journal tabs</strong> — past alerts (with the verdict then vs now), stats, and your personal trade log.</li>
    </ol>
  );

  return (
    <section className="panel guide-panel">
      <button type="button" className="guide-toggle" onClick={toggle}>
        <span>{open ? "▾" : "▸"}</span>
        <span>How to use {page === "dashboard" ? "the dashboard" : "Alerts"}</span>
      </button>
      {open ? (
        <div className="guide-body">
          {page === "dashboard" ? dashboard : alerts}
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

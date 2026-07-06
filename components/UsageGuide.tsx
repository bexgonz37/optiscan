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
      <li><strong>Filters</strong> — Fast (≥0.15%/min), Above/Below VWAP, HOD/LOD breaks. Click a row to open the chart.</li>
      <li><strong>Alerts page</strong> — go there for BUY CALL / BUY PUT / WAIT / SKIP when the scanner fires a trade signal.</li>
    </ol>
  );

  const alerts = (
    <ol className="guide-list">
      <li><strong>Buy calls / Buy puts</strong> — live panels at the top. Only shows names worth watching. Default filter hides slow movers.</li>
      <li><strong>What to do column</strong> — BUY CALL/PUT only when speed + scores pass. WAIT = not ready. SKIP = don’t trade.</li>
      <li><strong>Popup</strong> — fires on new alerts anywhere in the app. Click <strong>Watch chart</strong> first.</li>
      <li><strong>History + Log</strong> — below: past alerts, chart, and personal trade journal.</li>
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
          <p className="guide-foot muted">Research signals only — you choose entries and size. Not financial advice.</p>
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

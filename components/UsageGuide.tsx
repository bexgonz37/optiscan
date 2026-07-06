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
      <li><strong>Top momentum movers</strong> — Calls on the left, puts on the right. Default filter <strong>Worth watching</strong> hides slow names. Speed must be ≥ 0.15%/min for BUY.</li>
      <li><strong>Popup alerts</strong> — BUY CALL / PUT / WAIT / SKIP. Click <strong>Watch chart</strong> first. If speed drops after alert, verdict downgrades to WAIT.</li>
      <li><strong>Swing scanner</strong> (below) — slower scan every ~30s. Good for ideas; live movers + popups are what matter for fast entries.</li>
    </ol>
  );

  const alerts = (
    <ol className="guide-list">
      <li><strong>Action column</strong> — BUY CALL/PUT only when speed + contract + scores all pass. WAIT = idea forming. SKIP = don&apos;t trade.</li>
      <li><strong>Chart</strong> — click the button or the row to open candles + indicators for that ticker.</li>
      <li><strong>Log</strong> — record if you took a trade (personal journal, not order placement). TRACKING = still measuring follow-through.</li>
      <li><strong>Move @ alert</strong> = day&apos;s % change. A small number (+0.2%) can still alert from structure — check <em>Speed</em> column for live burst.</li>
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

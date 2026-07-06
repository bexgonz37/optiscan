"use client";

/**
 * DataAccessBanner — probes /api/health/data-access once on load and, when the
 * key's plan is missing data classes the scanner needs, explains exactly what
 * works and what is blocked. Dismissable per session.
 */

import { useCallback, useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";

interface ProbeResult {
  name: string;
  label: string;
  critical: boolean;
  status: number;
  allowed: boolean;
  message: string;
}

interface AccessReport {
  ok: boolean;
  keyPresent: boolean;
  allOk?: boolean;
  probes: ProbeResult[];
  summary: string;
  upgradeUrl?: string;
}

export function DataAccessBanner() {
  const [report, setReport] = useState<AccessReport | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/health/data-access", { cache: "no-store", headers: scanHeaders() });
      const d = (await res.json()) as AccessReport;
      setReport(d);
    } catch {
      /* best effort; stay silent on network hiccups */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!report || dismissed) return null;
  if (report.keyPresent && report.allOk) return null;

  const blocked = report.probes.filter((p) => !p.allowed);

  return (
    <div className="banner-warn data-access-banner">
      <div className="data-access-head">
        <div>
          <strong>Data access limited</strong>
          <span>{report.summary}</span>
        </div>
        <div className="data-access-actions">
          <button type="button" className="link-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide details" : "Details"}
          </button>
          <button type="button" className="link-btn" onClick={() => load()}>
            Recheck
          </button>
          {report.upgradeUrl ? (
            <a className="link-btn" href={report.upgradeUrl} target="_blank" rel="noreferrer">
              View plans
            </a>
          ) : null}
          <button type="button" className="link-btn" onClick={() => setDismissed(true)} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      </div>

      {expanded && report.probes.length ? (
        <ul className="data-access-list">
          {report.probes.map((p) => (
            <li key={p.name} className={p.allowed ? "ok" : "bad"}>
              <span className="da-dot" aria-hidden />
              <span className="da-label">{p.label}</span>
              <span className="da-status">
                {p.allowed ? "Available" : `Blocked (${p.status || "error"})`}
                {!p.allowed && p.message ? ` — ${p.message}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {expanded && !report.keyPresent ? (
        <div className="data-access-note">
          Set <code>POLYGON_API_KEY</code> (or <code>MASSIVE_API_KEY</code>) in <code>.env.local</code> and restart.
        </div>
      ) : null}
    </div>
  );
}

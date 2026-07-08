"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { marketSession, type MarketSession } from "@/lib/trading-session";
import { useLanguageMode, type LanguageMode } from "@/hooks/useLanguageMode";

const DISMISS_KEY = "optiscan:status-line:dismissed";

interface ProbeResult {
  name: string;
  label: string;
  critical: boolean;
  allowed: boolean;
}

interface AccessReport {
  ok: boolean;
  keyPresent: boolean;
  allOk?: boolean;
  probes: ProbeResult[];
  summary: string;
}

const SESSION_LABEL: Record<MarketSession, { text: string; mode: "options" | "off" }> = {
  regular: { text: "0DTE live · market open", mode: "options" },
  premarket: { text: "Callouts at 9:30 ET", mode: "off" },
  afterhours: { text: "Callouts resume 9:30 ET", mode: "off" },
  closed: { text: "Market closed", mode: "off" },
};

function sessionHint(session: MarketSession, mode: LanguageMode): string {
  if (session === "regular") {
    return mode === "public"
      ? "Fast movers → call/put momentum watches when a high-conviction signal fires. Check Alerts."
      : "Fast movers → BUY CALL/PUT when TRADE fires. Check Alerts.";
  }
  if (session === "premarket") return "Tape runs; option callouts fire at 9:30 AM ET.";
  if (session === "afterhours") return "Tape runs; option callouts resume at 9:30 AM ET.";
  return "Scanning pauses until 4:00 AM ET premarket.";
}

export function CompactStatusLine({
  loopLive,
  clock,
  streamFreshness,
}: {
  loopLive?: boolean;
  clock?: string;
  streamFreshness?: "green" | "yellow" | "red";
}) {
  const [session, setSession] = useState<MarketSession | null>(null);
  const languageMode = useLanguageMode();
  const [report, setReport] = useState<AccessReport | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === "1") setDismissed(true);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const update = () => setSession(marketSession());
    update();
    const t = setInterval(update, 60_000);
    return () => clearInterval(t);
  }, []);

  const loadAccess = useCallback(async () => {
    try {
      const res = await fetch("/api/health/data-access", { cache: "no-store", headers: scanHeaders() });
      setReport((await res.json()) as AccessReport);
    } catch { /* best effort */ }
  }, []);

  useEffect(() => {
    loadAccess();
  }, [loadAccess]);

  if (dismissed) return null;

  const badge = session ? SESSION_LABEL[session] : null;
  const hint = session ? sessionHint(session, languageMode) : "";
  const dataWarn = report && report.keyPresent && !report.allOk;
  const blockedCritical = report?.probes?.filter((p) => p.critical && !p.allowed) ?? [];

  return (
    <div className={`compact-status-line${dataWarn ? " compact-status-warn" : ""}`}>
      <div className="compact-status-main">
        {badge ? (
          <span className={`session-badge session-${badge.mode} compact-status-badge`}>
            <span className={`status-dot${badge.mode !== "off" ? " live" : ""}`} />
            {badge.text}
          </span>
        ) : null}

        {clock ? <span className="compact-status-clock num">{clock} ET</span> : null}

        {loopLive != null ? (
          <span className={`compact-status-tape${loopLive ? " live" : ""}`}>
            <span className={`status-dot${loopLive ? " live" : ""}${streamFreshness ? ` stream-fresh-${streamFreshness}` : ""}`} />
            {loopLive ? "Tape live" : "Tape offline"}
            {streamFreshness ? (
              <span className={`stream-fresh-label stream-fresh-${streamFreshness}`}>
                {streamFreshness === "green" ? " · fresh" : streamFreshness === "yellow" ? " · aging" : " · stale"}
              </span>
            ) : null}
          </span>
        ) : null}

        {dataWarn ? (
          <span className="compact-status-data-warn" title={report?.summary}>
            Data limited
          </span>
        ) : report?.allOk ? (
          <span className="compact-status-data-ok muted">Data OK</span>
        ) : null}

        <span className="compact-status-hint muted">{hint}</span>

        <Link href="/alerts" className="compact-status-link">
          Alerts →
        </Link>
      </div>

      <div className="compact-status-actions">
        {dataWarn ? (
          <button type="button" className="link-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide" : "Details"}
          </button>
        ) : null}
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
            setDismissed(true);
          }}
          aria-label="Dismiss status line"
        >
          Dismiss
        </button>
      </div>

      {expanded && dataWarn && report ? (
        <ul className="compact-status-probes">
          {report.probes.map((p) => (
            <li key={p.name} className={p.allowed ? "ok" : "bad"}>
              {p.label}: {p.allowed ? "OK" : "blocked"}
            </li>
          ))}
          {blockedCritical.length ? (
            <li className="bad">{report.summary}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

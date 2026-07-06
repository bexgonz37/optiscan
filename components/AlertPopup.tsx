"use client";

/**
 * AlertPopup — real-time popup stack for newly captured scanner alerts.
 *
 * Polls /api/alerts for rows newer than the last seen id (persisted in
 * localStorage), renders a card per alert with the full read + action buttons,
 * honors notification_settings (popup / desktop notification / sound), and
 * respects the language mode (private vs public labels). Snoozed tickers are
 * suppressed client-side for 1 hour. Every interaction is logged to
 * popup_events for the feedback loop.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { changeColor, fmtPct } from "@/lib/format";

interface PopupAlert {
  id: number; ticker: string; direction: string | null; alert_type: string | null;
  signal_score: number | null; risk_score: number | null; options_liquidity_score: number | null;
  catalyst_type: string | null; catalyst_quality: string | null;
  percent_move_at_alert: number | null; relative_volume: number | null;
  private_label: string | null; public_label: string | null;
  ai_explanation: string | null; public_explanation: string | null;
  option_symbol: string | null; option_side: string | null; strike: number | null;
  expiration: string | null; dte: number | null; price_at_alert: number | null;
}

const LS_LAST_ID = "optiscan:popup:lastId";
const LS_SNOOZE = "optiscan:popup:snooze";
const SNOOZE_MS = 60 * 60 * 1000;
const POLL_MS = 20_000;
const MAX_STACK = 3;

function beep() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sine"; osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.start(); osc.stop(ctx.currentTime + 0.36);
    osc.onended = () => ctx.close();
  } catch { /* ignore */ }
}

function snoozeMap(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(LS_SNOOZE) ?? "{}"); } catch { return {}; }
}

export function AlertPopup({ onOpenChain }: { onOpenChain?: (symbol: string) => void }) {
  const [stack, setStack] = useState<PopupAlert[]>([]);
  const [mode, setMode] = useState<"private" | "public">("private");
  const settingsRef = useRef<any>({ browser_popup_enabled: 1, desktop_notification_enabled: 1, sound_enabled: 1 });

  const logEvent = useCallback((alertId: number | null, ticker: string | null, action: string) => {
    fetch("/api/popup-events", {
      method: "POST",
      headers: { "content-type": "application/json", ...scanHeaders() },
      body: JSON.stringify({ alertId, ticker, action }),
    }).catch(() => {});
  }, []);

  const poll = useCallback(async () => {
    try {
      const headers = scanHeaders();
      const sRes = await fetch("/api/notifications/settings", { cache: "no-store", headers });
      const s = await sRes.json();
      if (s?.ok) {
        settingsRef.current = s.settings ?? settingsRef.current;
        setMode(s.languageMode === "public" ? "public" : "private");
      }
      if (!settingsRef.current?.browser_popup_enabled) return;

      const lastId = Number(localStorage.getItem(LS_LAST_ID) ?? 0);
      const res = await fetch(`/api/alerts?minId=${lastId}&limit=10`, { cache: "no-store", headers });
      const data = await res.json();
      const fresh: PopupAlert[] = (data.alerts ?? []).slice().reverse(); // oldest first
      if (!fresh.length) return;

      localStorage.setItem(LS_LAST_ID, String(Math.max(lastId, ...fresh.map((a) => a.id))));
      // First page load with an empty lastId: prime silently, don't replay history.
      if (!lastId) return;

      const snoozed = snoozeMap();
      const now = Date.now();
      const show = fresh.filter((a) => !(snoozed[a.ticker] && now - snoozed[a.ticker] < SNOOZE_MS));
      if (!show.length) return;

      setStack((prev) => [...prev, ...show].slice(-MAX_STACK));
      for (const a of show) logEvent(a.id, a.ticker, "shown");
      if (settingsRef.current?.sound_enabled) beep();
      if (settingsRef.current?.desktop_notification_enabled && typeof Notification !== "undefined" && Notification.permission === "granted") {
        const a = show[show.length - 1];
        const label = mode === "public" ? a.public_label : a.private_label;
        new Notification(`${label ?? "Scanner Alert"}: ${a.ticker}`, {
          body: `Setup ${Math.round(a.signal_score ?? 0)}/100 · Risk ${Math.round(a.risk_score ?? 0)}/100`,
          tag: `optiscan-${a.id}`,
        });
      }
    } catch { /* polling is best-effort */ }
  }, [logEvent, mode]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  function dismiss(a: PopupAlert) {
    setStack((prev) => prev.filter((x) => x.id !== a.id));
  }

  async function act(a: PopupAlert, action: string) {
    logEvent(a.id, a.ticker, action);
    if (action === "snooze") {
      const m = snoozeMap(); m[a.ticker] = Date.now();
      try { localStorage.setItem(LS_SNOOZE, JSON.stringify(m)); } catch { /* ignore */ }
    }
    if (action === "journal" || action === "trade_taken") {
      await fetch("/api/trade-journal", {
        method: "POST",
        headers: { "content-type": "application/json", ...scanHeaders() },
        body: JSON.stringify({
          alertId: a.id, ticker: a.ticker, side: a.option_side ?? undefined,
          contract: a.option_symbol ?? undefined,
          entryPrice: action === "trade_taken" ? a.price_at_alert ?? undefined : undefined,
          openedAt: action === "trade_taken" ? new Date().toISOString() : undefined,
          notes: action === "journal" ? "Journaled from popup" : "Marked taken from popup",
        }),
      }).catch(() => {});
    }
    if (action === "open_chain") onOpenChain?.(a.ticker);
    if (action === "open_details") window.location.href = "/alert-lab";
    if (action !== "open_chain") dismiss(a);
    else dismiss(a);
  }

  if (!stack.length) return null;

  const btn = { fontSize: 11, padding: "4px 8px" } as const;

  return (
    <div style={{ position: "fixed", right: 16, bottom: 16, zIndex: 90, display: "flex", flexDirection: "column", gap: 10, width: 380, maxWidth: "calc(100vw - 32px)" }}>
      {stack.map((a) => {
        const label = mode === "public" ? a.public_label : a.private_label;
        const explanation = mode === "public" ? a.public_explanation : a.ai_explanation;
        return (
          <div key={a.id} className="panel" style={{ padding: 14, boxShadow: "0 12px 40px rgba(0,0,0,.5)", border: "1px solid rgba(120,140,160,.35)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <strong style={{ fontSize: 14 }}>{label ?? "Scanner Alert"}: {a.ticker}</strong>
              <span className="spacer" style={{ flex: 1 }} />
              <button className="pill btn" style={btn} onClick={() => { logEvent(a.id, a.ticker, "ignore"); dismiss(a); }}>✕</button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              {a.direction === "bearish" ? "Bearish momentum" : a.direction === "bullish" ? "Bullish momentum" : "Volatile / Unclear"}
              {" · "}Setup {Math.round(a.signal_score ?? 0)}/100 · Risk {Math.round(a.risk_score ?? 0)}/100 · Liquidity {Math.round(a.options_liquidity_score ?? 0)}/100
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: changeColor(a.percent_move_at_alert) }}>{fmtPct(a.percent_move_at_alert)}</span>
              {a.relative_volume != null ? ` · RVOL ${a.relative_volume}x` : ""}
              {` · ${(a.catalyst_type ?? "no clear catalyst").replace(/_/g, " ")} (${a.catalyst_quality ?? "unknown"})`}
              {mode === "private" && a.option_symbol ? ` · ${a.strike}${String(a.option_side ?? "").toUpperCase().slice(0, 1)} ${a.dte ?? "—"}DTE zone` : ""}
            </div>
            {explanation ? (
              <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--muted)", whiteSpace: "pre-line", maxHeight: 96, overflow: "auto", marginBottom: 8 }}>
                {explanation}
              </div>
            ) : null}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <button className="pill btn" style={btn} onClick={() => act(a, "watch")}>Watch</button>
              <button className="pill btn" style={btn} onClick={() => act(a, "journal")}>Journal</button>
              <button className="pill btn" style={btn} onClick={() => act(a, "trade_taken")}>Mark Trade Taken</button>
              <button className="pill btn" style={btn} onClick={() => act(a, "snooze")}>Snooze</button>
              <button className="pill btn" style={btn} onClick={() => act(a, "open_chain")}>Open Chain</button>
              <button className="pill btn" style={btn} onClick={() => act(a, "open_details")}>Details</button>
            </div>
            {mode === "public" ? (
              <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>Educational market signal only. Not financial advice.</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

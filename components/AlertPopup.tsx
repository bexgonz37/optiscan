"use client";

/**
 * AlertPopup — real-time popup stack for newly captured scanner alerts.
 *
 * Interrupts ONLY for confirmed trades: a popup fires only when the verdict —
 * re-checked against the LIVE tape at this moment — is TRADE (BUY CALL /
 * BUY PUT). WAIT and SKIP alerts never popup or beep; they live in the Alerts
 * page history instead. While a popup is on screen its verdict keeps
 * re-computing against the live tape, so a stalled move downgrades in place.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { useLiveTapeMap, liveCtxFor } from "@/hooks/useLiveTapeMap";
import { computeTradeVerdict, isTradeEligible } from "@/lib/trade-verdict";
import { isOptionsSession } from "@/lib/trading-session";

interface PopupAlert {
  id: number; ticker: string; direction: string | null; alert_type: string | null;
  signal_score: number | null; risk_score: number | null; options_liquidity_score: number | null;
  catalyst_type: string | null; catalyst_quality: string | null;
  percent_move_at_alert: number | null; relative_volume: number | null;
  private_label: string | null; public_label: string | null;
  ai_explanation: string | null; public_explanation: string | null;
  option_symbol: string | null; option_side: string | null; strike: number | null;
  expiration: string | null; dte: number | null; price_at_alert: number | null;
  trade_bias: string | null; move_status: string | null;
  option_worth_score: number | null; worth_verdict: string | null;
  chase_risk: string | null; iv_risk: string | null; spread_risk: string | null;
  long_call_score: number | null; long_put_score: number | null;
  zero_dte_contract_score: number | null;
  short_rate_at_alert: number | null; volume_surge_at_alert: number | null;
  risk_flags: string | null; options_pressure_label: string | null;
  alert_tier: string | null;
  alert_time: string | null;
  asset_class: string | null;
  session: string | null;
  capture_action: string | null;
}

function alertKind(a: PopupAlert): "stock" | "options" {
  if (a.asset_class === "stock" || (a.trade_bias ?? "").startsWith("stock_")) return "stock";
  return "options";
}

function isExtendedStockAlert(a: PopupAlert): boolean {
  if (alertKind(a) !== "stock") return false;
  const s = a.session ?? "";
  return s === "premarket" || s === "afterhours";
}

function stockNotifyLabel(a: PopupAlert): string {
  const session = a.session === "afterhours" ? "After hours" : a.session === "premarket" ? "Premarket" : "Shares";
  return `${session} · SHARES ONLY`;
}

const LS_LAST_ID = "optiscan:popup:lastId";
const LS_SNOOZE = "optiscan:popup:snooze";
const SNOOZE_MS = 60 * 60 * 1000;
// Fast pickup — a BUY signal even a few seconds late is a missed entry on 0DTE.
const POLL_MS = 1_000;
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

function AlertCard({
  a,
  live,
  mode,
  onDismiss,
  onAct,
}: {
  a: PopupAlert;
  live: ReturnType<typeof liveCtxFor>;
  mode: "private" | "public";
  onDismiss: () => void;
  onAct: (action: string) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const kind = alertKind(a);

  return (
    <div className="panel popup-card">
      <div className="popup-card-head">
        <span className="spacer flex-1" />
        <button className="pill btn btn-xs" onClick={onDismiss}>✕</button>
      </div>

      {kind === "stock" ? (
        <StockAlertCard alert={a} mode={mode} showDetails={showDetails} />
      ) : (
        <OptionAlertCard alert={a} live={live} mode={mode} showDetails={showDetails} />
      )}

      <button
        type="button"
        className={`pill btn btn-xs${showDetails ? " mb-2" : ""}`}
        onClick={() => setShowDetails((v) => !v)}
      >
        {showDetails ? "Hide details" : "Show details"}
      </button>

      <div className="btn-row mt-2">
        <button className="pill btn btn-primary btn-xs" onClick={() => onAct("open_chart")}>Watch chart</button>
        {kind === "options" && computeTradeVerdict(a, live).action === "TRADE" ? (
          <button className="pill btn btn-xs" onClick={() => onAct("trade_taken")}>I took this trade</button>
        ) : null}
        <button className="pill btn btn-xs" onClick={() => onAct("journal")}>Journal</button>
        <button className="pill btn btn-xs" onClick={() => onAct("snooze")}>Snooze 1h</button>
      </div>
      <div className="muted text-xs mt-1">
        {mode === "public"
          ? "Educational market signal only. Not financial advice."
          : "Research signal — you decide size and execution."}
      </div>
    </div>
  );
}

export function AlertPopup({
  onOpenChart,
}: {
  onOpenChart?: (symbol: string) => void;
}) {
  const [stack, setStack] = useState<PopupAlert[]>([]);
  const [mode, setMode] = useState<"private" | "public">("private");
  const settingsRef = useRef<any>({ browser_popup_enabled: 1, desktop_notification_enabled: 1, sound_enabled: 1 });
  const tape = useLiveTapeMap(2000);
  const tapeRef = useRef(tape);
  const pollInFlight = useRef(false);
  tapeRef.current = tape;

  const logEvent = useCallback((alertId: number | null, ticker: string | null, action: string) => {
    fetch("/api/popup-events", {
      method: "POST",
      headers: { "content-type": "application/json", ...scanHeaders() },
      body: JSON.stringify({ alertId, ticker, action }),
    }).catch(() => {});
  }, []);

  const poll = useCallback(async () => {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const headers = scanHeaders();
      const sRes = await fetch("/api/notifications/settings", { cache: "no-store", headers });
      const s = await sRes.json();
      const langMode = s.languageMode === "public" ? "public" : "private";
      if (s?.ok) {
        settingsRef.current = s.settings ?? settingsRef.current;
        setMode(langMode);
      }
      if (!settingsRef.current?.browser_popup_enabled) return;
      const extendedStockNotify = Boolean(s.extendedStockNotify);

      const lastId = Number(localStorage.getItem(LS_LAST_ID) ?? 0);
      const res = await fetch(`/api/alerts?minId=${lastId}&limit=10`, { cache: "no-store", headers });
      const data = await res.json();
      const fresh: PopupAlert[] = (data.alerts ?? []).slice().reverse();
      if (!fresh.length) return;

      localStorage.setItem(LS_LAST_ID, String(Math.max(lastId, ...fresh.map((x) => x.id))));
      if (!lastId) return;

      const snoozed = snoozeMap();
      const now = Date.now();
      // Popups interrupt ONLY for a live-confirmed BUY CALL / BUY PUT.
      // Research-tier alerts and WAIT/SKIP verdicts stay in the Alerts history.
      const show = fresh.filter((x) =>
        !(snoozed[x.ticker] && now - snoozed[x.ticker] < SNOOZE_MS) &&
        x.alert_tier !== "research" &&
        !(isExtendedStockAlert(x) && !extendedStockNotify) &&
        // Never popup 0DTE options outside regular hours (9:30–16:00 ET).
        (alertKind(x) === "stock" || isOptionsSession()) &&
        isTradeEligible(x, liveCtxFor(tapeRef.current, x.ticker)),
      );
      if (!show.length) return;

      setStack((prev) => {
        const ids = new Set(prev.map((x) => x.id));
        const merged = [...prev, ...show.filter((x) => !ids.has(x.id))];
        return merged.slice(-MAX_STACK);
      });
      for (const x of show) logEvent(x.id, x.ticker, "shown");
      if (settingsRef.current?.sound_enabled) beep();
      if (settingsRef.current?.desktop_notification_enabled && typeof Notification !== "undefined" && Notification.permission === "granted") {
        const latest = show[show.length - 1];
        const kind = alertKind(latest);
        const v = computeTradeVerdict(latest, liveCtxFor(tapeRef.current, latest.ticker));
        const headline = v.headline;
        const prefix = kind === "stock" ? `[Stock] ` : `[0DTE] `;
        const title = langMode === "private"
          ? `${prefix}${latest.ticker}: ${headline}`
          : `${prefix}${latest.public_label ?? "Alert"}: ${latest.ticker}`;
        const body = langMode === "private"
          ? (kind === "stock" ? `${stockNotifyLabel(latest)} — setup ${Math.round(latest.signal_score ?? 0)}/100` : v.reason)
          : `Setup ${Math.round(latest.signal_score ?? 0)}/100 · Risk ${Math.round(latest.risk_score ?? 0)}/100`;
        new Notification(title, { body, tag: `optiscan-${latest.id}` });
      }
    } catch { /* polling is best-effort */ }
    finally { pollInFlight.current = false; }
  }, [logEvent]);

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
          notes: action === "trade_taken" ? `Took ${computeTradeVerdict(a).headline} from popup` : "Journaled from popup",
        }),
      }).catch(() => {});
    }
    if (action === "open_chart") onOpenChart?.(a.ticker);
    dismiss(a);
  }

  if (!stack.length) return null;

  return (
    <div className="popup-stack">
      {stack.map((a) => (
        <AlertCard
          key={a.id}
          a={a}
          live={liveCtxFor(tape, a.ticker)}
          mode={mode}
          onDismiss={() => { logEvent(a.id, a.ticker, "ignore"); dismiss(a); }}
          onAct={(action) => act(a, action)}
        />
      ))}
    </div>
  );
}

"use client";

import { fmtPct, fmtPrice, pctClass } from "@/lib/format";
import { alertKindExplanation } from "@/lib/language-modes";

export interface StockAlertLike {
  ticker: string;
  direction?: string | null;
  session?: string | null;
  price_at_alert?: number | null;
  percent_move_at_alert?: number | null;
  relative_volume?: number | null;
  signal_score?: number | null;
  risk_score?: number | null;
  private_label?: string | null;
  public_label?: string | null;
  capture_action?: string | null;
  asset_class?: string | null;
}

function sessionBadge(session: string | null | undefined): string {
  if (session === "premarket") return "Premarket";
  if (session === "afterhours") return "After hours";
  return "Extended";
}

export function StockAlertCard({
  alert,
  mode = "private",
  showDetails = false,
  compact = false,
}: {
  alert: StockAlertLike;
  mode?: "private" | "public";
  showDetails?: boolean;
  compact?: boolean;
}) {
  const label = mode === "public" ? alert.public_label : alert.private_label;
  const kindHint = alertKindExplanation({ asset_class: "stock", session: alert.session ?? "premarket" });
  const action = (alert.capture_action ?? "wait").toLowerCase();
  const headline = label ?? (alert.direction === "bearish" ? "SHORT setup" : "LONG setup");

  return (
    <div className={`alert-card alert-card-stock${compact ? " alert-card-compact" : ""}`}>
      <div className="alert-card-head">
        <strong className="text-sm">{alert.ticker}</strong>
        <span className="pill alert-badge-shares">SHARES ONLY</span>
        <span className="pill alert-badge-session">{sessionBadge(alert.session)}</span>
        {!compact ? <span className="muted text-xs alert-kind-hint">{kindHint}</span> : null}
      </div>

      <div className="text-sm fw-strong mb-2">
        <span className={`verdict-pill verdict-${action === "trade" ? "trade" : "wait"}`}>{headline}</span>
      </div>

      <div className="muted text-xs mb-2">
        <span>{fmtPrice(alert.price_at_alert)}</span>
        {" · "}
        <span className={pctClass(alert.percent_move_at_alert)}>Day {fmtPct(alert.percent_move_at_alert)}</span>
        {alert.relative_volume != null ? ` · RVOL ${alert.relative_volume}x` : ""}
      </div>

      {showDetails ? (
        <div className="popup-details">
          <div className="mb-2">
            Setup {Math.round(alert.signal_score ?? 0)}/100 · Risk {Math.round(alert.risk_score ?? 0)}/100
          </div>
          <div className="mb-2">Underlying shares only — no option contract on this callout.</div>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { fmtPct, fmtPrice, pctClass } from "@/lib/format";
import { alertKindExplanation, uiDirectiveLabel } from "@/lib/language-modes";
import { InfoTip } from "@/components/InfoTip";

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
  move_classification?: string | null;
  move_status?: string | null;
  signal_detected_at?: string | null;
  last_confirmed_at?: string | null;
  move_began_at?: string | null;
  data_timestamp?: string | null;
  invalidation_reason?: string | null;
  ai_explanation?: string | null;
}

function sessionBadge(session: string | null | undefined): string {
  if (session === "premarket") return "Premarket";
  if (session === "regular") return "Regular";
  if (session === "afterhours") return "After hours";
  return "Extended";
}

function ageLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 90) return `${sec}s ago`;
  return `${Math.round(sec / 60)}m ago`;
}

function timingHeadline(alert: StockAlertLike, mode: "private" | "public"): string {
  const dir = alert.direction === "bearish" ? "bearish" : alert.direction === "bullish" ? "bullish" : "mixed";
  const label = mode === "public" ? alert.public_label : alert.private_label;
  switch (alert.move_classification) {
    case "FRESH_MOVE":
      return dir === "bearish" ? "Fresh breakdown" : dir === "bullish" ? "Fresh breakout" : "Fresh move";
    case "CONTINUATION":
      return dir === "bearish" ? "Downside continuation" : dir === "bullish" ? "Upside continuation" : "Continuation";
    case "PULLBACK_SETUP":
      return "Pullback setup";
    case "OLD_MOVE":
      return "Old move - wait for new setup";
    case "EXTENDED":
      return "Extended - do not chase";
    case "STALE_SIGNAL":
      return "Stale data - blocked";
    case "NO_CURRENT_MOMENTUM":
      return "No current momentum";
    default:
      return label ?? (dir === "bearish" ? "Bearish watch" : dir === "bullish" ? "Bullish watch" : "Momentum watch");
  }
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
  const kindHint = alertKindExplanation({ asset_class: "stock", session: alert.session ?? "premarket" });
  const action = (alert.capture_action ?? "wait").toLowerCase();
  const headline = mode === "public" && action === "trade"
    ? uiDirectiveLabel(alert.direction === "bearish" ? "short" : "long", "public")
    : timingHeadline(alert, mode);
  const signalAge = ageLabel(alert.signal_detected_at);
  const moveAge = ageLabel(alert.move_began_at);
  const dataAge = ageLabel(alert.data_timestamp);

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

      <div className="muted text-xs mb-2">
        <span>{alert.move_status ?? alert.move_classification ?? "Timing audit pending"}</span>
        {signalAge ? ` · signal ${signalAge}` : ""}
        {moveAge ? ` · move began ${moveAge}` : ""}
        {dataAge ? ` · data ${dataAge}` : ""}
      </div>

      {showDetails ? (
        <div className="popup-details">
          <div className="mb-2">
            <InfoTip metric="setupScore">{`Setup ${Math.round(alert.signal_score ?? 0)}/100`}</InfoTip>
            {" · "}
            <InfoTip metric="riskScore">{`Risk ${Math.round(alert.risk_score ?? 0)}/100`}</InfoTip>
          </div>
          <div className="mb-2">Underlying shares only - no option contract on this callout.</div>
          {alert.invalidation_reason ? <div className="mb-2">Blocked because: {alert.invalidation_reason}</div> : null}
          {alert.ai_explanation ? <div className="mb-2">{alert.ai_explanation}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

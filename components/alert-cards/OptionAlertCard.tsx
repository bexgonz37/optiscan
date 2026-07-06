"use client";

import { fmtExpiry, fmtPct, pctClass } from "@/lib/format";
import { alertKindExplanation } from "@/lib/language-modes";
import { TradeVerdictHero, useTradeVerdict } from "@/components/TradeVerdictHero";
import type { LiveTapeContext } from "@/lib/trade-verdict";

export interface OptionAlertLike {
  ticker: string;
  option_side?: string | null;
  strike?: number | null;
  expiration?: string | null;
  dte?: number | null;
  percent_move_at_alert?: number | null;
  relative_volume?: number | null;
  signal_score?: number | null;
  risk_score?: number | null;
  zero_dte_contract_score?: number | null;
  option_worth_score?: number | null;
  move_status?: string | null;
  worth_verdict?: string | null;
  ai_explanation?: string | null;
  public_explanation?: string | null;
  private_label?: string | null;
  public_label?: string | null;
  asset_class?: string | null;
  session?: string | null;
}

const MOVE_STATUS_TEXT: Record<string, string> = {
  early: "Early Move",
  continuing: "Continuation Setup",
  extended_tradable: "Extended But Still Tradable",
  extended_risky: "Chase Risk",
  exhausted: "Move Exhausted",
};

function optionHeader(a: OptionAlertLike): string {
  const side = String(a.option_side ?? "").toLowerCase().startsWith("p") ? "PUT" : "CALL";
  const strike = a.strike != null ? `$${a.strike}` : "";
  const exp = a.expiration ? fmtExpiry(a.expiration) : a.dte === 0 ? "0DTE" : "";
  const parts = [`0DTE ${side}`, strike, exp].filter(Boolean);
  return parts.join(" · ");
}

export function OptionAlertCard({
  alert,
  live,
  mode = "private",
  showDetails = false,
  compact = false,
}: {
  alert: OptionAlertLike;
  live?: LiveTapeContext;
  mode?: "private" | "public";
  showDetails?: boolean;
  compact?: boolean;
}) {
  const verdict = useTradeVerdict(alert, live);
  const label = mode === "public" ? alert.public_label : alert.private_label;
  const explanation = mode === "public" ? alert.public_explanation : alert.ai_explanation;
  const kindHint = alertKindExplanation({ asset_class: "options", session: alert.session ?? "regular" });

  return (
    <div className={`alert-card alert-card-options${compact ? " alert-card-compact" : ""}`}>
      <div className="alert-card-head">
        <strong className="text-sm">{alert.ticker}</strong>
        <span className="pill alert-badge-0dte">{optionHeader(alert)}</span>
        {!compact ? <span className="muted text-xs alert-kind-hint">{kindHint}</span> : null}
      </div>

      {mode === "private" ? (
        <TradeVerdictHero alert={alert} live={live} />
      ) : (
        <div className="text-sm fw-strong mb-2">{label ?? "Scanner Alert"}</div>
      )}

      <div className="muted text-xs mb-2">
        <span className={pctClass(alert.percent_move_at_alert)}>Day {fmtPct(alert.percent_move_at_alert)}</span>
        {live?.shortRate != null ? ` · Speed now ${live.shortRate > 0 ? "+" : ""}${live.shortRate.toFixed(2)}%/min` : ""}
        {alert.relative_volume != null ? ` · RVOL ${alert.relative_volume}x` : ""}
      </div>

      {showDetails ? (
        <div className="popup-details">
          <div className="mb-2">
            Setup {Math.round(alert.signal_score ?? 0)}/100 · Risk {Math.round(alert.risk_score ?? 0)}/100
            {alert.zero_dte_contract_score != null ? ` · Contract ${Math.round(alert.zero_dte_contract_score)}/100` : ""}
            {alert.option_worth_score != null ? ` · Worth-it ${Math.round(alert.option_worth_score)}/100` : ""}
          </div>
          {(alert.move_status || alert.worth_verdict) ? (
            <div className="mb-2">
              {alert.move_status ? `Move: ${MOVE_STATUS_TEXT[alert.move_status] ?? alert.move_status}` : ""}
              {alert.worth_verdict ? ` · ${alert.worth_verdict}` : ""}
            </div>
          ) : null}
          {mode === "private" && verdict.bullets.map((b) => <div key={b}>{b}</div>)}
          {explanation ? <div className="popup-details-scroll">{explanation}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export { optionHeader };

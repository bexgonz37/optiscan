"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { useLiveTapeMap, liveCtxFor } from "@/hooks/useLiveTapeMap";
import { computeTradeVerdict } from "@/lib/trade-verdict";
import { fmtPct, fmtPrice, fmtTime } from "@/lib/format";
import { calledAgoLabel } from "@/lib/signal-live";
import { Panel } from "@/components/ui/Panel";

interface AlertRow {
  id: number;
  ticker: string;
  option_side: string | null;
  strike: number | null;
  signal_score: number | null;
  risk_score: number | null;
  options_liquidity_score: number | null;
  percent_move_at_alert: number | null;
  price_at_alert: number | null;
  catalyst_type: string | null;
  alert_time: string;
  short_rate_at_alert?: number | null;
  volume_surge_at_alert?: number | null;
  status: string;
}

function buildStubExplanation(alert: AlertRow, verdict: ReturnType<typeof computeTradeVerdict>) {
  const side = String(alert.option_side ?? "call").toLowerCase().startsWith("p") ? "put" : "call";
  return [
    `Latest callout: ${alert.ticker} ${side.toUpperCase()} scored ${alert.signal_score ?? "—"} with ${verdict.action} verdict right now.`,
    verdict.reason,
    "This panel is read-only — wire Claude API later for dynamic narration. Evidence chips below mirror the stored alert + live tape.",
  ].join(" ");
}

export default function CopilotPage() {
  const tape = useLiveTapeMap(1000);
  const [alert, setAlert] = useState<AlertRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/alerts?limit=20", { cache: "no-store", headers: scanHeaders() });
      const data = await res.json();
      const rows = (data.alerts ?? []) as AlertRow[];
      const pick =
        rows.find((a) => a.status === "tracking") ??
        rows[0] ??
        null;
      setAlert(pick);
      setError(data.ok === false ? data.error : null);
    } catch (err: any) {
      setError(err?.message ?? "Alerts unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const live = alert ? liveCtxFor(tape, alert.ticker) : undefined;
  const verdict = alert ? computeTradeVerdict(alert, live) : null;

  const evidence = useMemo(() => {
    if (!alert) return [];
    return [
      { label: "Signal", value: alert.signal_score ?? "—", src: "alert" },
      { label: "Risk", value: alert.risk_score ?? "—", src: "alert" },
      { label: "Liquidity", value: alert.options_liquidity_score ?? "—", src: "alert" },
      { label: "Speed @ call", value: alert.short_rate_at_alert != null ? `${alert.short_rate_at_alert.toFixed(2)}%/m` : "—", src: "alert" },
      { label: "Surge @ call", value: alert.volume_surge_at_alert?.toFixed(2) ?? "—", src: "alert" },
      { label: "Live speed", value: live?.shortRate != null ? `${live.shortRate.toFixed(2)}%/m` : "—", src: "tape" },
      { label: "Day @ call", value: fmtPct(alert.percent_move_at_alert), src: "alert" },
      { label: "Catalyst", value: (alert.catalyst_type ?? "none").replace(/_/g, " "), src: "alert" },
    ];
  }, [alert, live]);

  const explanation = alert && verdict ? buildStubExplanation(alert, verdict) : null;

  return (
    <div className="page-deck pg-copilot">
      <div className="page-deck-toolbar">
        <div className="alerts-tab-header muted">
          AI Copilot — read-only explainer for the latest callout. Claude API stub; no trades placed.
        </div>
        <button type="button" className="pill btn btn-xs" onClick={refresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className="axiom-alert-banner">
          <div className="label">Copilot data unavailable</div>
          <div className="sub">{error}</div>
        </div>
      ) : null}

      <div className="pgcop copilot-layout">
        <div className="copleft">
          <Panel title="Latest callout" meta={alert ? calledAgoLabel(alert.alert_time) ?? "recent" : "none"} live={alert?.status === "tracking"}>
            {!alert ? (
              <div className="empty small">No callouts yet — copilot narrates the newest alert once the scanner fires.</div>
            ) : (
              <div className="copilot-callout-card">
                <div className="copilot-ticker num">{alert.ticker}</div>
                <div className={`copilot-verdict verdict-${verdict?.action.toLowerCase() ?? "wait"}`}>
                  {verdict?.headline ?? "—"}
                </div>
                <div className="muted text-xs">{verdict?.contractLine ?? "—"}</div>
                <div className="copilot-meta muted text-xs">
                  {fmtTime(alert.alert_time)} · entry {fmtPrice(alert.price_at_alert)} · {alert.status}
                </div>
              </div>
            )}
          </Panel>
        </div>

        <section className="axiom-panel panel aiconsole copilot-console">
          <div className="aihead">
            <span>Model</span>
            <b className="mdl">Claude stub</b>
            <span>Mode</span>
            <b>Explain callout</b>
            <span>Trade</span>
            <b>Off</b>
          </div>
          <div className="thread">
            <div className="bubble user">
              <span className="brole">YOU</span>
              Explain the latest scanner callout with evidence only — no recommendation.
            </div>
            {explanation ? (
              <div className="bubble ai">
                <span className="brole">COPILOT</span>
                {explanation}
                <div className="evrow">
                  {evidence.map((chip) => (
                    <span key={chip.label} className="evchip">
                      <span>{chip.label}: {chip.value}</span>
                      <span className="src">{chip.src}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="bubble ai">
                <span className="brole">COPILOT</span>
                Waiting for a callout to explain…
              </div>
            )}
            <div className="aitype">
              <span className="d" aria-hidden />
              Read-only · connect ANTHROPIC_API_KEY to enable live responses
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

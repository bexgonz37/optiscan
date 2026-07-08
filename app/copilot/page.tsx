"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/ui/Panel";
import { scanHeaders } from "@/hooks/useScanner";
import { tradingDay } from "@/lib/trading-session";

/**
 * AI — READ-ONLY stub. Explains the latest callout using stored data.
 * Wire Claude later; never creates or gates signals.
 */

type Chip = { t: string; s: string };

function buildChips(a: any): Chip[] {
  if (!a) return [];
  const chips: Chip[] = [];
  const side = String(a.option_side ?? "").toLowerCase().startsWith("p") ? "puts" : "calls";
  if (a.short_rate_at_alert != null)
    chips.push({ t: `${a.short_rate_at_alert > 0 ? "+" : ""}${Number(a.short_rate_at_alert).toFixed(2)}%/min`, s: `A.${a.ticker} · aggregates` });
  if (a.volume_surge_at_alert != null)
    chips.push({ t: `RVOL ${Number(a.volume_surge_at_alert).toFixed(1)}×`, s: `A.${a.ticker} · volume` });
  if (a.entry_spread_pct != null)
    chips.push({ t: `spread ${Number(a.entry_spread_pct).toFixed(1)}%`, s: `O:${a.ticker} ${side} · NBBO` });
  if (a.entry_delta != null)
    chips.push({ t: `Δ ${Number(a.entry_delta).toFixed(2)}`, s: "options snapshot" });
  if (a.signal_score != null)
    chips.push({ t: `score ${Math.round(Number(a.signal_score))}`, s: "alert-scoring" });
  return chips;
}

export default function CopilotPage() {
  const [alert, setAlert] = useState<any | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/alerts?date=${tradingDay()}&limit=40`, { cache: "no-store", headers: scanHeaders() });
        const d = await res.json();
        const trades = ((d.alerts ?? []) as any[]).filter((a) => a.capture_action === "TRADE").sort((a, b) => b.id - a.id);
        if (!cancelled) setAlert(trades[0] ?? null);
      } catch {
        /* best effort */
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const chips = buildChips(alert);
  const side = String(alert?.option_side ?? "").toLowerCase().startsWith("p") ? "PUT" : "CALL";
  const explanation =
    alert?.ai_explanation ??
    alert?.private_label ??
    "No explanation stored for this callout yet.";

  return (
    <div className="page-deck axiom-copilot">
      <div className="axiom-scan-sweep" aria-hidden />

      <Panel title="AI" meta="READ-ONLY · COMING SOON" live>
        <div className="aihead">
          <span>SOURCE <b className="mdl">OptiScan rules engine</b></span>
          <span>CONTEXT <b>latest TRADE callout</b></span>
        </div>

        <div className="thread">
          <div className="bubble user">
            <span className="brole">YOU</span>
            Why did the last callout fire?
          </div>

          <div className={`bubble ai`}>
            <span className="brole">AXIOM</span>
            {alert ? (
              <>
                <b>{alert.capture_action === "TRADE" ? `BUY ${side}` : "WATCH"} {alert.ticker}</b>
                {alert.strike ? ` $${alert.strike} ${side.toLowerCase()}` : ""} — {explanation}
                {chips.length ? (
                  <div className="evrow">
                    {chips.map((c, i) => (
                      <span className="evchip" key={i}>
                        {c.t}
                        <span className="src">{c.s}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <>No TRADE callouts yet today. When one fires, its gate breakdown appears here.</>
            )}
          </div>

          <div className="aitype">
            <span className="d" />
            Explanations are rules-based (lib/explain.js) — AI never generates or gates signals.
          </div>
        </div>

        <div className="cpfoot">
          <div className="cmd">
            <span className="car">›</span>
            <input
              placeholder="Ask about a callout… (AI wiring coming soon)"
              onKeyDown={(e) => {
                // TODO: wire to Claude API — POST question + alert context, render reply as an .ai bubble.
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </div>
        </div>
      </Panel>
    </div>
  );
}

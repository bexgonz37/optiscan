"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { Panel } from "@/components/ui/Panel";
import { fmtPct, fmtMarketTime } from "@/lib/format";
import {
  formatAlertTweet,
  formatDailyRecapTweet,
  formatWeeklyDiscordPitch,
  postableOptionsAlerts,
  premiumDiscordCallouts,
  alertsInLastDays,
  dailyPnlSummary,
} from "@/lib/social-post";
import { formatCalloutHeadline, formatOptionsContract } from "@/lib/format-contract";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type Range = "today" | "week";

export function DailyPostPack({ alerts, tradingDay }: { alerts: any[]; tradingDay: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("today");
  const [weekAlerts, setWeekAlerts] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/alerts?limit=400", { cache: "no-store", headers: scanHeaders() });
        const d = await res.json();
        if (!cancelled && d?.ok) setWeekAlerts(d.alerts ?? []);
      } catch { /* best effort */ }
    })();
    return () => { cancelled = true; };
  }, [tradingDay]);

  const pool = useMemo(() => {
    if (range === "today") {
      return alerts.filter((a) => a.trading_day === tradingDay);
    }
    const src = weekAlerts.length ? weekAlerts : alerts;
    return alertsInLastDays(src, 7);
  }, [range, alerts, weekAlerts, tradingDay]);

  const postable = useMemo(() => postableOptionsAlerts(pool), [pool]);
  const premium = useMemo(() => premiumDiscordCallouts(pool), [pool]);
  const summary = useMemo(() => dailyPnlSummary(pool), [pool]);
  const recapText = useMemo(
    () => (range === "week" ? formatWeeklyDiscordPitch(pool) : formatDailyRecapTweet(pool)),
    [range, pool],
  );

  const onCopy = useCallback(async (key: string, text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    }
  }, []);

  const list = range === "week" ? premium : postable;

  return (
    <Panel
      title="Discord post pack"
      meta="Verified BUY callouts only · copy for Twitter / Discord sales"
    >
      <div className="daily-post-tabs">
        <button type="button" className={`pill btn btn-xs${range === "today" ? " btn-primary" : ""}`} onClick={() => setRange("today")}>
          Today
        </button>
        <button type="button" className={`pill btn btn-xs${range === "week" ? " btn-primary" : ""}`} onClick={() => setRange("week")}>
          This week
        </button>
      </div>

      <div className="daily-post-kpis">
        <div className="daily-post-kpi">
          <span className="k">BUY callouts</span>
          <span className="v num">{summary.buyCount}</span>
        </div>
        <div className="daily-post-kpi">
          <span className="k">Postable</span>
          <span className="v num">{summary.totalCallouts}</span>
        </div>
        <div className="daily-post-kpi">
          <span className="k">Wins</span>
          <span className="v num">{summary.graded ? `${summary.wins}/${summary.graded}` : "—"}</span>
        </div>
        <div className="daily-post-kpi">
          <span className="k">Avg contract</span>
          <span className={`v num ${(summary.avgReturnPct ?? 0) >= 0 ? "pos" : "neg"}`}>
            {summary.avgReturnPct != null ? fmtPct(summary.avgReturnPct) : "open"}
          </span>
        </div>
      </div>

      <div className="daily-post-recap">
        <div className="daily-post-recap-head">
          <strong>{range === "week" ? "Weekly Discord pitch" : "End-of-day recap"}</strong>
          <button type="button" className="pill btn btn-xs" onClick={() => onCopy("recap", recapText)}>
            {copied === "recap" ? "Copied!" : "Copy pitch"}
          </button>
        </div>
        <pre className="daily-post-pre">{recapText}</pre>
      </div>

      <div className="daily-post-list">
        {list.length === 0 ? (
          <p className="muted text-sm">
            {range === "week"
              ? "No verified BUY callouts this week yet — only TRADE-tier + tight spread posts here."
              : "No postable callouts today — fires during RTH 9:30–4:00 ET on liquid setups."}
          </p>
        ) : (
          list.slice(0, 15).map((a) => {
            const ret = a.option_return_pct ?? a.latest_max_move;
            const tweet = formatAlertTweet(a);
            return (
              <div key={a.id} className="daily-post-row">
                <div className="daily-post-row-top">
                  <span className="num">{formatCalloutHeadline(a)} · {a.ticker}</span>
                  <span className={`num ${(ret ?? 0) >= 0 ? "pos" : ret != null ? "neg" : ""}`}>
                    {ret != null ? fmtPct(ret) : "open"}
                  </span>
                </div>
                <div className="muted text-xs">
                  {formatOptionsContract(a) ?? "—"} · {fmtMarketTime(a.alert_time)} · {a.trading_day ?? ""}
                </div>
                <button type="button" className="pill btn btn-xs" onClick={() => onCopy(`a-${a.id}`, tweet)}>
                  {copied === `a-${a.id}` ? "Copied!" : "Copy tweet"}
                </button>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}

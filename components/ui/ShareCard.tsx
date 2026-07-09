"use client";



import { useCallback, useState } from "react";

import { fmtPct } from "@/lib/format";

import { formatAlertTweet } from "@/lib/social-post";



export function ShareCard({ alert }: { alert: any | null | undefined }) {

  const [copied, setCopied] = useState(false);



  const onCopy = useCallback(async () => {

    if (!alert) return;

    try {

      await navigator.clipboard.writeText(formatAlertTweet(alert));

      setCopied(true);

      setTimeout(() => setCopied(false), 2000);

    } catch { /* ignore */ }

  }, [alert]);



  if (!alert) {

    return (

      <div className="axiom-share-card axiom-share-empty">

        <div className="axiom-share-k">Best callout</div>

        <div className="muted text-sm">No graded callouts yet — wins appear here for screenshots.</div>

      </div>

    );

  }



  const side = String(alert.option_side ?? "call").toLowerCase().startsWith("p") ? "PUT" : "CALL";

  const ret = alert.option_return_pct ?? alert.latest_max_move ?? alert.eod_move;

  const positive = (ret ?? 0) >= 0;



  return (

    <div className="axiom-share-card">

      <div className="axiom-share-top">

        <span className="axiom-share-badge">TOP CALL</span>

        {alert.discord_sent ? <span className="axiom-share-discord">Discord ✓</span> : null}

        <button type="button" className="pill btn btn-xs axiom-share-copy" onClick={onCopy}>

          {copied ? "Copied!" : "Copy tweet"}

        </button>

      </div>

      <div className="axiom-share-ticker num">

        {alert.ticker}

        {alert.strike != null ? ` $${alert.strike}` : ""}

        <span className={`axiom-share-side ${side === "PUT" ? "bear" : "bull"}`}>{side}</span>

      </div>

      <div className={`axiom-share-ret num ${positive ? "pos" : "neg"}`}>

        {ret != null ? fmtPct(ret) : "open"}

      </div>

      <div className="axiom-share-meta muted text-xs">

        {alert.trading_day ?? "—"} · graded on contract mid · screenshot for Twitter

      </div>

    </div>

  );

}


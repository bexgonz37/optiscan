"use client";

import { frozenCalloutVerdict, type AlertVerdictInput, type LiveTapeContext, type TradeVerdict } from "@/lib/trade-verdict";

const ACTION_CLASS: Record<string, string> = {
  TRADE: "verdict-trade",
  WAIT: "verdict-wait",
  SKIP: "verdict-skip",
};

/** Big TRADE / WAIT / SKIP + BUY CALL / BUY PUT hero for private-mode alerts. */
export function TradeVerdictHero({
  alert,
  live,
  compact = false,
}: {
  alert: AlertVerdictInput;
  live?: LiveTapeContext;
  compact?: boolean;
}) {
  const v = frozenCalloutVerdict(alert, live);
  const cls = ACTION_CLASS[v.action] ?? "verdict-wait";
  const sideClass =
    v.side === "CALL" ? "verdict-side-call" : v.side === "PUT" ? "verdict-side-put" : "muted";

  if (compact) {
    return (
      <span className={`verdict-pill ${cls}`} title={v.reason}>
        {v.headline}
      </span>
    );
  }

  return (
    <div className={`verdict-hero ${cls}`}>
      <div className="verdict-headline">{v.headline}</div>
      {v.side !== "NONE" && v.action === "TRADE" ? (
        <div className={`verdict-side ${sideClass}`}>
          {v.side} · {v.confidence}% confidence
        </div>
      ) : (
        <div className="verdict-side muted">{v.action} · {v.confidence}% confidence</div>
      )}
      {v.contractLine ? <div className="verdict-contract">{v.contractLine}</div> : null}
      <div className="verdict-reason">{v.reason}</div>
      <div className="verdict-logic muted">{v.logicLine}</div>
    </div>
  );
}

export function useTradeVerdict(alert: AlertVerdictInput, live?: LiveTapeContext): TradeVerdict {
  return frozenCalloutVerdict(alert, live);
}

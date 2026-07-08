"use client";

import { frozenCalloutVerdict, type AlertVerdictInput, type LiveTapeContext, type TradeVerdict } from "@/lib/trade-verdict";
import { publicizeDirectiveText, uiDirectiveLabel } from "@/lib/language-modes";
import { useLanguageMode } from "@/hooks/useLanguageMode";

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
  // Verdict math is untouched; public mode only remaps the words on screen.
  const mode = useLanguageMode();
  const headline = mode === "public" ? publicizeDirectiveText(v.headline) : v.headline;
  const actionLabel = mode === "public" && v.action === "TRADE" ? uiDirectiveLabel("trade_tier", "public") : v.action;
  const cls = ACTION_CLASS[v.action] ?? "verdict-wait";
  const sideClass =
    v.side === "CALL" ? "verdict-side-call" : v.side === "PUT" ? "verdict-side-put" : "muted";

  if (compact) {
    return (
      <span className={`verdict-pill ${cls}`} title={v.reason}>
        {headline}
      </span>
    );
  }

  return (
    <div className={`verdict-hero ${cls}`}>
      <div className="verdict-headline">{headline}</div>
      {v.side !== "NONE" && v.action === "TRADE" ? (
        <div className={`verdict-side ${sideClass}`}>
          {v.side} · {v.confidence}% confidence
        </div>
      ) : (
        <div className="verdict-side muted">{actionLabel} · {v.confidence}% confidence</div>
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

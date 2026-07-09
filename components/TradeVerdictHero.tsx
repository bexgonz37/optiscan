"use client";

import { frozenCalloutVerdict, type AlertVerdictInput, type LiveTapeContext, type TradeVerdict } from "@/lib/trade-verdict";
import { publicizeDirectiveText, uiDirectiveLabel } from "@/lib/language-modes";
import { useLanguageMode } from "@/hooks/useLanguageMode";
import { InfoTip } from "@/components/InfoTip";
import { holdVerdict, makeHoldStore } from "@/lib/verdict-hold";
import type { TradeVerdict as TradeVerdictType } from "@/lib/trade-verdict";

// Display hysteresis (v1.1): downgrades commit only after they persist; the
// UI explains every weakening/downgrade instead of silently flipping.
const verdictHolds = makeHoldStore<TradeVerdictType & { action: string; reason: string }>();

function holdKey(alert: AlertVerdictInput): string {
  return `${alert.ticker ?? "?"}:${alert.option_side ?? ""}:${alert.strike ?? ""}:${alert.expiration ?? ""}`;
}

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
  const fresh = frozenCalloutVerdict(alert, live);
  // Display hysteresis: verdict math is untouched — only WHEN the screen
  // commits to a downgrade changes (upgrades always show instantly).
  const held = holdVerdict(verdictHolds, holdKey(alert), fresh as any);
  const v = held.shown as typeof fresh;
  // Verdict math is untouched; public mode only remaps the words on screen.
  const mode = useLanguageMode();
  const headline = mode === "public" ? publicizeDirectiveText(v.headline) : v.headline;
  const actionLabel = mode === "public" && v.action === "TRADE" ? uiDirectiveLabel("trade_tier", "public") : v.action;
  const cls = ACTION_CLASS[v.action] ?? "verdict-wait";
  const sideClass =
    v.side === "CALL" ? "verdict-side-call" : v.side === "PUT" ? "verdict-side-put" : "muted";

  if (compact) {
    return (
      <span className={`verdict-pill ${cls}${held.weakening ? " verdict-weakening" : ""}`} title={held.weakening ? `Weakening: ${held.weakeningReason ?? v.reason}` : v.reason}>
        {headline}{held.weakening ? " ⚠" : ""}
      </span>
    );
  }

  return (
    <div className={`verdict-hero ${cls}`}>
      <div className="verdict-headline">{headline}</div>
      {v.side !== "NONE" && v.action === "TRADE" ? (
        <div className={`verdict-side ${sideClass}`}>
          <InfoTip metric="tier">{v.side}</InfoTip> · <InfoTip metric="confidence">{`${v.confidence}% confidence`}</InfoTip>
        </div>
      ) : (
        <div className="verdict-side muted"><InfoTip metric="tier">{actionLabel}</InfoTip> · <InfoTip metric="confidence">{`${v.confidence}% confidence`}</InfoTip></div>
      )}
      {v.contractLine ? <div className="verdict-contract">{v.contractLine}</div> : null}
      {held.weakening ? (
        <div className="verdict-weakening-note">
          Weakening — {held.weakeningReason ?? "conditions deteriorating"} (downgrades only commit if this persists ~25s)
        </div>
      ) : held.downgradedFrom ? (
        <div className="verdict-downgrade-note">
          Downgraded from {held.downgradedFrom} — {held.weakeningReason ?? v.reason}
        </div>
      ) : null}
      <div className="verdict-reason">{v.reason}</div>
      <div className="verdict-logic muted">{v.logicLine}</div>
    </div>
  );
}

export function useTradeVerdict(alert: AlertVerdictInput, live?: LiveTapeContext): TradeVerdict {
  return frozenCalloutVerdict(alert, live);
}

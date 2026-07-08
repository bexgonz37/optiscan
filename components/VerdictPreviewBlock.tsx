"use client";

import { TradeVerdictHero } from "@/components/TradeVerdictHero";
import { fmtPremium } from "@/lib/format";
import { showOrderTicket } from "@/lib/language-modes";
import { useLanguageMode } from "@/hooks/useLanguageMode";
import type { AlertVerdictInput, LiveTapeContext } from "@/lib/trade-verdict";

export function VerdictPreviewBlock({
  alertInput,
  entryPremium,
  live,
  compact = false,
  onCopyTicket,
}: {
  alertInput: AlertVerdictInput | null | undefined;
  entryPremium?: number | null;
  live?: LiveTapeContext;
  compact?: boolean;
  onCopyTicket?: () => void;
}) {
  const mode = useLanguageMode();
  if (!alertInput) return null;

  return (
    <div className={`verdict-preview-block${compact ? " verdict-preview-block-compact" : ""}`}>
      <TradeVerdictHero alert={alertInput} live={live} compact={compact} />
      {!compact && entryPremium != null ? (
        <div className="verdict-entry-line">
          Entry @ <span className="num">{fmtPremium(entryPremium)}</span> (mid)
        </div>
      ) : null}
      {onCopyTicket && showOrderTicket(mode) ? (
        <button type="button" className="pill btn btn-xs verdict-copy-btn" onClick={onCopyTicket}>
          Copy ticket
        </button>
      ) : null}
    </div>
  );
}

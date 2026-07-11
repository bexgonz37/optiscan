"use client";

import { StatusBadge, DetailsDisclosure, type BadgeTone } from "@/components/ui/Shell";
import { InfoTip } from "@/components/InfoTip";
import type { ActionabilityStatus, TradeExplanation } from "@/lib/trade-explanation";
import type { PresentationMode } from "@/lib/dashboard-prefs";

/**
 * TradeExplanationCard — the ONE renderer of a shared TradeExplanation, used by
 * the Command Center and the options research surface. Simple and Advanced modes
 * read the EXACT SAME object; the mode only selects which fields are shown. No
 * business logic lives here — every string comes pre-built from the deterministic
 * explanation object.
 */

const STATUS_TONE: Record<ActionabilityStatus, BadgeTone> = {
  ACTIONABLE: "live",
  WATCH: "info",
  RESEARCH_ONLY: "muted",
  BLOCKED: "bad",
  INVALIDATED: "bad",
  NO_VALID_CONTRACT: "warn",
};

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  if (children == null || children === "") return null;
  return (
    <div className="tx-line">
      <span className="tx-line-label">{label}</span>
      <span className="tx-line-value">{children}</span>
    </div>
  );
}

function AdvancedMetrics({ exp }: { exp: TradeExplanation }) {
  const a = exp.advanced;
  const rows: { key: string; label: string; value: string }[] = [];
  const push = (key: string, label: string, value: string | number | null | undefined, suffix = "") => {
    if (value === null || value === undefined) return;
    rows.push({ key, label, value: `${value}${suffix}` });
  };
  push("", "Bid", a.bid != null ? `$${a.bid.toFixed(2)}` : null);
  push("", "Ask", a.ask != null ? `$${a.ask.toFixed(2)}` : null);
  push("", "Mid", a.mid != null ? `$${a.mid.toFixed(2)}` : null);
  push("spread", "Spread", a.spreadPct != null ? `${a.spreadPct.toFixed(1)}%` : null);
  push("delta", "Delta", a.delta != null ? a.delta.toFixed(2) : null);
  push("iv", "IV", a.iv != null ? `${Math.round(a.iv <= 5 ? a.iv * 100 : a.iv)}%` : null);
  push("", "Volume", a.volume != null ? a.volume.toLocaleString("en-US") : null);
  push("openInterest", "Open interest", a.openInterest != null ? a.openInterest.toLocaleString("en-US") : null);
  push("", "DTE", a.dte);
  push("", "Breakeven", a.breakevenPct != null ? `${a.breakevenPct.toFixed(2)}%` : null);
  push("relVol", "Rel. volume", a.relVol != null ? `${a.relVol}x` : null);
  push("vwap", "VWAP", a.vwapRelationship);
  push("", "Freshness", a.freshness);
  push("setupScore", "Score", a.score != null ? Math.round(a.score) : null);

  return (
    <div className="tx-adv">
      {rows.length ? (
        <div className="tx-adv-grid">
          {rows.map((r) => (
            <div className="tx-adv-cell" key={r.label}>
              <span className="tx-adv-k">
                {r.key ? <InfoTip metric={r.key}>{r.label}</InfoTip> : r.label}
              </span>
              <span className="tx-adv-v">{r.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="tx-muted">No raw contract metrics available for this setup.</div>
      )}
      {a.passedGates.length ? (
        <div className="tx-gates tx-gates-pass">Passed gates: {a.passedGates.join(" · ")}</div>
      ) : null}
      {a.failedGates.length ? (
        <div className="tx-gates tx-gates-fail">Failed gates: {a.failedGates.join(" · ")}</div>
      ) : null}
      {a.rejection ? (
        <div className="tx-rejection">
          Selector rejection [{a.rejection.code}]: {a.rejection.reason}
        </div>
      ) : null}
    </div>
  );
}

export function TradeExplanationCard({
  explanation,
  mode,
  className = "",
}: {
  explanation: TradeExplanation;
  mode: PresentationMode;
  className?: string;
}) {
  const exp = explanation;
  const advanced = mode === "advanced";
  const sideTxt = exp.side ? exp.side.toUpperCase() : null;

  return (
    <div className={`tx-card ${className}`.trim()}>
      <div className="tx-head">
        <span className="tx-ticker">{exp.ticker}</span>
        {sideTxt ? <span className="tx-side">{sideTxt}</span> : null}
        <StatusBadge tone={STATUS_TONE[exp.actionabilityStatus]}>{exp.statusLabel}</StatusBadge>
      </div>

      <Line label="Why now">{exp.whyNow}</Line>

      {exp.contractSummary ? (
        <Line label="Contract">{exp.contractSummary}</Line>
      ) : (
        <Line label="No contract">{exp.rejectedBecause}</Line>
      )}

      <Line label="Risk">{exp.riskSummary}</Line>
      <Line label="Improves if">{exp.wouldImproveIf}</Line>
      <Line label="Invalidated if">{exp.invalidatedIf}</Line>

      {advanced ? (
        <>
          <Line label="Why this contract">{exp.selectedBecause}</Line>
          {exp.notes.length ? (
            <div className="tx-notes">
              {exp.notes.map((n, i) => (
                <div className="tx-note" key={i}>{n}</div>
              ))}
            </div>
          ) : null}
          <DetailsDisclosure summary="Advanced metrics">
            <AdvancedMetrics exp={exp} />
          </DetailsDisclosure>
        </>
      ) : null}

      <div className="tx-evidence">{exp.evidenceSummary}</div>
    </div>
  );
}

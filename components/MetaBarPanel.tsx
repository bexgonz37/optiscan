"use client";

import { metaBarChecklist, metaBarPassCount, META_REFERENCE, isMetaShapedAlert } from "@/lib/meta-bar";

export function MetaBarPanel({
  alert,
  compact = false,
}: {
  alert: Record<string, unknown> | null | undefined;
  compact?: boolean;
}) {
  if (!alert) return null;
  const rows = metaBarChecklist(alert as Parameters<typeof metaBarChecklist>[0]);
  if (!rows.length) return null;
  const { pass, total } = metaBarPassCount(rows);
  const shaped = isMetaShapedAlert(alert as Parameters<typeof isMetaShapedAlert>[0]);
  const trade = String(alert.capture_action ?? "").toUpperCase() === "TRADE";

  return (
    <div className={`meta-bar-panel${compact ? " meta-bar-compact" : ""}`}>
      <div className="meta-bar-head">
        <span className="meta-bar-title">META bar</span>
        <span className={`meta-bar-badge${trade ? " on-trade" : shaped ? " on-shaped" : ""}`}>
          {trade ? "BUY tier" : shaped ? "META-shaped tape" : `${pass}/${total} gates`}
        </span>
        {!compact ? (
          <span className="muted text-xs">Ref: {META_REFERENCE.ticker} #{META_REFERENCE.alertId} · {META_REFERENCE.speed}%/m · {META_REFERENCE.surge}× surge</span>
        ) : null}
      </div>
      <ul className="meta-bar-grid">
        {rows.map((r) => (
          <li key={r.key} className={r.pass ? "pass" : "fail"} title={r.target}>
            <span className="meta-bar-k">{r.label}</span>
            <span className="meta-bar-v num">{r.actual}</span>
            {!compact ? <span className="meta-bar-t muted">{r.target}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

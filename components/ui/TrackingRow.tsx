"use client";

import type { ReactNode } from "react";

export function TrackingRow({
  tag,
  tagTone = "bull",
  symbol,
  sub,
  pnl,
  pnlTone,
  right,
  win,
  loss,
  onClick,
  title,
}: {
  tag: string;
  tagTone?: "bull" | "bear";
  symbol: string;
  sub?: ReactNode;
  pnl?: ReactNode;
  pnlTone?: "g" | "r" | "";
  right?: ReactNode;
  win?: boolean;
  loss?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const clickable = Boolean(onClick);
  return (
    <div
      className={`trow${win ? " win" : ""}${loss ? " loss" : ""}${clickable ? " trow-click" : ""}`}
      onClick={onClick}
      onKeyDown={clickable ? (e) => e.key === "Enter" && onClick?.() : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={title}
    >
      <span className={`ttag ${tagTone}`}>{tag}</span>
      <span className="tsym">
        <b>{symbol}</b>
        {sub ? <span className="tpx">{sub}</span> : null}
      </span>
      {pnl != null ? <span className={`tpnl num ${pnlTone ?? ""}`.trim()}>{pnl}</span> : <span />}
      <span className="ttimer">{right}</span>
    </div>
  );
}

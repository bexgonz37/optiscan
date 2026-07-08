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
}) {
  return (
    <div className={`trow${win ? " win" : ""}${loss ? " loss" : ""}`}>
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

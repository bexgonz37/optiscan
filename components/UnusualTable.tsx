"use client";

import { useMemo, useState } from "react";
import type { UnusualRow } from "@/lib/types";
import { TickerIcon, ScoreBar, IvBar, GradeChip } from "@/components/ui";
import { fmtExpiry, fmtInt, fmtNum, fmtPremium } from "@/lib/format";

type SortKey = "symbol" | "volume" | "oi" | "ratio" | "iv" | "dte" | "score";

function val(r: UnusualRow, k: SortKey): number | string {
  switch (k) {
    case "symbol": return r.symbol ?? "";
    case "volume": return r.volume ?? 0;
    case "oi": return r.openInterest ?? 0;
    case "ratio": return r.newPositioning ? Number.MAX_SAFE_INTEGER : r.volOiRatio ?? 0;
    case "iv": return r.iv ?? 0;
    case "dte": return r.dte ?? 0;
    default: return r.score ?? 0;
  }
}

export function UnusualTable({
  rows,
  selected,
  onSelect,
}: {
  rows: UnusualRow[];
  selected: string | null;
  onSelect: (symbol: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>("score");
  const [dir, setDir] = useState<-1 | 1>(-1);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = val(a, sort);
      const bv = val(b, sort);
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * dir;
      }
      return (av - bv) * dir;
    });
    return copy;
  }, [rows, sort, dir]);

  function toggle(k: SortKey) {
    if (sort === k) setDir((d) => (d === -1 ? 1 : -1));
    else {
      setSort(k);
      setDir(-1);
    }
  }

  const Th = ({ k, label }: { k: SortKey; label: string }) => (
    <th className={sort === k ? "sorted" : ""} onClick={() => toggle(k)}>
      {label}
      {sort === k ? <span className="arrow">{dir < 0 ? "▼" : "▲"}</span> : null}
    </th>
  );

  if (!rows.length) {
    return (
      <div className="empty">
        <div className="big">No unusual options activity detected.</div>
        Contracts trading far above their open interest show up here. Try clearing a filter.
      </div>
    );
  }

  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <Th k="symbol" label="Ticker" />
            <th>Type</th>
            <th>Contract</th>
            <Th k="volume" label="Volume" />
            <Th k="oi" label="OI" />
            <Th k="ratio" label="Vol/OI" />
            <Th k="iv" label="IV" />
            <Th k="dte" label="DTE" />
            <Th k="score" label="Signal" />
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={`${r.symbol}-${r.optionSymbol ?? `${r.side}${r.strike}${r.expiration}`}`}
              data-sym={r.symbol ?? ""}
              className={`clickable${selected === r.symbol ? " sel" : ""}`}
              onClick={() => r.symbol && onSelect(r.symbol)}
              title="Open live chart"
            >
              <td>
                <div className="tkr">
                  <TickerIcon symbol={r.symbol} />
                  <div>
                    <div className="tname">
                      {r.symbol}
                      {r.newPositioning ? <span className="tag t-new">NEW</span> : null}
                    </div>
                    <div className="tsub">{r.name ?? `${fmtPremium(r.mid)} mid`}</div>
                  </div>
                </div>
              </td>
              <td>
                <span className={`badge ${r.side === "call" ? "t-call" : "t-put"}`}>{String(r.side).toUpperCase()}</span>
              </td>
              <td className="num muted">
                {fmtNum(r.strike, 0)} · {fmtExpiry(r.expiration)}
              </td>
              <td className="num fw-strong">
                {fmtInt(r.volume)}
              </td>
              <td className="num muted">{fmtInt(r.openInterest)}</td>
              <td>
                <span
                  className={`badge vol-ratio-badge ${
                    r.newPositioning ? "vol-ratio-new" : (r.volOiRatio ?? 0) >= 2 ? "vol-ratio-high" : "vol-ratio-normal"
                  }`}
                >
                  {r.newPositioning ? "NEW" : `${fmtNum(r.volOiRatio, 1)}x`}
                </span>
              </td>
              <td>
                <IvBar iv={r.iv} />
              </td>
              <td className="num">{r.dte ?? "—"}</td>
              <td>
                <div className="score-row">
                  <ScoreBar score={r.score} />
                  <GradeChip grade={r.grade} />
                </div>
              </td>
              <td onClick={(ev) => ev.stopPropagation()}>
                <button type="button" className="pill btn btn-xs" onClick={() => r.symbol && onSelect(r.symbol)}>
                  Chart
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

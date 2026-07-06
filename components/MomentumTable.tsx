"use client";

import { useMemo, useState } from "react";
import type { MomentumRow } from "@/lib/types";
import { TickerIcon, ScoreBar, IvBar, GradeChip } from "@/components/ui";
import { changeColor, fmtNum, fmtPct, fmtPremium, fmtPrice, fmtInt } from "@/lib/format";

type SortKey = "symbol" | "price" | "chg" | "iv" | "delta" | "entry" | "dte" | "score";

const dirColor: Record<string, string> = {
  bullish: "var(--green)",
  bearish: "var(--red)",
  neutral: "var(--amber)",
};

function val(r: MomentumRow, k: SortKey): number | string {
  switch (k) {
    case "symbol": return r.symbol ?? "";
    case "price": return r.underlyingPrice ?? 0;
    case "chg": return r.movePct ?? 0;
    case "iv": return r.contract?.iv ?? 0;
    case "delta": return Math.abs(r.contract?.delta ?? 0);
    case "entry": return r.contract?.entry ?? 0;
    case "dte": return r.contract?.dte ?? 0;
    default: return r.score ?? 0;
  }
}

export function MomentumTable({
  rows,
  selected,
  onSelect,
}: {
  rows: MomentumRow[];
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
        <div className="big">Nothing setting up right now</div>
        Calls and puts show here as stocks build momentum. Try clearing a filter.
      </div>
    );
  }

  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <Th k="symbol" label="Ticker" />
            <Th k="price" label="Price" />
            <Th k="chg" label="Chg %" />
            <th>Setup</th>
            <Th k="iv" label="IV" />
            <Th k="delta" label="Δ" />
            <Th k="entry" label="Entry" />
            <Th k="dte" label="DTE" />
            <th>OI / Vol</th>
            <Th k="score" label="Signal" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={`${r.symbol}-${r.contract?.optionSymbol ?? r.side}`}
              data-sym={r.symbol ?? ""}
              className={selected === r.symbol ? "sel" : ""}
              onClick={() => r.symbol && onSelect(r.symbol)}
            >
              <td>
                <div className="tkr">
                  <TickerIcon symbol={r.symbol} />
                  <div>
                    <div className="tname">
                      {r.symbol}
                      {r.contract && (r.contract.iv ?? 0) > 0.8 ? <span className="tag t-iv">IV↑</span> : null}
                      {(r.relVol ?? 0) >= 1.5 ? <span className="tag t-vol">VOL</span> : null}
                    </div>
                    <div className="tsub">{r.name ?? (r.trend === "up" ? "Uptrend" : r.trend === "down" ? "Downtrend" : "Mixed")}</div>
                  </div>
                </div>
              </td>
              <td className="num">{fmtPrice(r.underlyingPrice).replace("$", "")}</td>
              <td className="num" style={{ color: changeColor(r.movePct) }}>
                {fmtPct(r.movePct)}
              </td>
              <td>
                <span className="badge b-strat" style={{ color: dirColor[r.bias] ?? "var(--muted)" }}>
                  Long {String(r.side ?? "").toUpperCase() || "—"}
                </span>
              </td>
              <td>
                <IvBar iv={r.contract?.iv} />
              </td>
              <td className="num">{fmtNum(r.contract?.delta, 2)}</td>
              <td className="num">{fmtPremium(r.contract?.entry)}</td>
              <td className="num">{r.contract?.dte ?? "—"}</td>
              <td className="num muted">
                {fmtInt(r.contract?.openInterest)} / {fmtInt(r.contract?.volume)}
              </td>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                  <ScoreBar score={r.score} />
                  <GradeChip grade={r.grade} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

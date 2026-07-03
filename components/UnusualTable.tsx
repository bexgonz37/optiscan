"use client";

import { useMemo, useState } from "react";
import type { UnusualRow } from "@/lib/types";
import { GradeChip, SideBadge, ScoreBar } from "@/components/ui";
import { fmtExpiry, fmtInt, fmtIv, fmtNum, fmtPremium, fmtRatio } from "@/lib/format";

type SortKey = "score" | "symbol" | "volume" | "ratio";

export function UnusualTable({
  rows,
  onSelect,
}: {
  rows: UnusualRow[];
  onSelect: (symbol: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>("score");
  const [dir, setDir] = useState<-1 | 1>(-1);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      switch (sort) {
        case "symbol": {
          const av = a.symbol ?? "";
          const bv = b.symbol ?? "";
          return av < bv ? dir : av > bv ? -dir : 0;
        }
        case "volume":
          return ((a.volume ?? 0) - (b.volume ?? 0)) * dir;
        case "ratio": {
          const av = a.newPositioning ? Infinity : a.volOiRatio ?? 0;
          const bv = b.newPositioning ? Infinity : b.volOiRatio ?? 0;
          return (av - bv) * dir;
        }
        default:
          return ((a.score ?? 0) - (b.score ?? 0)) * dir;
      }
    });
    return copy;
  }, [rows, sort, dir]);

  function toggle(key: SortKey) {
    if (sort === key) setDir((d) => (d === -1 ? 1 : -1));
    else {
      setSort(key);
      setDir(-1);
    }
  }

  const Th = ({ k, label, className = "" }: { k?: SortKey; label: string; className?: string }) => (
    <th
      className={`whitespace-nowrap px-3 py-2 text-left font-semibold uppercase tracking-wider text-zinc-500 ${
        k ? "cursor-pointer select-none hover:text-zinc-300" : ""
      } ${className}`}
      onClick={k ? () => toggle(k) : undefined}
    >
      {label}
      {k && sort === k ? (dir === -1 ? " ↓" : " ↑") : ""}
    </th>
  );

  if (!rows.length) {
    return <EmptyState />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-white/10 text-[10px]">
            <Th k="symbol" label="Symbol" />
            <Th label="Type" />
            <Th label="Contract" />
            <Th k="volume" label="Volume" />
            <Th label="OI" />
            <Th k="ratio" label="Vol/OI" />
            <Th label="Prem" />
            <Th label="IV" />
            <Th k="score" label="Score" />
            <Th label="Why" className="min-w-[200px]" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={`${r.symbol}-${r.optionSymbol ?? `${r.side}${r.strike}${r.expiration}`}`}
              onClick={() => r.symbol && onSelect(r.symbol)}
              className="row-in cursor-pointer border-b border-white/5 transition hover:bg-white/[0.03]"
            >
              <td className="px-3 py-2.5 font-bold text-zinc-100">{r.symbol}</td>
              <td className="px-3 py-2.5">
                <SideBadge side={r.side} />
              </td>
              <td className="tabular px-3 py-2.5 text-zinc-200">
                <span className="font-semibold">{fmtNum(r.strike, 0)}</span>
                <span className="text-zinc-500"> · {fmtExpiry(r.expiration)}</span>
                <span className="text-zinc-600"> ({r.dte}d)</span>
              </td>
              <td className="tabular px-3 py-2.5 font-semibold text-zinc-100">{fmtInt(r.volume)}</td>
              <td className="tabular px-3 py-2.5 text-zinc-400">{fmtInt(r.openInterest)}</td>
              <td className="px-3 py-2.5">
                <span
                  className={`tabular inline-flex items-center rounded px-1.5 py-0.5 text-xs font-bold ${
                    r.newPositioning
                      ? "bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-fuchsia-500/40"
                      : (r.volOiRatio ?? 0) >= 2
                        ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40"
                        : "text-zinc-300"
                  }`}
                >
                  {fmtRatio(r.volOiRatio, r.newPositioning)}
                </span>
              </td>
              <td className="tabular px-3 py-2.5 text-zinc-300">{fmtPremium(r.mid)}</td>
              <td className="tabular px-3 py-2.5 text-zinc-400">{fmtIv(r.iv)}</td>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <ScoreBar score={r.score} />
                  <GradeChip grade={r.grade} />
                </div>
              </td>
              <td className="px-3 py-2.5 text-[12px] text-zinc-400">
                <span className="line-clamp-2">{r.reason}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="grid place-items-center px-6 py-16 text-center">
      <div className="text-sm text-zinc-400">No unusual options activity detected.</div>
      <div className="mt-1 text-xs text-zinc-600">
        This tab flags contracts trading well above their open interest — a sign of fresh, aggressive positioning.
      </div>
    </div>
  );
}

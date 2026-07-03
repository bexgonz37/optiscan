"use client";

import { useMemo, useState } from "react";
import type { MomentumRow } from "@/lib/types";
import { GradeChip, SideBadge, ScoreBar } from "@/components/ui";
import { changeColor, fmtExpiry, fmtIv, fmtNum, fmtPct, fmtPremium, fmtPrice, fmtInt } from "@/lib/format";

type SortKey = "score" | "symbol" | "movePct" | "iv";

export function MomentumTable({
  rows,
  onSelect,
}: {
  rows: MomentumRow[];
  onSelect: (symbol: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>("score");
  const [dir, setDir] = useState<-1 | 1>(-1);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sort) {
        case "symbol":
          av = a.symbol ?? "";
          bv = b.symbol ?? "";
          return av < bv ? dir : av > bv ? -dir : 0;
        case "movePct":
          av = a.movePct ?? 0;
          bv = b.movePct ?? 0;
          break;
        case "iv":
          av = a.contract?.iv ?? 0;
          bv = b.contract?.iv ?? 0;
          break;
        default:
          av = a.score ?? 0;
          bv = b.score ?? 0;
      }
      return ((av as number) - (bv as number)) * dir;
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
            <Th label="Signal" />
            <Th k="movePct" label="Day" />
            <Th label="Contract" />
            <Th label="Entry" />
            <Th label="Δ" />
            <Th k="iv" label="IV" />
            <Th label="OI / Vol" />
            <Th k="score" label="Score" />
            <Th label="Why" className="min-w-[220px]" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={`${r.symbol}-${r.contract?.optionSymbol ?? r.side}`}
              onClick={() => r.symbol && onSelect(r.symbol)}
              className="row-in cursor-pointer border-b border-white/5 transition hover:bg-white/[0.03]"
            >
              <td className="px-3 py-2.5">
                <div className="font-bold text-zinc-100">{r.symbol}</div>
                <div className="tabular text-[11px] text-zinc-500">{fmtPrice(r.underlyingPrice)}</div>
              </td>
              <td className="px-3 py-2.5">
                <SideBadge side={r.side} />
              </td>
              <td className={`tabular px-3 py-2.5 font-semibold ${changeColor(r.movePct)}`}>
                {fmtPct(r.movePct)}
              </td>
              <td className="tabular px-3 py-2.5 text-zinc-200">
                {r.contract ? (
                  <>
                    <span className="font-semibold">{fmtNum(r.contract.strike, 0)}</span>
                    <span className="text-zinc-500"> · {fmtExpiry(r.contract.expiration)}</span>
                    <span className="text-zinc-600"> ({r.contract.dte}d)</span>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className="tabular px-3 py-2.5 text-zinc-200">{fmtPremium(r.contract?.entry)}</td>
              <td className="tabular px-3 py-2.5 text-zinc-400">{fmtNum(r.contract?.delta, 2)}</td>
              <td className="tabular px-3 py-2.5 text-zinc-400">{fmtIv(r.contract?.iv)}</td>
              <td className="tabular px-3 py-2.5 text-zinc-400">
                {fmtInt(r.contract?.openInterest)} / {fmtInt(r.contract?.volume)}
              </td>
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
      <div className="text-sm text-zinc-400">No directional options signals right now.</div>
      <div className="mt-1 text-xs text-zinc-600">
        The scanner surfaces calls/puts on stocks with the strongest intraday momentum. Check back as names start moving.
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { SymbolDetail } from "@/lib/types";
import { GradeChip, SideBadge, Stat } from "@/components/ui";
import {
  changeColor,
  fmtExpiry,
  fmtInt,
  fmtIv,
  fmtNum,
  fmtPct,
  fmtPremium,
  fmtPrice,
} from "@/lib/format";

export function DetailDrawer({ symbol, onClose }: { symbol: string | null; onClose: () => void }) {
  const [data, setData] = useState<SymbolDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/api/scan/${encodeURIComponent(symbol)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => !cancelled && setError(e?.message ?? "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (symbol) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [symbol, onClose]);

  if (!symbol) return null;

  const mom = data?.momentum ?? null;
  const contract = mom?.contract ?? null;
  const chain = (data?.contracts ?? [])
    .slice()
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, 12);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-white/10 bg-[#0b0f17] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-black tracking-tight text-zinc-50">{symbol}</h2>
            {data?.quote?.price != null && (
              <span className="tabular text-sm text-zinc-300">{fmtPrice(data.quote.price)}</span>
            )}
            {data?.quote?.changePercent != null && (
              <span className={`tabular text-sm font-semibold ${changeColor(data.quote.changePercent)}`}>
                {fmtPct(data.quote.changePercent)}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-sm text-zinc-300 hover:bg-white/[0.08]"
          >
            Esc
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && <div className="py-10 text-center text-sm text-zinc-500">Loading chain…</div>}
          {error && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {error}
            </div>
          )}

          {mom && (
            <>
              <div className="mb-2 flex items-center gap-2">
                <SideBadge side={mom.side} />
                <GradeChip grade={mom.grade} />
                <span className="text-xs uppercase tracking-wider text-zinc-500">{mom.bias}</span>
                <span className="tabular ml-auto text-xs text-zinc-500">
                  setup {Math.round(mom.momentumScore)} · signal {Math.round(mom.score)}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <Stat label="Day" value={fmtPct(mom.movePct)} accent={changeColor(mom.movePct)} />
                <Stat label="vs VWAP" value={fmtPct(mom.priceVsVwapPct)} accent={changeColor(mom.priceVsVwapPct)} />
                <Stat label="RSI" value={fmtNum(mom.rsi, 0)} />
                <Stat label="Rel vol" value={mom.relVol != null ? `${fmtNum(mom.relVol, 1)}x` : "—"} />
                <Stat label="Trend" value={mom.trend} />
                <Stat label="Price" value={fmtPrice(mom.underlyingPrice)} />
              </div>
            </>
          )}

          {contract && (
            <div className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4">
              <div className="mb-2 text-[10px] uppercase tracking-widest text-cyan-300/80">
                Suggested contract
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-bold text-zinc-50">
                  {symbol} {fmtNum(contract.strike, 0)} {String(contract.side).toUpperCase()}
                </span>
                <span className="text-sm text-zinc-400">{fmtExpiry(contract.expiration)} ({contract.dte}d)</span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Stat label="Entry (mid)" value={fmtPremium(contract.entry)} accent="text-cyan-300" />
                <Stat label="Bid / Ask" value={`${fmtPremium(contract.bid)} / ${fmtPremium(contract.ask)}`} />
                <Stat label="Breakeven" value={fmtPrice(contract.breakeven)} />
                <Stat label="Delta" value={fmtNum(contract.delta, 2)} />
                <Stat label="IV" value={fmtIv(contract.iv)} />
                <Stat label="Spread" value={contract.spreadPct != null ? `${contract.spreadPct}%` : "—"} />
                <Stat label="OI" value={fmtInt(contract.openInterest)} />
                <Stat label="Volume" value={fmtInt(contract.volume)} />
              </div>
              {mom?.warnings?.length ? (
                <div className="mt-3 text-[11px] text-amber-300/90">⚠ {mom.warnings.join(" · ")}</div>
              ) : null}
            </div>
          )}

          {data?.unusual?.length ? (
            <div className="mt-5">
              <div className="mb-2 text-[10px] uppercase tracking-widest text-zinc-500">Unusual activity</div>
              <div className="space-y-1.5">
                {data.unusual.map((u) => (
                  <div
                    key={u.optionSymbol ?? `${u.side}${u.strike}${u.expiration}`}
                    className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <SideBadge side={u.side} />
                      <span className="tabular text-zinc-200">
                        {fmtNum(u.strike, 0)} · {fmtExpiry(u.expiration)}
                      </span>
                    </div>
                    <div className="tabular text-xs text-zinc-400">
                      vol {fmtInt(u.volume)} · {u.newPositioning ? "NEW" : `${fmtNum(u.volOiRatio, 1)}x`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {chain.length ? (
            <div className="mt-5">
              <div className="mb-2 text-[10px] uppercase tracking-widest text-zinc-500">
                Most active contracts
              </div>
              <div className="overflow-hidden rounded-lg border border-white/5">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-white/[0.02] text-[10px] uppercase tracking-wider text-zinc-500">
                      <th className="px-2 py-1.5 text-left">Type</th>
                      <th className="px-2 py-1.5 text-right">Strike</th>
                      <th className="px-2 py-1.5 text-right">Exp</th>
                      <th className="px-2 py-1.5 text-right">Mid</th>
                      <th className="px-2 py-1.5 text-right">Vol</th>
                      <th className="px-2 py-1.5 text-right">OI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chain.map((c) => (
                      <tr key={c.optionSymbol ?? `${c.side}${c.strike}${c.expiration}`} className="border-t border-white/5">
                        <td className="px-2 py-1.5">
                          <span className={c.side === "call" ? "text-emerald-400" : "text-rose-400"}>
                            {String(c.side).toUpperCase().slice(0, 1)}
                          </span>
                        </td>
                        <td className="tabular px-2 py-1.5 text-right text-zinc-300">{fmtNum(c.strike, 0)}</td>
                        <td className="tabular px-2 py-1.5 text-right text-zinc-500">{fmtExpiry(c.expiration)}</td>
                        <td className="tabular px-2 py-1.5 text-right text-zinc-300">{fmtPremium(c.mid)}</td>
                        <td className="tabular px-2 py-1.5 text-right text-zinc-200">{fmtInt(c.volume)}</td>
                        <td className="tabular px-2 py-1.5 text-right text-zinc-500">{fmtInt(c.openInterest)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {!loading && !error && !mom && !data?.unusual?.length && (
            <div className="py-10 text-center text-sm text-zinc-500">No chain data available for {symbol}.</div>
          )}

          <p className="mt-6 text-[10px] leading-relaxed text-zinc-600">
            Signals only — OptiScan never places orders. Verify quotes in your broker before trading. Data via
            Polygon/Massive (delayed on free tiers).
          </p>
        </div>
      </aside>
    </div>
  );
}

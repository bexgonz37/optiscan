"use client";

import type { ScanMeta } from "@/lib/types";
import { fmtTime, isMarketHours } from "@/lib/format";

interface Props {
  meta: ScanMeta | null;
  loading: boolean;
  lastUpdated: number | null;
  autoRefresh: boolean;
  onToggleAuto: () => void;
  intervalSec: number;
  onIntervalChange: (sec: number) => void;
  notifyEnabled: boolean;
  onToggleNotify: () => void;
  onRefresh: () => void;
}

const INTERVALS = [15, 30, 60, 120];

export function TopBar({
  meta,
  loading,
  lastUpdated,
  autoRefresh,
  onToggleAuto,
  intervalSec,
  onIntervalChange,
  notifyEnabled,
  onToggleNotify,
  onRefresh,
}: Props) {
  const marketOpen = isMarketHours();
  const keyPresent = meta?.keyPresent ?? false;

  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-[#05070b]/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-cyan-400 to-emerald-500 text-sm font-black text-black shadow-lg shadow-cyan-500/20">
            O
          </div>
          <div className="leading-tight">
            <div className="text-sm font-bold tracking-tight text-zinc-100">
              OptiScan
            </div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">Options radar</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${
              marketOpen
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : "border-zinc-600/40 bg-white/[0.02] text-zinc-400"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${marketOpen ? "bg-emerald-400" : "bg-zinc-500"}`} />
            {marketOpen ? "Market open" : "Market closed"}
          </span>
          {!keyPresent && (
            <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
              No API key
            </span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="hidden items-center gap-1.5 text-[11px] text-zinc-500 sm:flex">
            {loading ? (
              <span className="inline-flex items-center gap-1.5 text-cyan-300">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 pulse-dot" /> scanning…
              </span>
            ) : (
              <span>updated {fmtTime(lastUpdated ? new Date(lastUpdated).toISOString() : null)}</span>
            )}
          </div>

          <button
            onClick={onRefresh}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-white/[0.07]"
            title="Refresh now"
          >
            Refresh
          </button>

          <div className="flex items-center overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
            <button
              onClick={onToggleAuto}
              className={`px-2.5 py-1.5 text-xs font-semibold transition ${
                autoRefresh ? "bg-emerald-500/20 text-emerald-300" : "text-zinc-300 hover:bg-white/[0.06]"
              }`}
            >
              {autoRefresh ? "Live" : "Paused"}
            </button>
            <select
              value={intervalSec}
              onChange={(e) => onIntervalChange(Number(e.target.value))}
              className="border-l border-white/10 bg-transparent px-1.5 py-1.5 text-xs text-zinc-300 outline-none [&>option]:bg-[#0b0f17]"
              title="Auto-refresh interval"
            >
              {INTERVALS.map((s) => (
                <option key={s} value={s}>
                  {s}s
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={onToggleNotify}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
              notifyEnabled
                ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-300"
                : "border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.07]"
            }`}
            title="Desktop alerts + sound on STRONG signals"
          >
            {notifyEnabled ? "Alerts on" : "Alerts off"}
          </button>
        </div>
      </div>
    </header>
  );
}

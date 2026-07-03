"use client";

import { useEffect, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { MomentumTable } from "@/components/MomentumTable";
import { UnusualTable } from "@/components/UnusualTable";
import { DetailDrawer } from "@/components/DetailDrawer";
import { useScanner, requestNotifyPermission } from "@/hooks/useScanner";

type Tab = "momentum" | "unusual";

export default function Page() {
  const [tab, setTab] = useState<Tab>("momentum");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [intervalSec, setIntervalSec] = useState(30);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // Restore prefs.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("optiscan:prefs");
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.autoRefresh === "boolean") setAutoRefresh(p.autoRefresh);
        if (typeof p.intervalSec === "number") setIntervalSec(p.intervalSec);
        if (typeof p.tab === "string") setTab(p.tab);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("optiscan:prefs", JSON.stringify({ autoRefresh, intervalSec, tab }));
    } catch {
      /* ignore */
    }
  }, [autoRefresh, intervalSec, tab]);

  const { momentum, unusual, meta, loading, error, lastUpdated, refresh } = useScanner({
    autoRefresh,
    intervalSec,
    notifyEnabled,
  });

  async function toggleNotify() {
    if (!notifyEnabled) {
      const ok = await requestNotifyPermission();
      setNotifyEnabled(ok);
    } else {
      setNotifyEnabled(false);
    }
  }

  const counts = { momentum: momentum.length, unusual: unusual.length };

  return (
    <div className="min-h-screen">
      <TopBar
        meta={meta}
        loading={loading}
        lastUpdated={lastUpdated}
        autoRefresh={autoRefresh}
        onToggleAuto={() => setAutoRefresh((v) => !v)}
        intervalSec={intervalSec}
        onIntervalChange={setIntervalSec}
        notifyEnabled={notifyEnabled}
        onToggleNotify={toggleNotify}
        onRefresh={refresh}
      />

      <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
        {meta && !meta.keyPresent && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-200">
            <span className="font-semibold">Add your Polygon/Massive API key</span> to{" "}
            <code className="rounded bg-black/30 px-1 py-0.5 text-xs">.env.local</code> as{" "}
            <code className="rounded bg-black/30 px-1 py-0.5 text-xs">POLYGON_API_KEY</code>, then restart. Until then
            the scanners have no live data.
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <TabButton active={tab === "momentum"} onClick={() => setTab("momentum")} label="Momentum" count={counts.momentum} />
          <TabButton active={tab === "unusual"} onClick={() => setTab("unusual")} label="Unusual Activity" count={counts.unusual} />

          {meta && (
            <div className="ml-auto hidden text-xs text-zinc-500 sm:block">
              scanned {meta.scannedCount} of {meta.universeCount} · {meta.provider}
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0b0f17]/70 shadow-xl shadow-black/40">
          <div className="border-b border-white/10 px-4 py-3">
            <h1 className="text-sm font-semibold text-zinc-200">
              {tab === "momentum" ? "Directional momentum options" : "Unusual options activity"}
            </h1>
            <p className="text-xs text-zinc-500">
              {tab === "momentum"
                ? "Best call/put on the stocks with the strongest intraday momentum. Click a row for the full chain."
                : "Contracts trading far above their open interest — fresh, aggressive positioning. Click a row for detail."}
            </p>
          </div>

          {tab === "momentum" ? (
            <MomentumTable rows={momentum} onSelect={setSelected} />
          ) : (
            <UnusualTable rows={unusual} onSelect={setSelected} />
          )}
        </div>

        <footer className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-600">
          <span>OptiScan · signals only, no order placement</span>
          <span className="hidden sm:inline">·</span>
          <span>Data: Polygon/Massive (delayed on free tiers)</span>
          <span className="hidden sm:inline">·</span>
          <span>Not financial advice</span>
        </footer>
      </main>

      <DetailDrawer symbol={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${
        active
          ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-200 shadow-lg shadow-cyan-500/10"
          : "border-white/10 bg-white/[0.02] text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
      }`}
    >
      {label}
      <span
        className={`tabular rounded-md px-1.5 py-0.5 text-[10px] ${
          active ? "bg-cyan-500/20 text-cyan-100" : "bg-white/5 text-zinc-500"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

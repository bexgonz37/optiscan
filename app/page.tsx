"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { CompactStatusLine } from "@/components/CompactStatusLine";
import { LivePageTabs } from "@/components/LivePageTabs";
import { ChartPanel } from "@/components/ChartPanel";
import { ZeroDteStrip } from "@/components/ZeroDteStrip";
import { useScannerStream } from "@/hooks/useScannerStream";

function LivePageInner() {
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const [clock, setClock] = useState("");
  const [loopLive, setLoopLive] = useState(false);
  const { freshness: streamFreshness } = useScannerStream();

  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString("en-US", {
          hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "America/New_York",
        }),
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const onOpenChart = useCallback((symbol: string) => {
    setChartSymbol(symbol);
    setChartOpen(true);
  }, []);

  return (
    <>
      <CompactStatusLine loopLive={loopLive} clock={clock} streamFreshness={streamFreshness} />

      <ZeroDteStrip chartSymbol={chartSymbol} onSelect={onOpenChart} />

      <LivePageTabs onOpenChart={onOpenChart} onLoopStatus={setLoopLive} />

      <ChartPanel symbol={chartSymbol} open={chartOpen} onClose={() => setChartOpen(false)} />
    </>
  );
}

export default function Page() {
  return (
    <div className="app app-live-compact">
      <AppNav hideSessionBadge />

      <Suspense fallback={null}>
        <LivePageInner />
      </Suspense>

      <div className="footer">
        OptiScan · Live watchlist · trade callouts on Alerts
      </div>
    </div>
  );
}

"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { CompactStatusLine } from "@/components/CompactStatusLine";
import { LivePageTabs } from "@/components/LivePageTabs";
import { useScannerStream } from "@/hooks/useScannerStream";
import { openLiveChart } from "@/lib/open-chart";

function LivePageInner() {
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
    openLiveChart(symbol);
  }, []);

  return (
    <>
      <CompactStatusLine loopLive={loopLive} clock={clock} streamFreshness={streamFreshness} />

      <LivePageTabs onOpenChart={onOpenChart} onLoopStatus={setLoopLive} />
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
        OptiScan · 0DTE fast movers · callouts on Alerts
      </div>
    </div>
  );
}

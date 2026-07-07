"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { LivePageTabs } from "@/components/LivePageTabs";
import { openLiveChart } from "@/lib/open-chart";

function LivePageInner() {
  const [clock, setClock] = useState("");
  const [, setLoopLive] = useState(false);

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
      <AppNav hideSessionBadge clock={clock} />

      <LivePageTabs onOpenChart={onOpenChart} onLoopStatus={setLoopLive} />
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LivePageInner />
    </Suspense>
  );
}

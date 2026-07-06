"use client";

import { useCallback, useEffect, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { DataAccessBanner } from "@/components/DataAccessBanner";
import { ScannerDashboard } from "@/components/ScannerDashboard";
import { ChartPanel } from "@/components/ChartPanel";
import { UsageGuide } from "@/components/UsageGuide";

export default function Page() {
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const [clock, setClock] = useState("");
  const [loopLive, setLoopLive] = useState(false);

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
    <div className="app">
      <AppNav
        status={[
          { label: clock ? `${clock} ET` : "—" },
          { label: loopLive ? "Tape live" : "Tape offline", live: loopLive },
        ]}
      />

      <DataAccessBanner />
      <UsageGuide page="dashboard" />

      <ScannerDashboard onOpenChart={onOpenChart} onLoopStatus={setLoopLive} />

      <ChartPanel symbol={chartSymbol} open={chartOpen} onClose={() => setChartOpen(false)} />

      <div className="footer">
        OptiScan scanner · ranked watchlist · trade signals are on the Alerts page
      </div>
    </div>
  );
}

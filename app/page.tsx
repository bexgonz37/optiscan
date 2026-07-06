"use client";

import { useCallback, useEffect, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { DataAccessBanner } from "@/components/DataAccessBanner";
import { ScannerDashboard } from "@/components/ScannerDashboard";
import { SessionBanner } from "@/components/SessionBanner";
import { OptionsResearchPanel } from "@/components/OptionsResearchPanel";
import { PageIntro } from "@/components/PageIntro";
import { ChartPanel } from "@/components/ChartPanel";

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
      <SessionBanner />

      <PageIntro
        title="Live"
        action={{ href: "/alerts", label: "Open Alerts →" }}
      >
        Watch what&apos;s moving. When a signal fires, check Alerts (or wait for a popup).
      </PageIntro>

      <ScannerDashboard onOpenChart={onOpenChart} onLoopStatus={setLoopLive} />

      <OptionsResearchPanel onOpenChart={onOpenChart} />

      <ChartPanel symbol={chartSymbol} open={chartOpen} onClose={() => setChartOpen(false)} />

      <div className="footer">
        OptiScan · Live watchlist · trade callouts on Alerts
      </div>
    </div>
  );
}

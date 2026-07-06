"use client";

import { useState, useCallback } from "react";
import { AlertPopup } from "@/components/AlertPopup";
import { ChartPanel } from "@/components/ChartPanel";

/** Alert popups + chart on every page. */
export function GlobalAlerts() {
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [chartOpen, setChartOpen] = useState(false);

  const onOpenChart = useCallback((symbol: string) => {
    setChartSymbol(symbol);
    setChartOpen(true);
  }, []);

  return (
    <>
      <AlertPopup onOpenChart={onOpenChart} />
      <ChartPanel symbol={chartSymbol} open={chartOpen} onClose={() => setChartOpen(false)} />
    </>
  );
}

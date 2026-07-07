"use client";

import { useState, useCallback, useEffect } from "react";
import { AlertPopup } from "@/components/AlertPopup";
import { ChartPanel } from "@/components/ChartPanel";
import { OPEN_CHART_EVENT } from "@/lib/open-chart";

/** Alert popups + chart on every page. */
export function GlobalAlerts() {
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [chartOpen, setChartOpen] = useState(false);

  const onOpenChart = useCallback((symbol: string) => {
    setChartSymbol(symbol);
    setChartOpen(true);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const sym = (e as CustomEvent<{ symbol?: string }>).detail?.symbol;
      if (sym) onOpenChart(sym);
    };
    window.addEventListener(OPEN_CHART_EVENT, handler);
    return () => window.removeEventListener(OPEN_CHART_EVENT, handler);
  }, [onOpenChart]);

  return (
    <>
      <AlertPopup onOpenChart={onOpenChart} />
      <ChartPanel symbol={chartSymbol} open={chartOpen} onClose={() => setChartOpen(false)} />
    </>
  );
}

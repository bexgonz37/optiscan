"use client";

import dynamic from "next/dynamic";
import { useState, useCallback, useEffect } from "react";
import { AlertPopup } from "@/components/AlertPopup";
import { OPEN_CHART_EVENT } from "@/lib/open-chart";

const ChartPanel = dynamic(
  () => import("@/components/ChartPanel").then((m) => ({ default: m.ChartPanel })),
  { ssr: false, loading: () => null },
);

/** Alert popups + chart on every page. Chart bundle loads only when a symbol is opened. */
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
      {chartOpen && chartSymbol ? (
        <ChartPanel symbol={chartSymbol} open={chartOpen} onClose={() => setChartOpen(false)} />
      ) : null}
    </>
  );
}

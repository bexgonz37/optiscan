"use client";

import { useEffect, useMemo, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";

const SPARKLINE_POLL_MS = 60_000;

/** Batch-fetch mini chart closes for visible tickers (cached ~60s). */
export function useSparklines(symbols: string[]): Record<string, number[]> {
  const key = useMemo(
    () => [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))].sort().join(","),
    [symbols],
  );
  const [series, setSeries] = useState<Record<string, number[]>>({});

  useEffect(() => {
    const list = key ? key.split(",") : [];
    if (!list.length) {
      setSeries({});
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/candles/sparklines?symbols=${encodeURIComponent(list.join(","))}`, {
          cache: "no-store",
          headers: scanHeaders(),
        });
        const d = await res.json();
        if (!cancelled && d.ok && d.series) setSeries(d.series);
      } catch { /* best effort */ }
    };
    load();
    const id = setInterval(load, SPARKLINE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [key]);

  return series;
}

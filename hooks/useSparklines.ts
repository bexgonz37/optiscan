"use client";

import { useEffect, useMemo, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";

const SPARKLINE_POLL_MS = 60_000;
const clientCache = new Map<string, { series: Record<string, number[]>; at: number }>();

/** Batch-fetch mini chart closes — client + server cached ~60s. */
export function useSparklines(symbols: string[]): Record<string, number[]> {
  const key = useMemo(
    () => [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))].sort().join(","),
    [symbols],
  );
  const [series, setSeries] = useState<Record<string, number[]>>(() => {
    const hit = clientCache.get(key);
    return hit && Date.now() - hit.at < SPARKLINE_POLL_MS ? hit.series : {};
  });

  useEffect(() => {
    const list = key ? key.split(",") : [];
    if (!list.length) {
      setSeries({});
      return;
    }
    const hit = clientCache.get(key);
    if (hit && Date.now() - hit.at < SPARKLINE_POLL_MS) {
      setSeries(hit.series);
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/candles/sparklines?symbols=${encodeURIComponent(list.join(","))}`, {
          headers: scanHeaders(),
        });
        const d = await res.json();
        if (!cancelled && d.ok && d.series) {
          clientCache.set(key, { series: d.series, at: Date.now() });
          setSeries(d.series);
        }
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

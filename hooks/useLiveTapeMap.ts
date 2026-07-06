"use client";

/**
 * useLiveTapeMap — shared client hook that polls the 1s scanner loop and
 * exposes the current tape as a symbol → live-metrics map. Every surface that
 * shows a BUY CALL / BUY PUT verdict feeds this into computeTradeVerdict so
 * the label is correct RIGHT NOW, not at alert time.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import type { LiveTapeContext } from "@/lib/trade-verdict";

export interface LiveTapeRow {
  symbol: string;
  price: number | null;
  movePct: number | null;
  shortRate: number | null;
  surge: number | null;
  relVol: number | null;
  direction: string;
  aboveVwap: boolean | null;
  vwapDistPct: number | null;
  hodBreak: boolean;
  lodBreak: boolean;
}

export interface LiveTape {
  rows: LiveTapeRow[];
  map: Map<string, LiveTapeRow>;
  running: boolean;
  note: string | null;
  lastUpdated: number | null;
}

/** Verdict context for one symbol — undefined when the loop doesn't track it. */
export function liveCtxFor(tape: LiveTape | null | undefined, symbol: string): LiveTapeContext | undefined {
  const r = tape?.map.get(symbol);
  if (!r) return undefined;
  return { shortRate: r.shortRate, surge: r.surge, price: r.price };
}

export function useLiveTapeMap(pollMs = 1000): LiveTape {
  const [rows, setRows] = useState<LiveTapeRow[]>([]);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/scanner/live?realtimeOnly=1", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d?.ok) {
        setRows((d.realtime?.tape ?? d.realtime?.movers ?? []) as LiveTapeRow[]);
        setRunning(Boolean(d.realtime?.running));
        setNote(d.realtime?.note ?? null);
        setLastUpdated(Date.now());
      }
    } catch { /* best effort */ }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, pollMs);
    return () => clearInterval(id);
  }, [poll, pollMs]);

  const map = useMemo(() => {
    const m = new Map<string, LiveTapeRow>();
    for (const r of rows) if (r?.symbol) m.set(r.symbol, r);
    return m;
  }, [rows]);

  return { rows, map, running, note, lastUpdated };
}

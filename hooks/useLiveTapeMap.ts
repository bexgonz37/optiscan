"use client";



/**

 * useLiveTapeMap — shared client hook backed by the SSE scanner stream (poll fallback).

 * Every surface that shows a BUY CALL / BUY PUT verdict feeds this into computeTradeVerdict

 * so the label is correct RIGHT NOW, not at alert time.

 */



import { useMemo } from "react";

import { useScannerStream } from "@/hooks/useScannerStream";

import type { LiveTapeContext } from "@/lib/trade-verdict";



export interface LiveTapeRow {

  symbol: string;

  price: number | null;

  movePct: number | null;

  shortRate: number | null;

  instantRate?: number | null;

  surge: number | null;

  relVol: number | null;

  direction: string;

  aboveVwap: boolean | null;

  vwapDistPct: number | null;

  hodBreak: boolean;

  lodBreak: boolean;

  catalystType?: string | null;

  catalystFresh?: boolean;

  haltStatus?: string | null;

}



export interface LiveTape {

  rows: LiveTapeRow[];

  map: Map<string, LiveTapeRow>;

  running: boolean;

  note: string | null;

  lastUpdated: number | null;

  freshness: "green" | "yellow" | "red";

  transport: "sse" | "poll";

}



/** Verdict context for one symbol — undefined when the loop doesn't track it. */

export function liveCtxFor(tape: LiveTape | null | undefined, symbol: string): LiveTapeContext | undefined {

  const r = tape?.map.get(symbol);

  if (!r) return undefined;

  return { shortRate: r.shortRate, surge: r.surge, price: r.price, direction: r.direction };

}



export function useLiveTapeMap(_pollMs = 1000): LiveTape {

  const { realtime, lastEventAt, freshness, transport } = useScannerStream();

  const rows = (realtime?.tape ?? realtime?.movers ?? []) as LiveTapeRow[];



  const map = useMemo(() => {

    const m = new Map<string, LiveTapeRow>();

    for (const r of rows) if (r?.symbol) m.set(r.symbol, r);

    return m;

  }, [rows]);



  return {

    rows,

    map,

    running: Boolean(realtime?.running),

    note: realtime?.note ?? null,

    lastUpdated: lastEventAt,

    freshness,

    transport,

  };

}



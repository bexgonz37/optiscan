/**
 * Keeps table row order stable between refreshes so live updates don't shuffle
 * the list every second. Re-sorts on an interval or when the user changes filters.
 */

import { useEffect, useRef, useState } from "react";

export function mergeStableSymbolOrder(previous: string[], ranked: string[], resort: boolean): string[] {
  if (resort || !previous.length) return [...ranked];
  const rankedSet = new Set(ranked);
  const kept = previous.filter((symbol) => rankedSet.has(symbol));
  const previousSet = new Set(previous);
  const added = ranked.filter((symbol) => !previousSet.has(symbol));
  return [...kept, ...added];
}

export function useStableSymbolOrder(
  symbols: string[],
  { intervalMs = 5000, paused = false, resetKey = "" }: { intervalMs?: number; paused?: boolean; resetKey?: string },
): string[] {
  const symbolsKey = symbols.join("\0");
  const [order, setOrder] = useState<string[]>(symbols);
  const lastSortAt = useRef(0);
  const prevReset = useRef(resetKey);
  const prevSymbolsKey = useRef(symbolsKey);
  const frozenOrder = useRef<string[] | null>(null);
  const prevPaused = useRef(false);

  useEffect(() => {
    if (paused && !prevPaused.current) {
      frozenOrder.current = order.length ? [...order] : [...symbols];
    }
    if (!paused) {
      frozenOrder.current = null;
    }
    prevPaused.current = paused;
  }, [paused, order, symbols]);

  useEffect(() => {
    if (prevReset.current !== resetKey) {
      prevReset.current = resetKey;
      lastSortAt.current = 0;
      prevSymbolsKey.current = symbolsKey;
      frozenOrder.current = null;
      setOrder(symbols);
      return;
    }

    if (!symbols.length) {
      setOrder((prev) => (prev.length ? [] : prev));
      prevSymbolsKey.current = symbolsKey;
      return;
    }

    if (paused) return;

    const now = Date.now();
    setOrder((prev) => {
      const resort = !prev.length || now - lastSortAt.current >= intervalMs;

      if (resort) {
        lastSortAt.current = now;
        prevSymbolsKey.current = symbolsKey;
        const next = mergeStableSymbolOrder(prev, symbols, true);
        if (prev.length === next.length && prev.every((s, i) => s === next[i])) return prev;
        return next;
      }

      const next = mergeStableSymbolOrder(prev, symbols, false);
      prevSymbolsKey.current = symbolsKey;
      if (next.length === prev.length && next.every((s, i) => s === prev[i])) return prev;
      return next;
    });
  }, [symbolsKey, paused, intervalMs, resetKey, symbols]);

  if (paused) {
    return frozenOrder.current ?? order;
  }

  const symSet = new Set(symbols);
  const out = order.filter((s) => symSet.has(s));
  return out.length ? out : symbols;
}

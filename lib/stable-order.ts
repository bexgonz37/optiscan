/**
 * Keeps table row order stable between refreshes so live updates don't shuffle
 * the list every second. Re-sorts on an interval or when the user changes filters.
 */

import { useEffect, useRef, useState } from "react";

export function useStableSymbolOrder(
  symbols: string[],
  { intervalMs = 5000, paused = false, resetKey = "" }: { intervalMs?: number; paused?: boolean; resetKey?: string },
): string[] {
  const [order, setOrder] = useState<string[]>([]);
  const lastSortAt = useRef(0);
  const prevReset = useRef(resetKey);

  useEffect(() => {
    if (prevReset.current !== resetKey) {
      prevReset.current = resetKey;
      lastSortAt.current = 0;
      setOrder([]);
    }
  }, [resetKey]);

  useEffect(() => {
    if (!symbols.length) {
      setOrder([]);
      return;
    }
    if (paused) return;

    const symSet = new Set(symbols);
    const now = Date.now();
    setOrder((prev) => {
      if (!prev.length || now - lastSortAt.current >= intervalMs) {
        lastSortAt.current = now;
        return symbols;
      }
      const kept = prev.filter((s) => symSet.has(s));
      const added = symbols.filter((s) => !prev.includes(s));
      return [...kept, ...added];
    });
  }, [symbols, paused, intervalMs]);

  if (paused || !order.length) return symbols;
  const map = new Set(symbols);
  return order.filter((s) => map.has(s));
}

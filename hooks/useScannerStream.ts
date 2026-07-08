"use client";

/**
 * useScannerStream — SSE subscription to /api/scanner/stream with poll fallback.
 * Debounces tape payload updates (~400ms, max 900ms) while freshness stays immediate.
 */

import { useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";

export type StreamFreshness = "green" | "yellow" | "red";

export interface ScannerStreamSnapshot {
  realtime: any | null;
  lastEventAt: number | null;
  transport: "sse" | "poll";
}

const UI_DEBOUNCE_MS = 400;
const UI_FLUSH_MAX_MS = 900;

export function streamFreshness(lastEventAt: number | null, nowMs = Date.now()): StreamFreshness {
  if (lastEventAt == null) return "red";
  const ago = nowMs - lastEventAt;
  if (ago < 2000) return "green";
  if (ago < 10_000) return "yellow";
  return "red";
}

let snapshot: ScannerStreamSnapshot = { realtime: null, lastEventAt: null, transport: "poll" };
const listeners = new Set<(s: ScannerStreamSnapshot) => void>();
let started = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let flushMaxTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRealtime: any | null = null;

function flushPendingRealtime() {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (flushMaxTimer) { clearTimeout(flushMaxTimer); flushMaxTimer = null; }
  snapshot = { ...snapshot, realtime: pendingRealtime };
  notifyAll();
}

function notifyAll() {
  for (const fn of listeners) fn(snapshot);
}

function emit(next: Partial<ScannerStreamSnapshot>) {
  if (next.lastEventAt != null || next.transport != null) {
    snapshot = {
      ...snapshot,
      lastEventAt: next.lastEventAt ?? snapshot.lastEventAt,
      transport: next.transport ?? snapshot.transport,
    };
    notifyAll();
  }

  if (next.realtime !== undefined) {
    pendingRealtime = next.realtime;
    if (!debounceTimer) {
      debounceTimer = setTimeout(flushPendingRealtime, UI_DEBOUNCE_MS);
      flushMaxTimer = setTimeout(flushPendingRealtime, UI_FLUSH_MAX_MS);
    }
  }
}

async function pollOnce() {
  try {
    const res = await fetch("/api/scanner/live?realtimeOnly=1", { cache: "no-store", headers: scanHeaders() });
    const d = await res.json();
    if (d?.ok) emit({ realtime: d.realtime, lastEventAt: Date.now(), transport: "poll" });
  } catch { /* best effort */ }
}

function startPollFallback() {
  if (pollTimer) return;
  emit({ transport: "poll" });
  pollOnce();
  pollTimer = setInterval(pollOnce, 1000);
}

/**
 * SSE via fetch-streaming (not EventSource): the API token must ride in the
 * x-scan-token header — EventSource cannot send headers and ?token= is no
 * longer accepted server-side (URL tokens leak into logs/referrers; audit
 * P0-3). Any stream failure degrades to the 1s poll fallback, same as before.
 */
function ensureScannerStream() {
  if (started) return;
  started = true;

  if (typeof window === "undefined" || typeof fetch === "undefined") {
    startPollFallback();
    return;
  }

  (async () => {
    try {
      const res = await fetch("/api/scanner/stream", {
        cache: "no-store",
        headers: { Accept: "text/event-stream", ...scanHeaders() },
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d?.ok) emit({ realtime: d.realtime, lastEventAt: d.ts ?? Date.now(), transport: "sse" });
          } catch { /* ignore malformed */ }
        }
      }
      startPollFallback(); // server closed the stream
    } catch {
      startPollFallback();
    }
  })();
}

export function useScannerStream() {
  const [state, setState] = useState<ScannerStreamSnapshot>(snapshot);

  useEffect(() => {
    ensureScannerStream();
    const fn = (s: ScannerStreamSnapshot) => setState(s);
    listeners.add(fn);
    fn(snapshot);
    return () => { listeners.delete(fn); };
  }, []);

  return {
    ...state,
    freshness: streamFreshness(state.lastEventAt),
  };
}

"use client";

/**
 * useScannerStream — SSE subscription to /api/scanner/stream with poll fallback.
 * Debounces tape payload updates (~750ms) while freshness stays immediate.
 */

import { useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";

export type StreamFreshness = "green" | "yellow" | "red";

export interface ScannerStreamSnapshot {
  realtime: any | null;
  lastEventAt: number | null;
  transport: "sse" | "poll";
}

const UI_DEBOUNCE_MS = 300;

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
let eventSource: EventSource | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRealtime: any | null = null;

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
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      snapshot = { ...snapshot, realtime: pendingRealtime };
      debounceTimer = null;
      notifyAll();
    }, UI_DEBOUNCE_MS);
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

function ensureScannerStream() {
  if (started) return;
  started = true;

  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    startPollFallback();
    return;
  }

  try {
    let token = "";
    try { token = localStorage.getItem("optiscan:token") ?? ""; } catch { /* ignore */ }
    const q = token ? `?token=${encodeURIComponent(token)}` : "";
    eventSource = new EventSource(`/api/scanner/stream${q}`);
    eventSource.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d?.ok) emit({ realtime: d.realtime, lastEventAt: d.ts ?? Date.now(), transport: "sse" });
      } catch { /* ignore malformed */ }
    };
    eventSource.onerror = () => {
      eventSource?.close();
      eventSource = null;
      startPollFallback();
    };
  } catch {
    startPollFallback();
  }
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

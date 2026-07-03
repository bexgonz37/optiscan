"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MomentumRow, UnusualRow, ScanMeta } from "@/lib/types";

export interface ScannerState {
  momentum: MomentumRow[];
  unusual: UnusualRow[];
  meta: ScanMeta | null;
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
}

const STRONG_ONLY_MIN = 80;

function momentumId(r: MomentumRow): string {
  return `M:${r.symbol}:${r.contract?.optionSymbol ?? `${r.side}:${r.contract?.strike}:${r.contract?.expiration}`}`;
}
function unusualId(r: UnusualRow): string {
  return `U:${r.symbol}:${r.optionSymbol ?? `${r.side}:${r.strike}:${r.expiration}`}`;
}

function beep() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
    osc.onended = () => ctx.close();
  } catch {
    /* ignore */
  }
}

function notify(title: string, body: string) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, icon: "/favicon.ico", tag: title });
    }
  } catch {
    /* ignore */
  }
}

export function useScanner(opts: {
  autoRefresh: boolean;
  intervalSec: number;
  notifyEnabled: boolean;
}) {
  const { autoRefresh, intervalSec, notifyEnabled } = opts;
  const [state, setState] = useState<ScannerState>({
    momentum: [],
    unusual: [],
    meta: null,
    loading: false,
    error: null,
    lastUpdated: null,
  });

  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const notifyRef = useRef(notifyEnabled);
  notifyRef.current = notifyEnabled;
  const inFlight = useRef(false);

  const maybeNotify = useCallback((momentum: MomentumRow[], unusual: UnusualRow[]) => {
    const fresh: string[] = [];
    const check = (id: string, label: string, sub: string) => {
      if (seen.current.has(id)) return;
      seen.current.add(id);
      if (primed.current && notifyRef.current) fresh.push(`${label}||${sub}`);
    };
    for (const r of momentum) {
      if (r.score >= STRONG_ONLY_MIN && r.contract) {
        check(
          momentumId(r),
          `${r.symbol} ${r.side?.toUpperCase()} signal`,
          `${r.contract.strike} ${r.side} · score ${Math.round(r.score)} · ${r.reason}`,
        );
      }
    }
    for (const r of unusual) {
      if (r.score >= STRONG_ONLY_MIN) {
        check(
          unusualId(r),
          `${r.symbol} unusual ${String(r.side).toUpperCase()}`,
          `${r.strike} · vol ${r.volume.toLocaleString()} · ${r.reason}`,
        );
      }
    }
    if (fresh.length) {
      beep();
      const first = fresh[0].split("||");
      const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : "";
      notify(first[0] + extra, first[1]);
    }
    primed.current = true;
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState((s) => ({ ...s, loading: true }));
    try {
      const [mRes, uRes] = await Promise.all([
        fetch("/api/scan/momentum", { cache: "no-store" }),
        fetch("/api/scan/unusual", { cache: "no-store" }),
      ]);
      const m = await mRes.json();
      const u = await uRes.json();
      const momentum: MomentumRow[] = m.signals ?? [];
      const unusual: UnusualRow[] = u.signals ?? [];
      const meta: ScanMeta = {
        generatedAt: m.generatedAt ?? new Date().toISOString(),
        provider: m.provider ?? "polygon",
        keyPresent: Boolean(m.keyPresent),
        note: m.note,
        universeCount: m.universeCount ?? 0,
        scannedCount: m.scannedCount ?? 0,
        scanned: m.scanned ?? [],
        errors: m.errors ?? [],
      };
      maybeNotify(momentum, unusual);
      setState({
        momentum,
        unusual,
        meta,
        loading: false,
        error: m.error ?? u.error ?? null,
        lastUpdated: Date.now(),
      });
    } catch (err: any) {
      setState((s) => ({ ...s, loading: false, error: err?.message ?? "Failed to load scan" }));
    } finally {
      inFlight.current = false;
    }
  }, [maybeNotify]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const ms = Math.max(5, intervalSec) * 1000;
    const id = setInterval(refresh, ms);
    return () => clearInterval(id);
  }, [autoRefresh, intervalSec, refresh]);

  return { ...state, refresh };
}

export async function requestNotifyPermission(): Promise<boolean> {
  try {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    const res = await Notification.requestPermission();
    return res === "granted";
  } catch {
    return false;
  }
}

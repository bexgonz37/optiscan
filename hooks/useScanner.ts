"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MomentumRow, UnusualRow, ScanMeta } from "@/lib/types";

export interface KpiSnapshot {
  signals: number;
  unusual: number;
  strong: number;
  avgScore: number;
  avgIv: number;
  scanned: number;
}

export interface ScannerState {
  momentum: MomentumRow[];
  unusual: UnusualRow[];
  meta: ScanMeta | null;
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
  kpi: KpiSnapshot;
  kpiHistory: KpiSnapshot[];
}

export interface StrongAlert {
  title: string;
  desc: string;
}

const STRONG_ONLY_MIN = 80;
const HISTORY = 16;

/** Optional API token (see SCAN_API_TOKEN): set once via
 * localStorage.setItem("optiscan:token", "..."). */
export function scanHeaders(): HeadersInit {
  try {
    const t = localStorage.getItem("optiscan:token");
    return t ? { "x-scan-token": t } : {};
  } catch {
    return {};
  }
}
const EMPTY_KPI: KpiSnapshot = { signals: 0, unusual: 0, strong: 0, avgScore: 0, avgIv: 0, scanned: 0 };

function momentumId(r: MomentumRow): string {
  return `M:${r.symbol}:${r.contract?.optionSymbol ?? `${r.side}:${r.contract?.strike}:${r.contract?.expiration}`}`;
}
function unusualId(r: UnusualRow): string {
  return `U:${r.symbol}:${r.optionSymbol ?? `${r.side}:${r.strike}:${r.expiration}`}`;
}

function ivPct(iv: number | null | undefined): number | null {
  if (iv == null) return null;
  return iv > 5 ? iv : iv * 100;
}

function computeKpi(momentum: MomentumRow[], unusual: UnusualRow[], meta: ScanMeta | null): KpiSnapshot {
  const scores = momentum.map((r) => r.score).filter((n) => Number.isFinite(n));
  const ivs = momentum.map((r) => ivPct(r.contract?.iv)).filter((n): n is number => n != null);
  const strong = momentum.filter((r) => r.score >= 80).length + unusual.filter((r) => r.score >= 80).length;
  return {
    signals: momentum.length,
    unusual: unusual.length,
    strong,
    avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    avgIv: ivs.length ? Math.round(ivs.reduce((a, b) => a + b, 0) / ivs.length) : 0,
    scanned: meta?.scannedCount ?? 0,
  };
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

function desktopNotify(title: string, body: string) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, tag: title });
    }
  } catch {
    /* ignore */
  }
}

export function useScanner(opts: {
  autoRefresh: boolean;
  intervalSec: number;
  notifyEnabled: boolean;
  onNewStrong?: (alerts: StrongAlert[]) => void;
}) {
  const { autoRefresh, intervalSec, notifyEnabled, onNewStrong } = opts;
  const [state, setState] = useState<ScannerState>({
    momentum: [],
    unusual: [],
    meta: null,
    loading: false,
    error: null,
    lastUpdated: null,
    kpi: EMPTY_KPI,
    kpiHistory: [],
  });

  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const notifyRef = useRef(notifyEnabled);
  notifyRef.current = notifyEnabled;
  const onStrongRef = useRef(onNewStrong);
  onStrongRef.current = onNewStrong;
  const inFlight = useRef(false);
  const intervalRef = useRef(intervalSec);
  intervalRef.current = intervalSec;

  const detectStrong = useCallback((momentum: MomentumRow[], unusual: UnusualRow[]) => {
    const fresh: StrongAlert[] = [];
    const check = (id: string, title: string, desc: string) => {
      if (seen.current.has(id)) return;
      seen.current.add(id);
      if (primed.current) fresh.push({ title, desc });
    };
    for (const r of momentum) {
      if (r.score >= STRONG_ONLY_MIN && r.contract) {
        check(
          momentumId(r),
          `${r.symbol} ${r.side?.toUpperCase()} · score ${Math.round(r.score)}`,
          `${r.contract.strike} ${r.side} · ${r.reason}`,
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
    if (fresh.length && primed.current) {
      if (notifyRef.current) {
        beep();
        desktopNotify(fresh[0].title + (fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ""), fresh[0].desc);
      }
      onStrongRef.current?.(fresh);
    }
    primed.current = true;
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState((s) => ({ ...s, loading: true }));
    // Ask the server for data at least as fresh as our poll rate, so every poll
    // returns a genuinely new scan (the small margin lets the two endpoints
    // share one underlying scan within the same tick).
    const maxAge = Math.max(400, intervalRef.current * 1000 - 300);
    try {
      const headers = scanHeaders();
      const [mRes, uRes] = await Promise.all([
        fetch(`/api/scan/momentum?maxAge=${maxAge}`, { cache: "no-store", headers }),
        fetch(`/api/scan/unusual?maxAge=${maxAge}`, { cache: "no-store", headers }),
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
      detectStrong(momentum, unusual);
      const kpi = computeKpi(momentum, unusual, meta);
      setState((s) => ({
        momentum,
        unusual,
        meta,
        loading: false,
        error: m.error ?? u.error ?? null,
        lastUpdated: Date.now(),
        kpi,
        kpiHistory: [...s.kpiHistory, kpi].slice(-HISTORY),
      }));
    } catch (err: any) {
      setState((s) => ({ ...s, loading: false, error: err?.message ?? "Failed to load scan" }));
    } finally {
      inFlight.current = false;
    }
  }, [detectStrong]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    // Floor of 5s: each scan is ~24+ provider calls, so sub-5s polling only
    // burns quota (and on the free tier fails outright with 429s).
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

"use client";

/**
 * useLanguageMode — client-side source of truth for private vs public wording
 * (audit P0-4/T5). Reads the server setting from /api/notifications/settings
 * (same endpoint the popup system already uses), caches it module-wide, and
 * re-checks every 2 minutes so a Settings toggle propagates without reload.
 * Default is "private" (single-user mode) until the server answers.
 */

import { useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";

export type LanguageMode = "private" | "public";

let cachedMode: LanguageMode = "private";
let lastFetchAt = 0;
let inFlight = false;
const listeners = new Set<(m: LanguageMode) => void>();

const CACHE_MS = 60_000;
const RECHECK_MS = 120_000;

async function refreshMode(force = false): Promise<void> {
  if (inFlight) return;
  if (!force && Date.now() - lastFetchAt < CACHE_MS) return;
  inFlight = true;
  try {
    const res = await fetch("/api/notifications/settings", { cache: "no-store", headers: scanHeaders() });
    const d = await res.json();
    lastFetchAt = Date.now();
    const mode: LanguageMode = d?.languageMode === "public" ? "public" : "private";
    if (mode !== cachedMode) {
      cachedMode = mode;
      for (const fn of listeners) fn(mode);
    }
  } catch {
    /* keep last known mode — private default is the safe-for-owner fallback */
  } finally {
    inFlight = false;
  }
}

/** Call after PATCHing the setting so open views update immediately. */
export function invalidateLanguageMode(): void {
  lastFetchAt = 0;
  void refreshMode(true);
}

export function useLanguageMode(): LanguageMode {
  const [mode, setMode] = useState<LanguageMode>(cachedMode);

  useEffect(() => {
    listeners.add(setMode);
    setMode(cachedMode);
    void refreshMode();
    const t = setInterval(() => void refreshMode(true), RECHECK_MS);
    return () => {
      listeners.delete(setMode);
      clearInterval(t);
    };
  }, []);

  return mode;
}

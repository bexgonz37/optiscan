"use client";

/**
 * usePresentationMode — global Simple/Advanced detail level for the shared
 * TradeExplanation. Persists in localStorage (dashboard-prefs) so it carries
 * across every desktop page, mirrors the useLanguageMode pattern, and is
 * broadcast to all mounted views so a toggle updates them instantly.
 *
 * This is PRESENTATION ONLY. It never changes trading logic, scoring, contract
 * selection, actionability, or safety gates — both modes render the exact same
 * underlying explanation object; the mode only picks which fields are shown.
 */

import { useEffect, useState } from "react";
import {
  DEFAULT_PRESENTATION_MODE,
  loadDashboardPrefs,
  saveDashboardPrefs,
  type PresentationMode,
} from "@/lib/dashboard-prefs";

let cachedMode: PresentationMode | null = null;
const listeners = new Set<(m: PresentationMode) => void>();

function readMode(): PresentationMode {
  if (cachedMode) return cachedMode;
  const stored = loadDashboardPrefs().presentation;
  cachedMode = stored === "advanced" ? "advanced" : DEFAULT_PRESENTATION_MODE;
  return cachedMode;
}

export function setPresentationMode(mode: PresentationMode): void {
  cachedMode = mode;
  saveDashboardPrefs({ presentation: mode });
  for (const fn of listeners) fn(mode);
}

export function usePresentationMode(): [PresentationMode, (m: PresentationMode) => void] {
  const [mode, setMode] = useState<PresentationMode>(DEFAULT_PRESENTATION_MODE);

  useEffect(() => {
    setMode(readMode());
    listeners.add(setMode);
    // Cross-tab sync via storage events.
    const onStorage = () => {
      cachedMode = null;
      setMode(readMode());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(setMode);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return [mode, setPresentationMode];
}

"use client";

/**
 * ComplianceFooter — standing education disclaimer, rendered app-wide whenever
 * the UI is in public / education language mode (audit P0-4/T5). Invisible in
 * private personal mode.
 */

import { useLanguageMode } from "@/hooks/useLanguageMode";
import { PUBLIC_MODE_DISCLAIMER } from "@/lib/language-modes";

export function ComplianceFooter() {
  const mode = useLanguageMode();
  if (mode !== "public") return null;
  return (
    <footer className="compliance-footer muted text-xs" role="contentinfo">
      {PUBLIC_MODE_DISCLAIMER}
    </footer>
  );
}

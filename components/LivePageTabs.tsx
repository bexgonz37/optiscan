"use client";

import { useCallback } from "react";
import { ScannerDashboard } from "@/components/ScannerDashboard";

/** Live page — fast movers tape only (no research tab). */
export function LivePageTabs({
  onOpenChart,
  onLoopStatus,
}: {
  onOpenChart?: (symbol: string) => void;
  onLoopStatus?: (running: boolean) => void;
}) {
  const handleLoopStatus = useCallback(
    (running: boolean) => {
      onLoopStatus?.(running);
    },
    [onLoopStatus],
  );

  return (
    <div className="live-page-tabs">
      <ScannerDashboard onOpenChart={onOpenChart} onLoopStatus={handleLoopStatus} />
    </div>
  );
}

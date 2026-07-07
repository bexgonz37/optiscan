"use client";

import { useCallback } from "react";
import { OptiscanLiveView } from "@/components/OptiscanLiveView";

/** Live page — chrome-noir terminal layout. */
export function LivePageTabs({
  onOpenChart,
  onLoopStatus,
}: {
  onOpenChart?: (symbol: string) => void;
  onLoopStatus?: (running: boolean) => void;
}) {
  const handleLoopStatus = useCallback(
    (running: boolean) => onLoopStatus?.(running),
    [onLoopStatus],
  );

  return (
    <div className="live-page-tabs chrome-app">
      <OptiscanLiveView onOpenChart={onOpenChart} onLoopStatus={handleLoopStatus} />
    </div>
  );
}

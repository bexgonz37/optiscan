"use client";

import { OptiscanLiveView } from "@/components/OptiscanLiveView";

/** Live page — Axiom terminal grid. */
export function LivePageTabs({
  onOpenChart,
  onLoopStatus,
}: {
  onOpenChart?: (symbol: string) => void;
  onLoopStatus?: (running: boolean) => void;
}) {
  return <OptiscanLiveView onOpenChart={onOpenChart} onLoopStatus={onLoopStatus} />;
}

"use client";

import { Suspense, useCallback, useState } from "react";
import { LivePageTabs } from "@/components/LivePageTabs";
import { openLiveChart } from "@/lib/open-chart";

/**
 * Live Scanner (Phase 6). The full live scanner tape that used to be the home
 * page. Home is now the calm Command Center ("/"); this preserves the complete
 * live-scanner experience unchanged, at its own route.
 */
function LiveScannerInner() {
  const [, setLoopLive] = useState(false);
  const onOpenChart = useCallback((symbol: string) => openLiveChart(symbol), []);
  return <LivePageTabs onOpenChart={onOpenChart} onLoopStatus={setLoopLive} />;
}

export default function ScannerPage() {
  return (
    <Suspense fallback={null}>
      <LiveScannerInner />
    </Suspense>
  );
}

"use client";

import { Suspense, useCallback, useState } from "react";
import { LivePageTabs } from "@/components/LivePageTabs";
import { openLiveChart } from "@/lib/open-chart";

function LivePageInner() {
  const [, setLoopLive] = useState(false);
  const onOpenChart = useCallback((symbol: string) => {
    openLiveChart(symbol);
  }, []);

  return <LivePageTabs onOpenChart={onOpenChart} onLoopStatus={setLoopLive} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LivePageInner />
    </Suspense>
  );
}

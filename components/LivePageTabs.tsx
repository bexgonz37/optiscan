"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ScannerDashboard } from "@/components/ScannerDashboard";
import { OptionsResearchPanel } from "@/components/OptionsResearchPanel";
import { KpiRow } from "@/components/KpiRow";
import { useScanner } from "@/hooks/useScanner";
import { DEFAULT_REFRESH_SEC, loadDashboardPrefs } from "@/lib/dashboard-prefs";

export type LiveTab = "tape" | "research";

export function LivePageTabs({
  onOpenChart,
  onLoopStatus,
}: {
  onOpenChart?: (symbol: string) => void;
  onLoopStatus?: (running: boolean) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramTab = searchParams.get("tab");
  const [tab, setTab] = useState<LiveTab>(paramTab === "research" ? "research" : "tape");
  const [prefs] = useState(() => loadDashboardPrefs());
  const intervalSec = Math.max(15, prefs.refreshSec ?? DEFAULT_REFRESH_SEC);
  const [loopLive, setLoopLive] = useState(false);

  const { kpi, meta, error } = useScanner({
    autoRefresh: tab === "research",
    intervalSec,
    notifyEnabled: false,
  });

  useEffect(() => {
    setTab(paramTab === "research" ? "research" : "tape");
  }, [paramTab]);

  const selectTab = useCallback(
    (next: LiveTab) => {
      setTab(next);
      const url = next === "research" ? "/?tab=research" : "/";
      router.replace(url, { scroll: false });
    },
    [router],
  );

  const handleLoopStatus = useCallback(
    (running: boolean) => {
      setLoopLive(running);
      onLoopStatus?.(running);
    },
    [onLoopStatus],
  );

  return (
    <div className="live-page-tabs">
      <div className="live-tab-bar">
        <button
          type="button"
          className={`pill btn live-tab-btn${tab === "tape" ? " btn-primary" : ""}`}
          onClick={() => selectTab("tape")}
        >
          Tape
        </button>
        <button
          type="button"
          className={`pill btn live-tab-btn${tab === "research" ? " btn-primary" : ""}`}
          onClick={() => selectTab("research")}
        >
          Options research
        </button>
      </div>

      {tab === "tape" ? (
        <ScannerDashboard onOpenChart={onOpenChart} onLoopStatus={handleLoopStatus} />
      ) : (
        <div className="live-research-pane">
          <KpiRow kpi={kpi} universeCount={meta?.universeCount ?? 0} loopLive={loopLive} />
          {error ? (
            <div className="banner-warn compact-banner-warn">{error}</div>
          ) : null}
          <OptionsResearchPanel onOpenChart={onOpenChart} variant="full" active={tab === "research"} />
        </div>
      )}
    </div>
  );
}

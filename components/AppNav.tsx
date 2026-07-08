"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { marketSession, type MarketSession } from "@/lib/trading-session";

const PAGE_TITLES: Record<string, { title: string; sub: string }> = {
  "/": { title: "Live Scanner", sub: "0DTE options · share momentum" },
  "/alerts": { title: "Alerts", sub: "Track record · performance" },
  "/settings": { title: "Settings", sub: "Thresholds · Discord · safety" },
  "/review": { title: "Review", sub: "System limits · methodology" },
  "/guide": { title: "Guide", sub: "Quick start" },
  "/scanner": { title: "Scanner", sub: "Legacy dashboard" },
};

export interface StatusItem { label: string; live?: boolean; warn?: boolean; }

export function AppNav({
  status,
  onRefresh,
  children,
  hideSessionBadge,
  clock,
}: {
  status?: StatusItem[];
  onRefresh?: () => void;
  children?: ReactNode;
  hideSessionBadge?: boolean;
  clock?: string;
}) {
  const pathname = usePathname() ?? "/";
  const [session, setSession] = useState<MarketSession | null>(null);
  useEffect(() => {
    const update = () => setSession(marketSession());
    update();
    const t = setInterval(update, 60_000);
    return () => clearInterval(t);
  }, []);

  const pageKey = pathname === "/" ? "/" : `/${pathname.split("/").filter(Boolean)[0]}`;
  const pageMeta = PAGE_TITLES[pageKey] ?? { title: "OptiScan", sub: "Live terminal" };

  return (
    <header className="chrome-header">
      <div className="axiom-page-title">
        {pageMeta.title}
        <span className="axiom-page-sub">{pageMeta.sub}</span>
      </div>

      <div className="chrome-header-end">
        {!hideSessionBadge && session ? (
          <span className="chrome-clock muted">
            <span className="dot" />{session}{clock ? ` · ${clock} ET` : ""}
          </span>
        ) : clock ? (
          <span className="chrome-clock"><span className="dot" />{clock} ET</span>
        ) : null}

        {status?.length ? (
          <span className="chrome-status muted">{status.map((s) => s.label).join(" · ")}</span>
        ) : null}

        {onRefresh ? (
          <button type="button" className="chrome-icon-btn" onClick={onRefresh} aria-label="Refresh">↻</button>
        ) : null}

        <ThemeToggle />
        {children}
      </div>
    </header>
  );
}

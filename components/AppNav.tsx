"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { marketSession, type MarketSession } from "@/lib/trading-session";

/** Two-mode nav: Options (RTH 0DTE system) vs Stocks (premarket/after-hours). */
const GROUPS = [
  {
    label: "Options",
    pages: [
      { href: "/", label: "Dashboard", hint: "Ranked market scanner watchlist" },
      { href: "/scanner", label: "Scanner", hint: "Options momentum + unusual flow" },
    ],
  },
  {
    label: "Stocks",
    pages: [
      { href: "/stocks", label: "Stock Scanner", hint: "Premarket / after-hours stock momentum (no options)" },
    ],
  },
  {
    label: null, // shared
    pages: [
      { href: "/alert-lab", label: "Alerts", hint: "All callouts + accuracy (options & stocks)" },
      { href: "/guide", label: "How to use", hint: "Full plain-English instructions" },
      { href: "/settings", label: "Settings", hint: "Notifications & preferences" },
    ],
  },
] as const;

const SESSION_BADGE: Record<MarketSession, { text: string; mode: "options" | "stocks" | "off" }> = {
  regular: { text: "OPTIONS · market open", mode: "options" },
  premarket: { text: "STOCKS · premarket", mode: "stocks" },
  afterhours: { text: "STOCKS · after hours", mode: "stocks" },
  closed: { text: "CLOSED", mode: "off" },
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface StatusItem {
  label: string;
  live?: boolean;
  warn?: boolean;
}

export function AppNav({
  status,
  onRefresh,
  children,
}: {
  status?: StatusItem[];
  onRefresh?: () => void;
  children?: ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  // Session badge is clock-driven (client), refreshed each minute — shows
  // instantly which mode is live: Options (RTH) or Stocks (extended hours).
  const [session, setSession] = useState<MarketSession | null>(null);
  useEffect(() => {
    const update = () => setSession(marketSession());
    update();
    const t = setInterval(update, 60_000);
    return () => clearInterval(t);
  }, []);
  const badge = session ? SESSION_BADGE[session] : null;

  return (
    <header className="app-nav">
      <div className="app-nav-bar">
        <Link href="/" className="logo app-nav-logo">
          <span className="mark">O</span>
          OptiScan
        </Link>

        <nav className="app-nav-links" aria-label="Main">
          {GROUPS.map((g, gi) => (
            <span key={g.label ?? "shared"} className="nav-group">
              {g.label ? <span className="nav-group-label">{g.label}</span> : null}
              {g.pages.map((p) => (
                <Link
                  key={p.href}
                  href={p.href}
                  className={`nav-tab${isActive(pathname, p.href) ? " active" : ""}`}
                  title={p.hint}
                >
                  {p.label}
                </Link>
              ))}
              {gi < GROUPS.length - 1 ? <span className="nav-group-divider" aria-hidden /> : null}
            </span>
          ))}
        </nav>

        <div className="spacer" />

        {badge ? (
          <span className={`session-badge session-${badge.mode}`} title="Which callout system is live right now">
            <span className={`status-dot${badge.mode !== "off" ? " live" : ""}`} />
            {badge.text}
          </span>
        ) : null}

        {status?.length ? (
          <div className="status-group">
            {status.map((s) => (
              <span key={s.label} className={`status-item${s.warn ? " warn" : ""}`}>
                {s.live != null ? <span className={`status-dot${s.live ? " live" : ""}`} /> : null}
                <span className="status-text">{s.label}</span>
              </span>
            ))}
          </div>
        ) : null}

        {onRefresh ? (
          <button type="button" className="icon-btn" onClick={onRefresh} title="Refresh scanner now" aria-label="Refresh">
            ↻
          </button>
        ) : null}

        <ThemeToggle />

        {children}
      </div>
    </header>
  );
}

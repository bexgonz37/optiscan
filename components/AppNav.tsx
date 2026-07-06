"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { marketSession, type MarketSession } from "@/lib/trading-session";

/** Minimal nav: Live · Alerts · Settings. Help lives in Settings. */
const PAGES = [
  { href: "/", label: "Live", hint: "What's moving right now — session-aware watchlist" },
  { href: "/alerts", label: "Alerts", hint: "Signals that fired + track record + journal" },
  { href: "/settings", label: "Settings", hint: "Notifications, preferences, and help" },
] as const;

const SESSION_BADGE: Record<MarketSession, { text: string; mode: "options" | "stocks" | "off" }> = {
  regular: { text: "Options mode · market open", mode: "options" },
  premarket: { text: "Shares mode · premarket", mode: "stocks" },
  afterhours: { text: "Shares mode · after hours", mode: "stocks" },
  closed: { text: "Market closed", mode: "off" },
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/alerts") return pathname === "/alerts" || pathname.startsWith("/alert-lab");
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
  hideSessionBadge,
}: {
  status?: StatusItem[];
  onRefresh?: () => void;
  children?: ReactNode;
  hideSessionBadge?: boolean;
}) {
  const pathname = usePathname() ?? "/";
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
          {PAGES.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              className={`nav-tab${isActive(pathname, p.href) ? " active" : ""}`}
              title={p.hint}
            >
              {p.label}
            </Link>
          ))}
        </nav>

        <div className="spacer" />

        {!hideSessionBadge && badge ? (
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

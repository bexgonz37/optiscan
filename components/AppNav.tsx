"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";

const PAGES = [
  { href: "/", label: "Dashboard", hint: "Ranked market scanner watchlist" },
  { href: "/scanner", label: "Scanner", hint: "Options momentum + unusual flow" },
  { href: "/alert-lab", label: "Alerts", hint: "Buy call/put callouts + accuracy" },
  { href: "/guide", label: "How to use", hint: "Full plain-English instructions" },
  { href: "/settings", label: "Settings", hint: "Notifications & preferences" },
] as const;

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

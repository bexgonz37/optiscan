"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { marketSession, type MarketSession } from "@/lib/trading-session";

const PAGES = [
  { href: "/", label: "Live" },
  { href: "/alerts", label: "Alerts" },
  { href: "/settings", label: "Settings" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/alerts") return pathname === "/alerts" || pathname.startsWith("/alert-lab");
  return pathname === href || pathname.startsWith(`${href}/`);
}

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

  return (
    <header className="chrome-header">
      <Link href="/" className="chrome-brand">OPTISCAN</Link>

      <div className="chrome-header-end">
        <nav className="chrome-nav" aria-label="Main">
          {PAGES.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              prefetch
              className={`chrome-link${isActive(pathname, p.href) ? " active" : ""}`}
            >
              {p.label}
            </Link>
          ))}
        </nav>

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

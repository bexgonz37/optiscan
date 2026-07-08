"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { marketSession, type MarketSession } from "@/lib/trading-session";
import { useEffect, useState } from "react";

const ITEMS = [
  { href: "/", label: "Live", icon: "◎" },
  { href: "/alerts", label: "Accuracy", icon: "⚡" },
  { href: "/settings", label: "Settings", icon: "⚙" },
] as const;

const SESSION_HINT: Record<MarketSession, string> = {
  regular: "0DTE live",
  premarket: "Callouts 9:30 ET",
  afterhours: "Callouts 9:30 ET",
  closed: "Closed",
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/alerts") return pathname === "/alerts" || pathname.startsWith("/alert-lab");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MobileBottomNav() {
  const pathname = usePathname() ?? "/";
  const [session, setSession] = useState<MarketSession | null>(null);

  useEffect(() => {
    const update = () => setSession(marketSession());
    update();
    const t = setInterval(update, 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <nav className="mobile-bottom-nav" aria-label="Main navigation">
      <div className="mobile-bottom-session">{session ? SESSION_HINT[session] : ""}</div>
      <div className="mobile-bottom-links">
        {ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            prefetch
            className={`mobile-bottom-link${isActive(pathname, item.href) ? " active" : ""}`}
          >
            <span className="mobile-bottom-icon" aria-hidden>{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}

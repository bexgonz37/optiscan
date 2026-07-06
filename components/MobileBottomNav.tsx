"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { marketSession, type MarketSession } from "@/lib/trading-session";
import { useEffect, useState } from "react";

const ITEMS = [
  { href: "/", label: "Live", icon: "◎" },
  { href: "/alerts", label: "Alerts", icon: "⚡" },
  { href: "/settings", label: "Settings", icon: "⚙" },
] as const;

const SESSION_HINT: Record<MarketSession, string> = {
  regular: "Options mode",
  premarket: "Shares mode",
  afterhours: "Shares mode",
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
            className={`mobile-bottom-link${isActive(pathname, item.href) ? " active" : ""}`}
          >
            <span className="mobile-bottom-icon" aria-hidden>{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
        <Link
          href="/guide"
          className={`mobile-bottom-link${pathname === "/guide" ? " active" : ""}`}
          title="How this works"
        >
          <span className="mobile-bottom-icon" aria-hidden>?</span>
          <span>Help</span>
        </Link>
      </div>
    </nav>
  );
}

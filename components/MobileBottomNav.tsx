"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { MoreDrawer } from "@/components/MoreDrawer";
import { resolveOperatingModeFromHealth } from "@/lib/dashboard/operating-mode";
import { getUiReviewSession, isUiReviewMode } from "@/lib/dashboard/ui-review";
import { scanHeaders } from "@/hooks/useScanner";

const ITEMS = [
  { href: "/", label: "NOW", icon: "◎" },
  { href: "/alerts", label: "Alerts", icon: "⚡" },
  { href: "/paper", label: "Paper", icon: "◈" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MobileBottomNav() {
  const pathname = usePathname() ?? "/";
  const [hint, setHint] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      if (isUiReviewMode()) {
        const mode = resolveOperatingModeFromHealth(null, {
          sessionOverride: getUiReviewSession(),
        });
        if (!cancelled) setHint(mode.label);
        return;
      }
      try {
        const res = await fetch("/api/health", { cache: "no-store", headers: scanHeaders() });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        const mode = resolveOperatingModeFromHealth(body, { fetchFailed: !res.ok && !body });
        setHint(mode.label);
      } catch {
        if (!cancelled) setHint("SYSTEM OFFLINE");
      }
    };
    void update();
    const t = setInterval(() => { void update(); }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <nav className="mobile-bottom-nav" aria-label="Main navigation">
      <div className="mobile-bottom-session">{hint}</div>
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
        <button
          type="button"
          className={`mobile-bottom-link${moreOpen ? " active" : ""}`}
          onClick={() => setMoreOpen(true)}
        >
          <span className="mobile-bottom-icon" aria-hidden>☰</span>
          <span>More</span>
        </button>
      </div>
      <MoreDrawer open={moreOpen} onClose={() => setMoreOpen(false)} />
    </nav>
  );
}

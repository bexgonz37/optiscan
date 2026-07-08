"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { marketSession, type MarketSession } from "@/lib/trading-session";

const NAV = [
  { href: "/", label: "Live", sub: "Scanner" },
  { href: "/alerts", label: "Alerts", sub: "Track record" },
  { href: "/settings", label: "Settings", sub: "Config" },
  { href: "/review", label: "Review", sub: "How it works" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/alerts") return pathname === "/alerts" || pathname.startsWith("/alert-lab");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AxiomShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [session, setSession] = useState<MarketSession | null>(null);
  const [clock, setClock] = useState("");
  const [liveOk, setLiveOk] = useState<boolean | null>(null);

  useEffect(() => {
    const tick = () => {
      setSession(marketSession());
      setClock(
        new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZone: "America/New_York",
        }),
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (!cancelled) setLiveOk(res.ok);
      } catch {
        if (!cancelled) setLiveOk(false);
      }
    };
    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="axiom-app">
      <aside className="axiom-rail" aria-label="Main navigation">
        <div className="axiom-rail-brand">
          <Link href="/" className="axiom-brand">
            OPTI<b>SCAN</b>
          </Link>
          <div className="axiom-brandsub">LIVE TERMINAL</div>
        </div>

        <nav className="axiom-railnav">
          <div className="axiom-railsec">WORKSPACE</div>
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch
              className={`axiom-navitem${isActive(pathname, item.href) ? " on" : ""}`}
            >
              <span className="axiom-ni" aria-hidden />
              <span>
                {item.label}
                <small>{item.sub}</small>
              </span>
            </Link>
          ))}
        </nav>

        <div className="axiom-railfoot">
          <div className="axiom-scanpill">
            <span className={`axiom-dot${liveOk === false ? " warn" : ""}`} />
            {liveOk === null ? "Checking…" : liveOk ? "Scanner online" : "Scanner check failed"}
          </div>
          <div className="axiom-railu">{session ?? "—"} · {clock} ET</div>
        </div>
      </aside>

      <div className="axiom-main">
        <div className="axiom-main-scroll">{children}</div>
      </div>
    </div>
  );
}

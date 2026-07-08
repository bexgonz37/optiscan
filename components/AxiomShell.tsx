"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { marketSession, type MarketSession } from "@/lib/trading-session";
import { NavRail } from "@/components/ui/NavRail";

const SCANNER_NAV = [{ href: "/", label: "Live / Options" }];

const INTEL_NAV = [
  { href: "/alerts", label: "Accuracy" },
  { href: "/alerts?tab=history", label: "Performance" },
  { href: "/settings", label: "Settings" },
  { href: "/review", label: "Review" },
];

const PAGE_META: Record<string, { title: string; sub: string }> = {
  "/": { title: "Live Scanner", sub: "0DTE · share momentum" },
  "/alerts": { title: "Accuracy", sub: "Track record · calibration" },
  "/settings": { title: "Settings", sub: "Thresholds · Discord" },
  "/review": { title: "Review", sub: "Methodology · limits" },
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href.startsWith("/alerts")) return pathname === "/alerts" || pathname.startsWith("/alert-lab");
  if (href.startsWith("/?")) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AxiomShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [session, setSession] = useState<MarketSession | null>(null);
  const [clock, setClock] = useState("");
  const [liveOk, setLiveOk] = useState<boolean | null>(null);

  const pageKey = pathname === "/" ? "/" : `/${pathname.split("/").filter(Boolean)[0]}`;
  const pageMeta = PAGE_META[pageKey] ?? { title: "OptiScan", sub: "Live terminal" };
  const isLive = pathname === "/";

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
    <div className="axiom-viewport">
      <div className="deck axiom-deck">
        <div className="appshell">
          <NavRail
            logo={
              <>
                OPTI<span>SCAN</span>
              </>
            }
            tagline="LIVE TERMINAL"
            sections={[
              { title: "SCANNERS", items: SCANNER_NAV },
              { title: "INTELLIGENCE", items: INTEL_NAV },
            ]}
            isActive={(href) => isActive(pathname, href)}
            footer={
              <>
                <div className="scanpill">
                  <span
                    className="dot"
                    style={liveOk === false ? { background: "#ff5162", boxShadow: "0 0 10px #ff5162" } : undefined}
                  />
                  {liveOk === null ? "Checking Polygon…" : liveOk ? "Polygon live" : "Health check failed"}
                </div>
                <div className="railu">{session ?? "—"} · {clock} ET</div>
              </>
            }
          />

          <div className="maincol">
            {!isLive ? (
              <div className="pgtop">
                <div className="pgtitle">{pageMeta.title}</div>
                <div className="pgsub">{pageMeta.sub}</div>
                <div className="clk" style={{ marginLeft: "auto" }}>{clock} ET</div>
              </div>
            ) : null}
            <div className="pagewrap">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

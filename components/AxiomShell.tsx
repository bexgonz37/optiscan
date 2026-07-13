"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { marketSession, type MarketSession } from "@/lib/trading-session";
import { NavRail, type NavItem } from "@/components/ui/NavRail";
import { apiGetJson } from "@/lib/client-auth";

// Owner Mode is the default experience: a short DAILY list of the pages that
// need owner attention, and one collapsed ADVANCED group for everything else.
const DAILY_NAV: NavItem[] = [
  { href: "/", label: "Command Center" },
  { href: "/callouts", label: "Callouts" },
  { href: "/paper", label: "Paper Trading" },
  { href: "/performance", label: "Performance" },
  { href: "/data", label: "System Health" },
  { href: "/guide", label: "Guide" },
];

// Base advanced tools. Improvement Agent is marked inactive (see below) when
// improvement automation is disabled on the server.
const ADVANCED_NAV: NavItem[] = [
  { href: "/watchlist", label: "Watchlist" },
  { href: "/quant", label: "Research & Backtesting" },
  { href: "/research-learning", label: "Research & Learning" },
  { href: "/improvement", label: "Improvement Agent" },
  { href: "/settings", label: "Settings" },
];

const PAGE_META: Record<string, { title: string; sub: string }> = {
  "/": { title: "Command Center", sub: "What matters right now" },
  "/data": { title: "System Health", sub: "Data freshness, Discord, and reliability" },
  "/copilot": { title: "Explain Signals", sub: "Coming soon" },
  "/callouts": { title: "Callouts", sub: "Every horizon in one place (0DTE–90DTE, momentum stocks, put research)" },
  "/alerts": { title: "Options Callouts", sub: "Moved into Callouts · accuracy & journal still here" },
  "/watchlist": { title: "Watchlist", sub: "Symbols the scanner is monitoring" },
  "/paper": { title: "Paper Trading", sub: "Autonomous simulated trades, no real money" },
  "/performance": { title: "Performance", sub: "Alert track record and paper account" },
  "/quant": { title: "Research & Backtesting", sub: "Setup stats and backtests" },
  "/research-learning": { title: "Research & Learning", sub: "Model readiness, drift, and bounded continuous learning" },
  "/improvement": { title: "Improvement Agent", sub: "Controlled, propose-only code-improvement agent (never edits code autonomously)" },
  "/swing": { title: "Swing Research", sub: "Moved into Callouts → Swing Research tab" },
  "/settings": { title: "Settings", sub: "Alerts, Discord, safety" },
  "/review": { title: "Review", sub: "Methodology and limits" },
  "/guide": { title: "Guide", sub: "How to use OptiScan" },
  "/scanner": { title: "Live Scanner", sub: "0DTE options · share momentum tape" },
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  // The consolidated Callouts destination lights up for the old callout URLs too.
  if (href === "/callouts") {
    return pathname === "/callouts" || pathname === "/alerts"
      || pathname === "/swing" || pathname.startsWith("/alert-lab");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AxiomShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [session, setSession] = useState<MarketSession | null>(null);
  const [clock, setClock] = useState("");
  const [liveOk, setLiveOk] = useState<boolean | null>(null);
  const [liveLabel, setLiveLabel] = useState("Checking data...");
  const [improvementActive, setImprovementActive] = useState<boolean | null>(null);

  const pageKey = pathname === "/" ? "/" : `/${pathname.split("/").filter(Boolean)[0]}`;
  const pageMeta = PAGE_META[pageKey] ?? { title: "OptiScan", sub: "Live terminal" };

  // Mark the Improvement Agent inactive in the sidebar when automation is off
  // (proposal-only is off by default). Best-effort read; degrades to no label.
  useEffect(() => {
    let cancelled = false;
    void apiGetJson<{ improvement?: { auditEnabled?: boolean } }>("/api/runtime/status").then((r) => {
      if (cancelled || !r) return;
      setImprovementActive(Boolean(r.improvement?.auditEnabled));
    });
    return () => { cancelled = true; };
  }, []);

  const advancedNav: NavItem[] = ADVANCED_NAV.map((item) =>
    item.href === "/improvement" && improvementActive === false
      ? { ...item, note: "inactive" }
      : item,
  );
  // Full-bleed live chrome is for the live scanner (now /scanner). The Command
  // Center at "/" is a normal, calm page and uses the standard header.
  const isLive = pathname === "/scanner";

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
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        const loopUp = Boolean(body?.ok ?? body?.loopRunning);
        const serverMs = Number(body?.serverTimeMs ?? Date.parse(body?.time ?? ""));
        const skewMs = Number.isFinite(serverMs) ? Date.now() - serverMs : 0;
        const tickAge = Number(body?.lastTickAgeMs);
        setLiveOk(loopUp);
        if (Math.abs(skewMs) > 120_000) {
          setLiveLabel("Clock issue - times unreliable");
        } else if (loopUp && tickAge != null && tickAge > 12_000 && body?.session !== "closed") {
          setLiveLabel("Data delayed - wait");
        } else if (loopUp) {
          setLiveLabel("Live data OK");
        } else if (body?.loopRunning === false && String(body?.note ?? "").includes("advisory lock")) {
          setLiveLabel("Scanner starting");
        } else if (body?.session === "closed") {
          setLiveLabel("Market closed - data OK");
          setLiveOk(true);
        } else if (body?.keyPresent === false) {
          setLiveLabel("Missing data key");
        } else {
          setLiveLabel("Scanner starting");
        }
      } catch {
        if (!cancelled) {
          setLiveOk(false);
          setLiveLabel("Server offline");
        }
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
            tagline="OPTIONS SCANNER"
            sections={[
              { title: "DAILY", items: DAILY_NAV },
              {
                title: "ADVANCED TOOLS",
                items: advancedNav,
                collapsible: true,
                collapsedByDefault: true,
                storageKey: "optiscan:nav:advanced",
              },
            ]}
            isActive={(href) => isActive(pathname, href)}
            footer={
              <>
                <div className="scanpill">
                  <span
                    className="dot"
                    style={liveOk === false ? { background: "#ff5162", boxShadow: "0 0 10px #ff5162" } : undefined}
                  />
                  {liveLabel}
                </div>
                <div className="railu">{session ?? "-"} · {clock} ET</div>
              </>
            }
          />

          <div className={`maincol${isLive ? " maincol-live" : ""}`}>
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

"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { marketSession, type MarketSession } from "@/lib/trading-session";
import { NavRail, type NavItem } from "@/components/ui/NavRail";
import { HeaderUnlock } from "@/components/HeaderUnlock";
import { MoreDrawer } from "@/components/MoreDrawer";
import { apiGetJson } from "@/lib/client-auth";
import { resolveOperatingModeFromHealth } from "@/lib/dashboard/operating-mode";
import { getUiReviewSession, isUiReviewMode } from "@/lib/dashboard/ui-review";

// Primary product navigation — decision-first.
const PRODUCT_NAV: NavItem[] = [
  { href: "/", label: "NOW" },
  { href: "/alerts", label: "ALERTS" },
  { href: "/paper", label: "PAPER" },
];

// Owner tools remain reachable but not in primary nav.
const ADVANCED_NAV: NavItem[] = [
  { href: "/research", label: "Research Hub" },
  { href: "/callouts", label: "Live Options" },
  { href: "/quant", label: "Quant Lab" },
  { href: "/scanner", label: "Scanner" },
  { href: "/intelligence", label: "Strategy Lab" },
  { href: "/ai", label: "AI Advisory" },
  { href: "/paper/0dte", label: "0DTE Research" },
  { href: "/content-drafts", label: "Content Drafts" },
  { href: "/pipeline-health", label: "Pipeline Diagnostics" },
  { href: "/pipeline-health/research-platform", label: "Research Platform Ops" },
  { href: "/shadow-soak", label: "Shadow Soak" },
  { href: "/data", label: "System Health" },
  { href: "/paper-lifecycle", label: "Paper Lifecycle" },
  { href: "/performance", label: "Performance" },
  { href: "/research-learning", label: "Research & Learning" },
  { href: "/subscriptions", label: "Subscriptions" },
  { href: "/social-drafts", label: "Social Drafts" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/brokerage-parity", label: "Brokerage Parity" },
  { href: "/brokerage-v2", label: "Brokerage V2" },
  { href: "/brokerage-readiness", label: "Brokerage Readiness" },
  { href: "/improvement", label: "Improvement Agent" },
  { href: "/guide", label: "Guide" },
  { href: "/settings", label: "Settings" },
];

const PAGE_META: Record<string, { title: string; sub: string }> = {
  "/": { title: "NOW", sub: "What is actionable — and what to watch next" },
  "/research": { title: "Research", sub: "Quant · Scanner · Strategy · AI (owner)" },
  "/data": { title: "System Health", sub: "Data freshness, Discord, and reliability" },
  "/subscriptions": { title: "Subscriptions", sub: "Stripe ↔ Discord role sync health" },
  "/social-drafts": { title: "Social Drafts", sub: "Verified milestone copy — approve before posting" },
  "/content-drafts": { title: "Content Drafts", sub: "Owner-only drafts — never auto-posted" },
  "/copilot": { title: "Explain Signals", sub: "Coming soon" },
  "/callouts": { title: "Live Options", sub: "Active alerts, contracts, and open risk" },
  "/alerts": { title: "ALERTS", sub: "Discord SENT history and track record" },
  "/watchlist": { title: "Watchlist", sub: "Symbols the scanner is monitoring" },
  "/paper": { title: "Paper Trading", sub: "Delivered mirrors first — $ P&L proof" },
  "/paper-lifecycle": {
    title: "Paper Lifecycle",
    sub: "Candidate → Entry → Exit → Graded → Broker V2 — blockers visible",
  },
  "/performance": { title: "Performance", sub: "Alert track record and paper account" },
  "/ai": { title: "AI Advisory", sub: "Interprets Quant Lab — never controls live alerts" },
  "/quant": { title: "Quant Lab", sub: "Lane-separated edge, MFE/MAE, and breakdowns" },
  "/research-learning": { title: "Research & Learning", sub: "Model readiness, drift, and bounded continuous learning" },
  "/brokerage-parity": { title: "Brokerage Parity", sub: "Legacy vs V2 dual-write agreement · developer/research only" },
  "/brokerage-v2": { title: "Brokerage V2", sub: "Research / Brokerage V2 — Not Yet Authoritative" },
  "/brokerage-readiness": { title: "Brokerage Readiness", sub: "Operational Validation (Soak) — No Production Cutover" },
  "/improvement": { title: "Improvement Agent", sub: "Controlled, propose-only code-improvement agent (never edits code autonomously)" },
  "/swing": { title: "Swing Research", sub: "Moved into Live Options" },
  "/settings": { title: "Settings", sub: "Token, Discord, and safety" },
  "/review": { title: "Review", sub: "Methodology and limits" },
  "/guide": { title: "Guide", sub: "How to use OptiScan" },
  "/shadow-soak": { title: "Shadow Soak", sub: "Would-send vs would-block — no Discord openings" },
  "/pipeline-health": { title: "Advanced Diagnostics", sub: "Funnel, blockers, and paid-beta readiness" },
  "/scanner": { title: "Scanner", sub: "0DTE tape · SPY/QQQ priority" },
  "/intelligence": { title: "Strategy Lab", sub: "Opportunity cases and strategy dossiers" },
  "/paper/0dte": { title: "Aggressive 0DTE Research", sub: "Simulated $100k ledger — never Discord" },
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/alerts") {
    return pathname === "/alerts" || pathname.startsWith("/alerts/");
  }
  if (href === "/callouts") {
    return pathname === "/callouts" || pathname === "/swing" || pathname.startsWith("/alert-lab");
  }
  if (href === "/paper/0dte") {
    return pathname === "/paper/0dte" || pathname.startsWith("/paper/0dte/");
  }
  if (href === "/paper") {
    return pathname === "/paper" || (pathname.startsWith("/paper/") && !pathname.startsWith("/paper/0dte"));
  }
  const pathOnly = href.split("#")[0];
  return pathname === pathOnly || pathname.startsWith(`${pathOnly}/`);
}

export function AxiomShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [session, setSession] = useState<MarketSession | null>(null);
  const [clock, setClock] = useState("");
  const [liveOk, setLiveOk] = useState<boolean | null>(null);
  const [liveLabel, setLiveLabel] = useState("Checking data...");
  const [improvementActive, setImprovementActive] = useState<boolean | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const segments = pathname.split("/").filter(Boolean);
  const pageKey =
    pathname === "/"
      ? "/"
      : segments[0] === "paper" && segments[1] === "0dte"
        ? "/paper/0dte"
        : `/${segments[0]}`;
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
        const mode = resolveOperatingModeFromHealth(body, {
          sessionOverride: isUiReviewMode() ? getUiReviewSession() : null,
          fetchFailed: !res.ok && !body,
        });
        setLiveOk(mode.mode !== "SYSTEM_OFFLINE" && mode.mode !== "MARKET_DATA_UNAVAILABLE");
        setLiveLabel(mode.label);
      } catch {
        if (!cancelled) {
          const mode = resolveOperatingModeFromHealth(null, { fetchFailed: true });
          setLiveOk(false);
          setLiveLabel(mode.label);
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

  const productWithMore: NavItem[] = [
    ...PRODUCT_NAV,
    { href: "#more", label: "MORE" },
  ];

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
              {
                title: "PRODUCT",
                items: productWithMore,
              },
              {
                title: "OWNER TOOLS",
                items: advancedNav,
                collapsible: true,
                collapsedByDefault: true,
                storageKey: "optiscan:nav:advanced",
              },
            ]}
            isActive={(href) => (href === "#more" ? moreOpen : isActive(pathname, href))}
            onItemClick={(href) => {
              if (href === "#more") {
                setMoreOpen(true);
                return true;
              }
              return false;
            }}
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
                <div className="pgtop-actions">
                  <button type="button" className="header-unlock-btn" onClick={() => setMoreOpen(true)}>
                    MORE
                  </button>
                  <HeaderUnlock />
                  <div className="clk">{clock} ET</div>
                </div>
              </div>
            ) : (
              <div className="pgtop pgtop-live">
                <div className="pgtop-actions" style={{ marginLeft: "auto" }}>
                  <HeaderUnlock />
                  <div className="clk">{clock} ET</div>
                </div>
              </div>
            )}
            <div className="pagewrap">{children}</div>
          </div>
        </div>
      </div>
      <MoreDrawer open={moreOpen} onClose={() => setMoreOpen(false)} />
    </div>
  );
}

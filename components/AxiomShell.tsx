"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { marketSession, type MarketSession } from "@/lib/trading-session";
import { NavRail } from "@/components/ui/NavRail";

const SCANNER_NAV = [
  { href: "/", label: "Live / Options" },
  { href: "/data", label: "Data Core" },
];

const INTEL_NAV = [
  { href: "/copilot", label: "AI" },
  { href: "/paper", label: "Paper Trading" },
  { href: "/swing", label: "Swing (preview)" },
  { href: "/alerts", label: "Accuracy" },
  { href: "/settings", label: "Settings" },
];

const PAGE_META: Record<string, { title: string; sub: string }> = {
  "/": { title: "Live Scanner", sub: "0DTE · share momentum" },
  "/data": { title: "Data Core", sub: "Massive feed health · live tick stream" },
  "/copilot": { title: "AI", sub: "Coming soon" },
  "/alerts": { title: "Accuracy", sub: "Live callouts · track record · journal" },
  "/settings": { title: "Settings", sub: "Thresholds · Discord" },
  "/review": { title: "Review", sub: "Methodology · limits" },
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/data") return pathname === "/data";
  if (href === "/copilot") return pathname === "/copilot";
  if (href === "/settings") return pathname === "/settings";
  if (href === "/review") return pathname === "/review";
  if (href === "/alerts") return pathname === "/alerts" || pathname.startsWith("/alert-lab");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AxiomShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [session, setSession] = useState<MarketSession | null>(null);
  const [clock, setClock] = useState("");
  const [liveOk, setLiveOk] = useState<boolean | null>(null);
  const [liveLabel, setLiveLabel] = useState("Checking Massive…");

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
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        const loopUp = Boolean(body?.ok ?? body?.loopRunning);
        const serverMs = Number(body?.serverTimeMs ?? Date.parse(body?.time ?? ""));
        const skewMs = Number.isFinite(serverMs) ? Date.now() - serverMs : 0;
        const tickAge = Number(body?.lastTickAgeMs);
        setLiveOk(loopUp);
        if (Math.abs(skewMs) > 120_000) {
          setLiveLabel(`Clock skew ${Math.round(Math.abs(skewMs) / 1000)}s — times unreliable`);
        } else if (loopUp && tickAge != null && tickAge > 12_000 && body?.session !== "closed") {
          setLiveLabel(`Tape ${Math.round(tickAge / 1000)}s stale — wait before trading`);
        } else if (loopUp) {
          setLiveLabel("Massive live");
        } else if (body?.loopRunning === false && String(body?.note ?? "").includes("advisory lock")) {
          setLiveLabel("Scanner lock — restart dev or wait ~2 min");
        } else if (body?.session === "closed") {
          setLiveLabel("Market closed · Massive OK");
          setLiveOk(true);
        } else if (body?.keyPresent === false) {
          setLiveLabel("No Massive key in .env.local");
        } else {
          setLiveLabel("Scanner loop offline");
        }
      } catch {
        if (!cancelled) {
          setLiveOk(false);
          setLiveLabel("Cannot reach server");
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
                  {liveLabel}
                </div>
                <div className="railu">{session ?? "—"} · {clock} ET</div>
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar, VIEWS } from "@/components/Sidebar";
import type { Tab, FilterKey, View } from "@/components/Sidebar";
import { KpiRow } from "@/components/KpiRow";
import { Toolbar } from "@/components/Toolbar";
import { MomentumTable } from "@/components/MomentumTable";
import { UnusualTable } from "@/components/UnusualTable";
import { DetailPanel } from "@/components/DetailPanel";
import { useScanner, requestNotifyPermission } from "@/hooks/useScanner";
import { useToast } from "@/components/Toasts";
import type { MomentumRow, UnusualRow } from "@/lib/types";
import { fmtTime } from "@/lib/format";

const INTERVALS = [15, 30, 60, 120];

function ivPct(iv: number | null | undefined): number {
  if (iv == null) return 0;
  return iv > 5 ? iv : iv * 100;
}

export default function Page() {
  const { push } = useToast();

  const [activeView, setActiveView] = useState("momentum");
  const [tab, setTab] = useState<Tab>("momentum");
  const [filters, setFilters] = useState<FilterKey[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [intervalSec, setIntervalSec] = useState(30);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [clock, setClock] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("optiscan:prefs");
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.autoRefresh === "boolean") setAutoRefresh(p.autoRefresh);
        if (typeof p.intervalSec === "number") setIntervalSec(p.intervalSec);
        if (typeof p.activeView === "string") {
          const v = VIEWS.find((x) => x.id === p.activeView);
          if (v) {
            setActiveView(v.id);
            setTab(v.tab);
            setFilters(v.filters);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("optiscan:prefs", JSON.stringify({ autoRefresh, intervalSec, activeView }));
    } catch {
      /* ignore */
    }
  }, [autoRefresh, intervalSec, activeView]);

  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "America/New_York" }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const onNewStrong = useCallback(
    (alerts: { title: string; desc: string }[]) => {
      alerts.slice(0, 3).forEach((a) => push(a.title, a.desc, "ok"));
      if (alerts.length > 3) push("More signals", `${alerts.length - 3} additional STRONG signals fired.`, "info");
    },
    [push],
  );

  const { momentum, unusual, meta, loading, error, lastUpdated, kpi, kpiHistory, refresh } = useScanner({
    autoRefresh,
    intervalSec,
    notifyEnabled,
    onNewStrong,
  });

  const errorShownRef = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== errorShownRef.current) {
      errorShownRef.current = error;
      push("Scan error", error, "err");
    }
  }, [error, push]);

  function selectView(v: View) {
    setActiveView(v.id);
    setTab(v.tab);
    setFilters(v.filters);
  }

  function toggleFilter(key: FilterKey) {
    setActiveView("custom");
    setFilters((f) => (f.includes(key) ? f.filter((x) => x !== key) : [...f, key]));
  }

  function clearFilters() {
    setFilters([]);
    setActiveView(tab);
  }

  const filteredMomentum: MomentumRow[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    return momentum.filter((r) => {
      if (q && !(r.symbol ?? "").toLowerCase().includes(q)) return false;
      if (filters.includes("strong") && r.score < 80) return false;
      if (filters.includes("call") && r.side !== "call") return false;
      if (filters.includes("put") && r.side !== "put") return false;
      if (filters.includes("highiv") && ivPct(r.contract?.iv) <= 55) return false;
      return true;
    });
  }, [momentum, filters, query]);

  const filteredUnusual: UnusualRow[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    return unusual.filter((r) => {
      if (q && !(r.symbol ?? "").toLowerCase().includes(q)) return false;
      if (filters.includes("strong") && r.score < 80) return false;
      if (filters.includes("new") && !r.newPositioning) return false;
      if (filters.includes("highiv") && ivPct(r.iv) <= 55) return false;
      return true;
    });
  }, [unusual, filters, query]);

  const onSelect = useCallback((symbol: string) => {
    setSelected(symbol);
    setDetailOpen(true);
  }, []);

  // Keyboard: Cmd/Ctrl+K focus search, Esc closes, arrows navigate rows.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === "Escape") {
        if (detailOpen) setDetailOpen(false);
        else if (document.activeElement === searchRef.current) {
          setQuery("");
          searchRef.current?.blur();
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (document.activeElement === searchRef.current) return;
        const rows = Array.from(document.querySelectorAll("tbody tr[data-sym]")) as HTMLElement[];
        if (!rows.length) return;
        const idx = rows.findIndex((r) => r.dataset.sym === selected);
        const next = e.key === "ArrowDown" ? Math.min(idx + 1, rows.length - 1) : Math.max(idx - 1, 0);
        const sym = rows[next]?.dataset.sym;
        if (sym) {
          onSelect(sym);
          rows[next].scrollIntoView({ block: "nearest" });
          e.preventDefault();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailOpen, selected, onSelect]);

  async function toggleNotify() {
    if (!notifyEnabled) {
      const ok = await requestNotifyPermission();
      setNotifyEnabled(ok);
      push(ok ? "Alerts enabled" : "Alerts blocked", ok ? "You'll get a desktop ping + sound on STRONG signals." : "Allow notifications in your browser to enable alerts.", ok ? "ok" : "err");
    } else {
      setNotifyEnabled(false);
      push("Alerts off", "Desktop alerts disabled.", "info");
    }
  }

  const keyPresent = meta?.keyPresent ?? false;
  const title = VIEWS.find((v) => v.id === activeView)?.label ?? (tab === "momentum" ? "Momentum" : "Unusual Flow");
  const rowCount = tab === "momentum" ? filteredMomentum.length : filteredUnusual.length;

  return (
    <div className="app">
      <div className="topbar">
        <div className="logo">
          <span className="mark">O</span>
          OptiScan
          <small>options intelligence</small>
        </div>

        <div className="search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8798a8" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4-4" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ticker  (⌘K)"
          />
        </div>

        <div className="pill">
          <span className={`dot ${loading ? "" : "off"}`} /> {loading ? "Scanning" : `Updated ${fmtTime(lastUpdated ? new Date(lastUpdated).toISOString() : null)}`}
        </div>
        <div className="pill">
          <span className="num" style={{ color: "var(--txt)" }}>{clock || "--:--:--"} ET</span>
        </div>

        <div className="spacer" />

        <div className="pill btn" onClick={refresh}>Refresh</div>
        <div className={`pill btn ${autoRefresh ? "on" : ""}`} onClick={() => setAutoRefresh((v) => !v)}>
          {autoRefresh ? "Live" : "Paused"}
        </div>
        <select
          className="pill"
          style={{ cursor: "pointer" }}
          value={intervalSec}
          onChange={(e) => setIntervalSec(Number(e.target.value))}
        >
          {INTERVALS.map((s) => (
            <option key={s} value={s} style={{ background: "#131b24" }}>
              {s}s
            </option>
          ))}
        </select>
        <div className={`pill btn ${notifyEnabled ? "on" : ""}`} onClick={toggleNotify}>
          {notifyEnabled ? "Alerts on" : "Alerts off"}
        </div>
      </div>

      {!keyPresent && meta && (
        <div className="kpi" style={{ marginBottom: 16, borderColor: "var(--amber)", background: "rgba(255,176,32,.06)" }}>
          <div className="label" style={{ color: "var(--amber)" }}>Add your Polygon/Massive API key</div>
          <div className="sub">
            Set <code>POLYGON_API_KEY</code> in <code>.env.local</code> and restart. Until then the scanners have no live data.
          </div>
        </div>
      )}

      <KpiRow kpi={kpi} history={kpiHistory} universeCount={meta?.universeCount ?? 0} />

      <div className="layout">
        <Sidebar
          activeView={activeView}
          onSelect={selectView}
          counts={{ momentum: momentum.length, unusual: unusual.length, strong: kpi.strong }}
        />

        <div className="panel main">
          <Toolbar
            title={title}
            tab={tab}
            activeFilters={filters}
            onToggle={toggleFilter}
            onClear={clearFilters}
            loading={loading}
            count={rowCount}
          />
          {tab === "momentum" ? (
            <MomentumTable rows={filteredMomentum} selected={selected} onSelect={onSelect} />
          ) : (
            <UnusualTable rows={filteredUnusual} selected={selected} onSelect={onSelect} />
          )}
        </div>

        <DetailPanel symbol={selected} open={detailOpen} onClose={() => setDetailOpen(false)} />
      </div>

      <div className="footer">
        OptiScan · signals only, no order placement · data: {meta?.provider ?? "polygon"} (delayed on free tiers) · not financial advice
      </div>
    </div>
  );
}

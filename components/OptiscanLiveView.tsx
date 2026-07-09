"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ConvictionRing } from "@/components/ui/ConvictionRing";
import { Panel } from "@/components/ui/Panel";
import { SignalCard } from "@/components/ui/SignalCard";
import { StatTile } from "@/components/ui/StatTile";
import { TrackingRow } from "@/components/ui/TrackingRow";
import dynamic from "next/dynamic";
const ScannerBuilder = dynamic(
  () => import("@/components/ui/ScannerBuilder").then((mm) => ({ default: mm.ScannerBuilder })),
  { ssr: false, loading: () => <div className="muted text-sm">Loading scanner builder…</div> },
);
import { applyStockScan, type StockScanPreset } from "@/lib/stock-scanner-presets";
import { useScannerStream } from "@/hooks/useScannerStream";
import { scanHeaders } from "@/hooks/useScanner";
import { useStableSymbolOrder } from "@/lib/stable-order";
import { applyFastFilterHysteresis } from "@/lib/tape-filter-hysteresis";
import { tickDirection } from "@/lib/tick-flash";
import { sortTape, type TapeRow, type WatchSortKey } from "@/lib/watch-score";
import { frozenCalloutVerdict, MIN_SPEED_PCT_PER_MIN } from "@/lib/trade-verdict";
import { fmtPct, pctClass, fmtMarketFreshness, fmtMarketTime, isAlertFresh, HERO_CALLOUT_FRESH_MS, HERO_CALLOUT_FRESH_MARKET_MS } from "@/lib/format";
import { tradingDay } from "@/lib/trading-session";
import { liveCtxFor, useLiveTapeMap } from "@/hooks/useLiveTapeMap";
import { loadDashboardPrefs, saveDashboardPrefs } from "@/lib/dashboard-prefs";
import { uiDirectiveLabel } from "@/lib/language-modes";
import { InfoTip } from "@/components/InfoTip";
import { CardTip } from "@/components/CardTip";
import { stickyMembership, makeStickyState } from "@/lib/sticky-list";

/** Beginner tooltips: strip-stat label -> glossary key (lib/metric-glossary). */
const STRIP_METRIC: Record<string, string> = {
  "Avg speed": "speed",
  "Put / call flow": "confidence",
  "Hot names": "relVol",
};

/** Scanner column title -> glossary key. */
const COLUMN_METRIC: Record<string, string> = {
  "Volume-confirmed": "surge",
  "Volume surges": "surge",
  "Level breaks": "hodLod",
  "Best entries forming": "setupScore",
};
import { useLanguageMode } from "@/hooks/useLanguageMode";
import { formatOptionsContract, formatCalloutHeadline, isFillableOptionsSetup } from "@/lib/format-contract";
import { rankAlertForHero, isMetaShapedAlert, META_REFERENCE } from "@/lib/meta-bar";
import { MetaBarPanel } from "@/components/MetaBarPanel";
import { filterCoreAndWinners, sortCoreFirstThenSpeed } from "@/lib/core-vs-winner";
import { CORE_WATCH } from "@/lib/universe";
import { isDiscordRelevantAlert, HERO_STICKY_MS } from "@/lib/discord-desk";

const CORE_SET = new Set(CORE_WATCH);

function tapeSpeed(r: { instantRate?: number | null; shortRate?: number | null } | null | undefined): number {
  return Math.abs(r?.instantRate ?? r?.shortRate ?? 0);
}

const HOT_LINGER_MS = 90_000;
const STABLE_ORDER_MS = 120_000;
const TICK_FLASH_MS = 900;

type ScannerColumn = { title: string; rows: TapeRow[] };
type StripItem = { k: string; v: string | number; s: string };
type LiveSortKey = Extract<WatchSortKey, "speed" | "surge" | "move" | "level" | "symbol">;

const SORTS: { key: LiveSortKey; label: string }[] = [
  { key: "speed", label: "Speed" },
  { key: "surge", label: "Volume surge" },
  { key: "move", label: "% move" },
  { key: "level", label: "Level break" },
  { key: "symbol", label: "Symbol" },
];

function TickValue({
  value,
  children,
  className = "",
  minDelta = 0.05,
}: {
  value: number | null | undefined;
  children: React.ReactNode;
  className?: string;
  minDelta?: number;
}) {
  const prev = useRef(value);
  const [flash, setFlash] = useState("");
  useEffect(() => {
    const dir = tickDirection(value, prev.current, minDelta);
    prev.current = value;
    if (!dir) return;
    setFlash(dir === "up" ? "live up" : "live dn");
    const t = setTimeout(() => setFlash(""), TICK_FLASH_MS);
    return () => clearTimeout(t);
  }, [value, minDelta]);
  return <span className={`num ${flash} ${className}`.trim()}>{children}</span>;
}

function speedLabel(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${rate > 0 ? "+" : ""}${rate.toFixed(2)}%/m`;
}


const CORE_TICKERS = new Set(CORE_WATCH);

function prefersCore(a: { ticker?: string | null }, b: { ticker?: string | null }): number {
  const ac = CORE_TICKERS.has(String(a.ticker ?? "").toUpperCase()) ? 1 : 0;
  const bc = CORE_TICKERS.has(String(b.ticker ?? "").toUpperCase()) ? 1 : 0;
  if (ac !== bc) return bc - ac;
  return 0;
}

type Scope = "market" | "options";

function whyLine(r: TapeRow, scope: Scope): string {
  if ((r as any).recap) {
    const vol = r.volume != null ? `${Math.round(r.volume / 1000)}k vol` : "—";
    return `<b>${fmtPct(r.movePct)}</b> · ${vol} · snapshot`;
  }
  const speed = r.shortRate != null ? `<b>${r.shortRate > 0 ? "+" : ""}${r.shortRate.toFixed(2)}%/min</b>` : "—";
  if (scope === "options") {
    if (r.hodBreak) return `$${r.symbol} · broke <b>HOD</b> · ${speed}`;
    if (r.lodBreak) return `$${r.symbol} · broke <b>LOD</b> · ${speed}`;
    return `${speed} · surge ${r.surge != null ? `${r.surge.toFixed(1)}×` : "—"}`;
  }
  if (r.hodBreak) return `broke <b>high of day</b> · ${speed}`;
  if (r.lodBreak) return `broke <b>low of day</b> · ${speed}`;
  return `${speed} · vol ${r.surge != null ? `${r.surge.toFixed(1)}×` : "—"}`;
}

function buildColumns(displayRows: TapeRow[], sortLabel: string, scope: Scope): ScannerColumn[] {
  const titles = scope === "options"
    ? [`${sortLabel} underlyings`, "Volume-confirmed", "Best entries forming"]
    : [`${sortLabel} movers`, "Volume surges", "Level breaks"];
  return [
    { title: titles[0], rows: displayRows.slice(0, 5) },
    { title: titles[1], rows: displayRows.slice(5, 10) },
    { title: titles[2], rows: displayRows.slice(10, 15) },
  ];
}

function buildStrip(displayRows: TapeRow[], scope: Scope, loop: any, tapeLen: number): StripItem[] {
  if (scope === "options") {
    const puts = displayRows.filter((r) => (r.shortRate ?? 0) < 0).length;
    const calls = displayRows.length - puts;
    return [
      { k: "Put / call flow", v: puts > 0 ? (puts / Math.max(calls, 1)).toFixed(2) : "—", s: puts > calls ? "puts dominating" : "mixed" },
      { k: "Hot names", v: displayRows.length, s: `${displayRows.filter((r) => r.core).length} core · ${displayRows.filter((r) => !r.core).length} runners` },
      { k: "Avg speed", v: displayRows[0]?.shortRate != null ? `${Math.abs(displayRows[0].shortRate!).toFixed(2)}%/m` : "—", s: "fastest tape" },
      { k: "0DTE universe", v: loop?.coreSymbols ?? tapeLen, s: "symbols scanned" },
    ];
  }
  const green = displayRows.filter((r) => (r.movePct ?? 0) > 0).length;
  const sessionActive = loop?.session === "premarket" || loop?.session === "regular" || loop?.session === "afterhours";
  return [
    { k: "Movers tracked", v: displayRows.length, s: "core + hot extended" },
    { k: "Breadth", v: displayRows.length ? Math.round((green / displayRows.length) * 100) : 0, s: "% green in list" },
    { k: "Top speed", v: displayRows[0]?.shortRate != null ? `${displayRows[0].shortRate!.toFixed(2)}%/m` : "—", s: displayRows[0]?.symbol ?? "—" },
    { k: "Session", v: sessionActive ? "LIVE" : "CLOSED", s: loop?.session ?? "—" },
  ];
}

function useFrozenSnapshot<T>(live: T, active: boolean, resetKey: string): T {
  const frozen = useRef<{ key: string; value: T } | null>(null);
  if (!active) {
    frozen.current = null;
    return live;
  }
  if (!frozen.current || frozen.current.key !== resetKey) {
    frozen.current = { key: resetKey, value: live };
  }
  return frozen.current.value;
}

function useSampledSnapshot<T>(live: T, intervalMs: number, resetKey: string): T {
  const [sample, setSample] = useState(live);
  const latest = useRef(live);
  useEffect(() => { latest.current = live; }, [live]);
  useEffect(() => {
    setSample(latest.current);
    const id = setInterval(() => setSample(latest.current), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, resetKey]);
  return sample;
}


function computeConviction(
  scope: Scope,
  heroAlert: any | null,
  heroVerdict: ReturnType<typeof frozenCalloutVerdict> | null,
  openingCandidate: TapeRow | null,
): number {
  if (heroVerdict?.confidence != null) return Math.round(Number(heroVerdict.confidence));
  if (heroAlert?.capture_confidence != null) {
    const c = Number(heroAlert.capture_confidence);
    return Math.round(c <= 1 ? c * 100 : c);
  }
  if (openingCandidate) {
    const speed = Math.abs(openingCandidate.shortRate ?? 0);
    const surge = openingCandidate.surge ?? 1;
    return Math.min(92, Math.round(speed * 120 + surge * 8));
  }
  if (heroAlert?.signal_score != null) return Math.min(100, Math.round(Number(heroAlert.signal_score)));
  return scope === "options" ? 48 : 52;
}

export function OptiscanLiveView({ onOpenChart, onLoopStatus }: {
  onOpenChart?: (symbol: string) => void;
  onLoopStatus?: (running: boolean) => void;
}) {
  const [scope, setScope] = useState<Scope>("options");
  const [sortKey, setSortKey] = useState<LiveSortKey>("speed");
  const [hovering, setHovering] = useState(false);
  const [holdPinned, setHoldPinned] = useState(true);
  const heroLockRef = useRef<{ alertId: number; until: number } | null>(null);
  const [heroAlert, setHeroAlert] = useState<any | null>(null);
  const [settled, setSettled] = useState<any[]>([]);
  const [trackingAlerts, setTrackingAlerts] = useState<any[]>([]);
  const [activeScan, setActiveScan] = useState<StockScanPreset | null>(null);
  const [chartTicker, setChartTicker] = useState("");
  const hotSince = useRef(new Map<string, number>());
  const fastFilterState = useRef(new Map<string, { inList: boolean; pendingSince: number | null }>());
  const { realtime: loop, freshness: streamFresh, lastEventAt: streamLastAt } = useScannerStream();
  const languageMode = useLanguageMode();
  const tapeMap = useLiveTapeMap(1000);
  const tape = (loop?.tape ?? loop?.movers ?? []) as TapeRow[];
  const readingHold = hovering || holdPinned;

  useEffect(() => {
    const saved = loadDashboardPrefs();
    if (saved.liveSort && SORTS.some((sort) => sort.key === saved.liveSort)) setSortKey(saved.liveSort);
    else if (saved.liveScope !== "market") setSortKey("symbol");
    if (saved.liveScope === "market" || saved.liveScope === "options") setScope(saved.liveScope);
  }, []);

  useEffect(() => { onLoopStatus?.(Boolean(loop?.running)); }, [loop?.running, onLoopStatus]);

  const [allProductAlerts, setAllProductAlerts] = useState<any[]>([]);
  const [diagnostics, setDiagnostics] = useState<any | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/alerts?date=${tradingDay()}&limit=80`, { cache: "no-store", headers: scanHeaders() });
        const d = await res.json();
        if (!cancelled) setAllProductAlerts((d.alerts ?? []) as any[]);
      } catch { /* best effort */ }
    };
    poll();
    const pollMs = loop?.session === "regular" || loop?.session === "premarket" ? 2000 : 5000;
    const id = setInterval(poll, pollMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [loop?.session]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/alerts?diagnostics=1", { cache: "no-store", headers: scanHeaders() });
        const d = await res.json();
        if (!cancelled && d?.ok) setDiagnostics(d.diagnostics ?? null);
      } catch { /* diagnostics should never break live view */ }
    };
    poll();
    const id = setInterval(poll, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const heroFromAlerts = useMemo(() => {
    const now = Date.now();
    const isCurrentProduct = (a: any) => scope === "market" ? a.asset_class === "stock" : a.asset_class !== "stock";
    const productAlerts = allProductAlerts.filter(isCurrentProduct);
    const freshMs = scope === "market" ? HERO_CALLOUT_FRESH_MARKET_MS : HERO_CALLOUT_FRESH_MS;
    const freshPool = productAlerts.filter((a) => isAlertFresh(a.alert_time, freshMs, now));
    const coreSymbols = new Set(CORE_WATCH);
    freshPool.sort((a, b) => {
      const ac = coreSymbols.has(a.ticker) ? 1 : 0;
      const bc = coreSymbols.has(b.ticker) ? 1 : 0;
      if (ac !== bc) return bc - ac;
      const at = new Date(a.alert_time ?? 0).getTime();
      const bt = new Date(b.alert_time ?? 0).getTime();
      if (bt !== at) return bt - at;
      return rankAlertForHero(b) - rankAlertForHero(a) || b.id - a.id;
    });
    return freshPool.find((a) =>
      scope === "options"
        ? (a.capture_action === "TRADE" && isFillableOptionsSetup(a))
          || (isFillableOptionsSetup(a) && isMetaShapedAlert(a))
        : a.capture_action === "TRADE",
    ) ?? null;
  }, [allProductAlerts, scope]);

  const stableHero = useMemo(() => {
    const candidate = heroFromAlerts;
    if (!candidate) {
      heroLockRef.current = null;
      return null;
    }
    const now = Date.now();
    const lock = heroLockRef.current;
    if (lock && now < lock.until) {
      const locked = allProductAlerts.find((a) => a.id === lock.alertId);
      if (locked && isAlertFresh(locked.alert_time, HERO_CALLOUT_FRESH_MS, now)) {
        const upgraded =
          candidate.id !== locked.id
          && candidate.capture_action === "TRADE"
          && locked.capture_action !== "TRADE"
          && CORE_SET.has(candidate.ticker);
        if (!upgraded) return locked;
      }
    }
    heroLockRef.current = { alertId: candidate.id, until: now + HERO_STICKY_MS };
    return candidate;
  }, [heroFromAlerts, allProductAlerts]);

  useEffect(() => {
    setHeroAlert(stableHero);
  }, [stableHero]);

  useEffect(() => {
    const productAlerts = allProductAlerts.filter(
      (a) => scope === "market" ? a.asset_class === "stock" : a.asset_class !== "stock",
    );
    const relevant = scope === "options"
      ? productAlerts.filter(isDiscordRelevantAlert)
      : productAlerts.filter((a) => a.capture_action === "TRADE");
    const heroId = stableHero?.id ?? null;
    setSettled(
      relevant.filter((a) => a.id !== heroId).sort((a, b) => b.id - a.id).slice(0, 12),
    );
    setTrackingAlerts(
      relevant.filter((a) => a.status === "tracking").sort((a, b) => b.id - a.id).slice(0, 8),
    );
  }, [allProductAlerts, scope, stableHero?.id]);

  const rows = useMemo(() => {
    const closedRecap = loop?.session === "closed";
    if (closedRecap) {
      const effectiveSort = sortKey === "speed" || sortKey === "surge" || sortKey === "level" ? "move" : sortKey;
      return sortTape([...tape], effectiveSort, effectiveSort === "symbol" ? 1 : -1).slice(0, 60);
    }
    const now = Date.now();
    if (scope === "options") {
      return sortTape(
        tape.filter((r) => r.core || CORE_SET.has(r.symbol)),
        sortKey === "speed" ? "symbol" : sortKey,
        1,
      ).slice(0, 20);
    }
    let list = filterCoreAndWinners([...tape], hotSince.current, now, HOT_LINGER_MS);
    list = sortCoreFirstThenSpeed(list);
    return sortTape(list, sortKey, sortKey === "symbol" ? 1 : -1).slice(0, 60);
  }, [tape, sortKey, loop?.session, scope]);

  const stableSymbols = useStableSymbolOrder(
    rows.map((r) => r.symbol),
    { paused: readingHold, intervalMs: STABLE_ORDER_MS, resetKey: `${scope}-${sortKey}` },
  );
  const rowMap = useMemo(() => new Map(rows.map((r) => [r.symbol, r])), [rows]);
  const fullMap = useMemo(() => new Map(tape.map((r) => [r.symbol, r])), [tape]);
  // Membership dwell (2026-07-09): symbols no longer flash in/out — once
  // watched they stay listed ~90s in a dimmed "cooling" state until they
  // re-qualify, alert, or the dwell expires. Presentation only.
  const stickyState = useRef(makeStickyState());
  const displayRows = useMemo(() => {
    const base = stableSymbols.map((s) => rowMap.get(s) ?? (readingHold ? fullMap.get(s) : undefined)).filter(Boolean) as TapeRow[];
    const sticky = stickyMembership(base.map((r) => r.symbol), stickyState.current, Date.now());
    return sticky.symbols
      .map((s: string) => {
        const row = rowMap.get(s) ?? fullMap.get(s);
        return row ? ({ ...row, cooling: sticky.cooling.has(s) } as TapeRow & { cooling?: boolean }) : undefined;
      })
      .filter(Boolean) as (TapeRow & { cooling?: boolean })[];
  }, [stableSymbols, rowMap, fullMap, readingHold]);

  const scannedRows = scope === "market" && activeScan
    ? applyStockScan(displayRows, activeScan.filters)
    : displayRows;

  const sortLabel = SORTS.find((s) => s.key === sortKey)?.label ?? "Speed";
  const liveColumns = useMemo(() => buildColumns(scannedRows, sortLabel, scope), [scannedRows, sortLabel, scope]);
  const liveStrip = useMemo(() => buildStrip(scannedRows, scope, loop, tape.length), [scannedRows, scope, loop, tape.length]);
  const calmStrip = useSampledSnapshot(liveStrip, 5000, `${scope}-${sortKey}`);
  const holdKey = `${scope}-${readingHold ? "hold" : "live"}`;
  const columns = useFrozenSnapshot(liveColumns, readingHold, holdKey);
  const strip = useFrozenSnapshot(calmStrip, readingHold, holdKey);

  const liveSession = String(loop?.session ?? "closed");
  const marketActive = liveSession === "premarket" || liveSession === "regular" || liveSession === "afterhours";
  const optionsActive = liveSession === "regular";
  const optionsOpeningWatch = liveSession === "premarket";
  const coreTapeRows = useMemo(() => {
    const fromTape = [...tape].filter((r) => r.core || CORE_SET.has(r.symbol));
    return sortCoreFirstThenSpeed(fromTape);
  }, [tape]);

  const liveTapeLead = useMemo((): TapeRow | null => {
    if (scope === "options") return null;
    if (liveSession === "closed" || streamFresh === "red") return null;
    const pool = scannedRows; // scope === "options" already returned above
    const best = pool
      .filter((r) => tapeSpeed(r) >= MIN_SPEED_PCT_PER_MIN * 0.85)
      .sort((a, b) => tapeSpeed(b) - tapeSpeed(a))[0] ?? null;
    if (!best || !heroAlert) return best;

    const heroAgeMs = heroAlert.alert_time
      ? Date.now() - new Date(heroAlert.alert_time).getTime()
      : Infinity;
    const heroRow = tape.find((r) => r.symbol === heroAlert.ticker);
    const heroSpeed = tapeSpeed(heroRow) || Math.abs(Number(heroAlert.short_rate_at_alert ?? 0));
    const bestSpeed = tapeSpeed(best);

    if (heroAgeMs > 30_000 && bestSpeed >= MIN_SPEED_PCT_PER_MIN) return best;
    if (
      best.symbol !== heroAlert.ticker
      && (best.core || CORE_SET.has(best.symbol))
      && bestSpeed > Math.max(heroSpeed, MIN_SPEED_PCT_PER_MIN) * 1.12
    ) return best;
    return null;
  }, [heroAlert, liveSession, scannedRows, coreTapeRows, streamFresh, scope, tape]);

  const heroVerdict = scope === "options" && heroAlert ? frozenCalloutVerdict(heroAlert, liveCtxFor(tapeMap, heroAlert.ticker)) : null;
  const heroSide = String(heroAlert?.option_side ?? "").toLowerCase().startsWith("p") ? "put" : "call";
  const heroCls = heroSide === "put" ? "dn" : "up";
  const stockSide = heroAlert?.trade_bias === "stock_short_candidate" || heroAlert?.direction === "bearish" ? "SHORT" : "LONG";
  const stockSideLabel = uiDirectiveLabel(stockSide === "SHORT" ? "short" : "long", languageMode);
  const stockCls = stockSide === "SHORT" ? "dn" : "up";
  const stockPrice = Number(heroAlert?.price_at_alert ?? 0);
  const entryLow = stockPrice > 0 ? stockPrice * 0.998 : null;
  const entryHigh = stockPrice > 0 ? stockPrice * 1.002 : null;
  const stockSession = heroAlert?.session === "premarket" ? "Premarket" : heroAlert?.session === "afterhours" ? "After-hours" : "Regular hours";
  const heroFillable = scope === "options" && heroAlert ? isFillableOptionsSetup(heroAlert) : false;
  const heroOptionsActive = scope === "options" && optionsActive && heroAlert && !liveTapeLead && (
    heroVerdict?.action === "TRADE" || heroFillable || isMetaShapedAlert(heroAlert)
  );
  const heroTapeRow = heroAlert ? tapeMap.map.get(heroAlert.ticker) : liveTapeLead;
  const heroSpeedNow = heroTapeRow?.instantRate ?? heroTapeRow?.shortRate ?? heroAlert?.short_rate_at_alert ?? null;
  const tapeTickAgeMs = loop?.lastTickAt != null ? Math.max(0, Date.now() - loop.lastTickAt) : null;
  const streamAgeSec = streamLastAt != null ? Math.round((Date.now() - streamLastAt) / 1000) : null;
  const openingCandidate = displayRows[0] ?? null;
  const openingSide = (openingCandidate?.shortRate ?? openingCandidate?.movePct ?? 0) < 0 ? "put" : "call";
  const openingCls = openingSide === "put" ? "dn" : "up";
  const simpleSessionLabel =
    liveSession === "regular" ? "Market is open"
      : liveSession === "premarket" ? "Premarket stocks are moving"
      : liveSession === "afterhours" ? "After-hours stocks are moving"
      : "Market closed";
  const simpleProductNote =
    scope === "options"
      ? optionsActive
        ? "Options ideas are live now."
        : optionsOpeningWatch
          ? "Watching stocks now. Options contracts validate at 9:30."
          : "Options are closed. Premarket watch resumes at 4:00 AM ET."
      : marketActive
        ? "Stock movers are live now. No options contracts here."
        : "Stock movers resume at 4:00 AM ET.";
  const simpleHoldNote = readingHold
    ? "Held: the list is frozen, prices still update."
    : "Use Hold when the tape feels too jumpy.";

  const liveConviction = computeConviction(scope, heroAlert, heroVerdict, liveTapeLead ?? openingCandidate);
  // Beginner fix (2026-07-09): the raw number recomputed every second and
  // meant nothing to a new trader. Sampled every 15s + banded into words.
  const conviction = useSampledSnapshot(liveConviction, 15_000, `${scope}-conviction`);
  const convictionBand = conviction >= 85 ? "VERY STRONG" : conviction >= 65 ? "STRONG" : conviction >= 40 ? "BUILDING" : "LOW";
  const heroBear = heroAlert
    ? (scope === "options"
      ? (heroSide === "put" || (optionsOpeningWatch && openingSide === "put"))
      : stockSide === "SHORT")
    : (liveTapeLead?.shortRate ?? 0) < 0;
  const trackingList = trackingAlerts.length ? trackingAlerts : settled.slice(0, 6);
  const heroLive = Boolean(
    heroOptionsActive
    || (scope === "market" && marketActive && heroAlert)
    || (liveTapeLead && streamFresh !== "red"),
  );

  return (
    <div className={`axiom-live chrome-live${readingHold ? " reading-hold" : ""}${liveSession === "closed" ? " session-closed" : ""}`}>
      <div className="axiom-scan-sweep" aria-hidden />

      <div className="product-bar" aria-label="Scanner product">
        <div className="product-tabs">
          <button type="button" className={scope === "options" ? "on" : ""} onClick={() => { setScope("options"); setSortKey("symbol"); saveDashboardPrefs({ liveScope: "options", liveSort: "symbol" }); }}>
            <span>Options ideas</span><small>Contracts after 9:30 · watch before open</small>
          </button>
          <button type="button" className={scope === "market" ? "on" : ""} onClick={() => { setScope("market"); saveDashboardPrefs({ liveScope: "market" }); }}>
            <span>Stock movers</span><small>Premarket · regular · after-hours</small>
          </button>
        </div>
        <div className={`product-session ${marketActive ? "live" : "closed"}${streamFresh === "red" ? " tape-stale" : ""}`}>
          <span className="product-session-dot" />
          {simpleSessionLabel}
          {marketActive ? ` · tape ${streamFresh === "green" ? "live" : streamFresh === "yellow" ? "slow" : "stale"}${streamAgeSec != null ? ` (${streamAgeSec}s)` : ""}` : ""}
        </div>
        <div className="live-ticker-search">
          <input
            className="input-sm"
            placeholder="Search ticker"
            value={chartTicker}
            onChange={(e) => setChartTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && chartTicker.trim()) onOpenChart?.(chartTicker.trim());
            }}
            aria-label="Search ticker for chart"
          />
          <button
            type="button"
            className="pill btn btn-xs btn-primary"
            disabled={!chartTicker.trim()}
            onClick={() => chartTicker.trim() && onOpenChart?.(chartTicker.trim())}
          >
            Chart
          </button>
        </div>
      </div>

      <div className="live-guide simple-guide" aria-label="How to read this screen">
        <span><b>1.</b> Pick Options or Stocks.</span>
        <span><b>2.</b> Read the big card first.</span>
        <span><b>3.</b> Click any ticker for the chart.</span>
        <span><b>Tip:</b> use Hold when the list feels jumpy.</span>
      </div>

      <div className="ops-health-row" role="status" aria-label="Scanner and Discord health">
        <span className={loop?.running ? "ok" : "warn"}>Scanner {loop?.running ? "running" : "starting"}</span>
        <span className={diagnostics == null ? "idle" : diagnostics.webhooks?.options ? "ok" : "warn"}>
          Options Discord {diagnostics == null ? "checking" : diagnostics.webhooks?.options ? "ready" : "missing webhook"}
        </span>
        <span className={diagnostics == null ? "idle" : diagnostics.webhooks?.stocks ? "ok" : "warn"}>
          Stocks Discord {diagnostics == null ? "checking" : diagnostics.webhooks?.stocks ? "ready" : "missing webhook"}
        </span>
        <span className={diagnostics == null ? "idle" : diagnostics.extendedStockNotify ? "ok" : "warn"}>
          Extended-hours stocks {diagnostics == null ? "checking" : diagnostics.extendedStockNotify ? "on" : "off in Settings"}
        </span>
        {diagnostics?.loop?.nearMisses?.[0] ? (
          <span className="muted">Latest block: {diagnostics.loop.nearMisses[0].symbol} · {diagnostics.loop.nearMisses[0].failedGate}</span>
        ) : null}
      </div>

      {scope === "options" && liveSession !== "regular" ? (
        <div className="session-explainer">
          <b>Options are in watch mode.</b> 0DTE contracts only alert during regular market hours. For live premarket/after-hours ideas, switch to <button type="button" onClick={() => { setScope("market"); saveDashboardPrefs({ liveScope: "market" }); }}>Stock movers</button>.
        </div>
      ) : null}

      {streamFresh === "red" && marketActive ? (
        <p className="live-guide live-stale-warn" role="status">
          Tape feed is stale — wait for &quot;tape live&quot; in the bar above before trading.
        </p>
      ) : null}

      <div className="axiom-hero-row">
        <CardTip metric="heroCallout" className="axiom-hero-card-wrap">
        <div
          className={`axiom-hero-card${(heroAlert?.ticker || liveTapeLead?.symbol) ? " hero-click" : ""}`}
          onClick={(heroAlert?.ticker || liveTapeLead?.symbol) ? () => onOpenChart?.(heroAlert?.ticker ?? liveTapeLead!.symbol) : undefined}
          onKeyDown={(heroAlert?.ticker || liveTapeLead?.symbol) ? (e) => e.key === "Enter" && onOpenChart?.(heroAlert?.ticker ?? liveTapeLead!.symbol) : undefined}
          role={(heroAlert?.ticker || liveTapeLead?.symbol) ? "button" : undefined}
          tabIndex={(heroAlert?.ticker || liveTapeLead?.symbol) ? 0 : undefined}
          title={(heroAlert?.ticker || liveTapeLead?.symbol) ? `Open ${heroAlert?.ticker ?? liveTapeLead!.symbol} chart` : undefined}
        >
        <SignalCard
          bear={heroBear}
          live={heroLive}
          kicker={
            heroOptionsActive
              ? <>
                  {heroVerdict?.action === "TRADE" ? "Options callout" : isMetaShapedAlert(heroAlert!) ? "Fast setup forming" : "Tradable setup"}
                  {" · "}
                  {fmtMarketFreshness(heroAlert!.alert_time) ?? fmtMarketTime(heroAlert!.alert_time)}
                  {heroFillable && heroVerdict?.action !== "TRADE" ? ` · spr ${Number(heroAlert!.entry_spread_pct).toFixed(1)}%` : ""}
                </>
              : liveTapeLead
                ? <>Fast mover - tick {tapeTickAgeMs != null ? `${Math.round(tapeTickAgeMs / 1000)}s ago` : "now"} - checking quality</>
              : scope === "options" && optionsOpeningWatch
                ? <>Opening watch · premarket · not executable yet</>
                : scope === "market" && marketActive && heroAlert
                  ? <>Share momentum · {stockSession}</>
                  : <>Waiting for the next {scope === "options" ? "options idea" : "stock mover"}</>
          }
          action={
            heroOptionsActive
              ? <>{formatCalloutHeadline(heroAlert!)}</>
              : liveTapeLead
                ? <>{liveTapeLead.symbol} · {speedLabel(liveTapeLead.instantRate ?? liveTapeLead.shortRate)}</>
              : scope === "options" && optionsOpeningWatch && openingCandidate
                ? <>WATCH {openingSide.toUpperCase()}</>
                : scope === "market" && marketActive && heroAlert
                  ? <>{formatCalloutHeadline(heroAlert)}</>
                  : <>{marketActive ? "SCANNING" : "CLOSED"}</>
          }
          contract={
            heroOptionsActive
              ? <>{formatOptionsContract(heroAlert!) ?? `${heroAlert!.ticker} $${heroAlert!.strike} ${heroSide} · ${heroAlert!.dte ?? 0}DTE`}</>
              : liveTapeLead
                ? <>{liveTapeLead.symbol} · day {fmtPct(liveTapeLead.movePct)} · surge {liveTapeLead.surge != null ? `${liveTapeLead.surge.toFixed(1)}×` : "—"}</>
              : scope === "options" && optionsOpeningWatch && openingCandidate
                ? <>{openingCandidate.symbol} · premarket bias</>
                : scope === "market" && marketActive && heroAlert
                  ? <>{heroAlert.ticker} shares · {fmtPct(heroAlert.percent_move_at_alert)} day</>
                  : <>{scope === "options" ? "No option idea yet" : "No stock mover yet"}</>
          }
          reason={
            heroOptionsActive
              ? heroVerdict?.reason ?? heroAlert!.ai_explanation ?? "Tight spread + momentum - short-term setup."
              : liveTapeLead
                ? <>Fastest core mover right now. The scanner is checking whether volume, trend, and liquidity are good enough. Speed {speedLabel(liveTapeLead.instantRate ?? liveTapeLead.shortRate)} - volume {liveTapeLead.surge != null ? `${liveTapeLead.surge.toFixed(1)}x` : "-"}</>
              : scope === "options" && optionsOpeningWatch && openingCandidate
                ? <>Premarket {fmtPct(openingCandidate.movePct)} · speed {openingCandidate.shortRate != null ? `${openingCandidate.shortRate.toFixed(2)}%/min` : "—"} · contracts validate at 9:30</>
                : scope === "market" && marketActive && heroAlert
                  ? heroAlert.ai_explanation ?? heroAlert.private_label ?? "Clean directional tape with share-volume confirmation."
                  : simpleProductNote
          }
          footer={
            <>
              <div className="convbar"><div className="convfill" style={{ width: `${conviction}%` }} /></div>
              <div className="sigmeta">
                {heroOptionsActive || (scope === "market" && heroAlert) || liveTapeLead ? (
                  <>
                    {scope === "options" && heroAlert ? (
                      <>
                        <div className="mm"><div className="mmk">Entry</div><div className="mmv num">{heroAlert!.entry_mid != null ? `$${Number(heroAlert!.entry_mid).toFixed(2)}` : "—"}</div></div>
                        <div className="mm"><div className="mmk">Spread</div><div className="mmv num">{heroAlert!.entry_spread_pct != null ? `${Number(heroAlert!.entry_spread_pct).toFixed(1)}%` : "—"}</div></div>
                        <div className="mm"><div className="mmk">Score</div><div className="mmv num">{heroAlert!.signal_score ?? "—"}</div></div>
                        <div className="mm"><div className="mmk">Speed now</div><div className="mmv num">{heroSpeedNow != null ? `${heroSpeedNow > 0 ? "+" : ""}${heroSpeedNow.toFixed(2)}%/m` : "—"}</div></div>
                      </>
                    ) : (
                      <>
                        <div className="mm"><div className="mmk">Price</div><div className="mmv num">{heroTapeRow?.price != null ? `$${heroTapeRow.price.toFixed(2)}` : "—"}</div></div>
                        <div className="mm"><div className="mmk">Speed now</div><div className="mmv num">{heroSpeedNow != null ? `${heroSpeedNow > 0 ? "+" : ""}${heroSpeedNow.toFixed(2)}%/m` : "—"}</div></div>
                        <div className="mm"><div className="mmk">Surge</div><div className="mmv num">{heroTapeRow?.surge != null ? `${heroTapeRow.surge.toFixed(1)}×` : "—"}</div></div>
                        <div className="mm"><div className="mmk">Tape</div><div className="mmv num">{streamFresh === "green" ? "LIVE" : streamFresh === "yellow" ? "SLOW" : "STALE"}</div></div>
                      </>
                    )}
                  </>
                ) : null}
              </div>
              <p className="gates" style={{ marginTop: 10 }}>
                {heroAlert
                  ? isMetaShapedAlert(heroAlert) && heroAlert.capture_action !== "TRADE"
                    ? <>Fast setup forming - <b>confirm spread</b> before entry</>
                    : <>Quality checks passed - <b>speed</b> + <b>volume</b> + <b>trend</b> + <b>liquidity</b></>
                  : liveTapeLead
                    ? <>Watch only - <b>not a trade idea yet</b> until quality checks pass</>
                    : <>Scanning - waiting for a clean setup</>}
              </p>
              {heroAlert && scope === "options" ? <MetaBarPanel alert={heroAlert} compact /> : null}
            </>
          }
        />
        </div>
        </CardTip>

        <CardTip metric="conviction" className="axiom-hero-ring">
          <ConvictionRing value={conviction} bear={heroBear} label={convictionBand} size={168} />
          <div className="axiom-today">
            <InfoTip metric="conviction">Strength</InfoTip> - {tradingDay()}
            <small>How strong the main idea is right now</small>
          </div>
        </CardTip>

        <Panel title="Open ideas" meta={`${trackingList.length} tracking - click row for chart`} live tip="liveTracking" className="axiom-hero-track">
          {trackingList.length ? trackingList.map((a) => {
            const ret = scope === "market" ? (a.latest_max_move ?? a.move_5m ?? a.eod_move) : a.option_return_pct;
            const bear = a.trade_bias === "stock_short_candidate" || a.direction === "bearish" || String(a.option_side ?? "").toLowerCase().startsWith("p");
            const cp = checkpointMeta(a.alert_time);
            const liveRow = tapeMap.map.get(a.ticker);
            const liveSpeed = liveRow?.shortRate ?? a.short_rate_at_alert;
            const alertTime = fmtMarketFreshness(a.alert_time) ?? fmtMarketTime(a.alert_time);
            const contract = scope === "options" ? formatOptionsContract(a) : null;
            return (
              <TrackingRow
                key={a.id}
                tag={bear ? (scope === "market" ? "SHORT" : "PUT") : (scope === "market" ? "LONG" : "CALL")}
                tagTone={bear ? "bear" : "bull"}
                symbol={a.ticker}
                sub={<>{alertTime} · <b>{speedLabel(liveSpeed)}</b>{contract ? <> · {contract}</> : null}</>}
                pnl={ret != null ? `${ret > 0 ? "+" : ""}${Math.round(ret)}%` : "open"}
                pnlTone={ret != null && ret > 0 ? "g" : ret != null ? "r" : ""}
                win={ret != null && ret > 0}
                loss={ret != null && ret < 0}
                onClick={() => onOpenChart?.(a.ticker)}
                title={`${cp.hint} · click for chart`}
                right={
                  <>
                    <span className="ttime">{cp.label}</span>
                    <div className="tbar"><div className="tfill" style={{ width: `${cp.pct}%` }} /></div>
                  </>
                }
              />
            );
          }) : (
            <div className="sigwhy">No open callouts tracking right now.</div>
          )}
        </Panel>
      </div>

      <div className="axiom-strip">
        {strip.map((s) => (
          <StatTile key={s.k} label={s.k} value={s.v} hint={s.s} metric={STRIP_METRIC[s.k]} />
        ))}
      </div>

      <>
        <div className="hot-names-row core-names-row" aria-label="Core watch speed board">
          <span className="hot-names-label">Core watch - NVDA SPY TSLA... - click for chart</span>
          {coreTapeRows.length ? coreTapeRows.slice(0, 12).map((r) => (
            <button
              key={r.symbol}
              type="button"
              className={`hot-name-chip core-chip${tapeSpeed(r) >= MIN_SPEED_PCT_PER_MIN ? " core-hot" : ""}`}
              onClick={() => onOpenChart?.(r.symbol)}
              title={`${r.symbol} · ${speedLabel(r.shortRate)} · day ${fmtPct(r.movePct)}`}
            >
              <span className="sym">{r.symbol}</span>
              <span className={`num ${tapeSpeed(r) >= MIN_SPEED_PCT_PER_MIN ? "spd-strong" : ""}`}>{speedLabel(r.shortRate)}</span>
            </button>
          )) : <span className="hot-name-chip empty-chip">Warming up tape...</span>}
        </div>
      </>

      {scope !== "options" ? (
        <div className="hot-names-row" aria-label="Runners speed board">
          <span className="hot-names-label">Runners · click for chart</span>
          {displayRows.filter((r) => !r.core).length ? displayRows.filter((r) => !r.core).slice(0, 8).map((r) => (
            <button
              key={r.symbol}
              type="button"
              className={`hot-name-chip${r.core ? " core-chip" : " runner-chip"}`}
              onClick={() => onOpenChart?.(r.symbol)}
              title={`Open ${r.symbol} chart`}
            >
              <span className="sym">{r.symbol}</span>
              <span className="num spd-strong">{speedLabel(r.shortRate)}</span>
            </button>
          )) : <span className="hot-name-chip empty-chip">No runners yet</span>}
        </div>
      ) : null}

      {scope === "market" ? (
        <div className="axiom-scanner-builder">
          <ScannerBuilder activeId={activeScan?.id ?? null} onActive={setActiveScan} />
        </div>
      ) : null}

      {scope === "options" ? (
        <p className="discord-desk-note muted text-sm">
          Scanner watches core names (NVDA, SPY, TSLA, META…). When a setup passes the quality bar, it appears in <b>Recent callouts</b> — copy from Alerts → Accuracy for Discord.
        </p>
      ) : null}

      <>
      <div className="section-head scanner-head">
        <span className="section-title">Scanners</span>
        <span className="section-head-actions">
          <span className="section-note">{simpleProductNote} {simpleHoldNote}</span>
          <label className="sort-control">
            <span>Sort</span>
            <select value={sortKey} onChange={(e) => {
              const next = e.target.value as LiveSortKey;
              setSortKey(next);
              saveDashboardPrefs({ liveSort: next });
            }} aria-label="Sort scanner names">
              {SORTS.map((s) => <option value={s.key} key={s.key}>{s.label}</option>)}
            </select>
          </label>
          <button type="button" className={`hold-btn${readingHold ? " on" : ""}`} onClick={() => setHoldPinned((v) => !v)} aria-pressed={readingHold}>
            {readingHold ? "Holding" : "Hold"}
          </button>
        </span>
      </div>

      <div className="scanners axiom-scanners" onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
        {columns.map((col) => (
          <div className="scanner" key={col.title}>
            <h3>{COLUMN_METRIC[col.title] ? <InfoTip metric={COLUMN_METRIC[col.title]}>{col.title}</InfoTip> : <InfoTip metric="speed">{col.title}</InfoTip>}</h3>
            <ul>
              {col.rows.map((r) => {
                const liveRow = rowMap.get(r.symbol) ?? r;
                return (
                  <li
                    key={r.symbol}
                    className={(r as any).cooling ? "row-cooling" : undefined}
                    title={(r as any).cooling ? "Cooling — stays listed ~90s after momentum fades" : undefined}
                    onClick={() => onOpenChart?.(r.symbol)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && onOpenChart?.(r.symbol)}
                  >
                    <span className="sym">{r.symbol}{r.core ? "" : " ↑"}</span>
                    <span className="spd num">
                      <TickValue value={liveRow.shortRate} minDelta={0.03}>{speedLabel(liveRow.shortRate)}</TickValue>
                    </span>
                    <span className="why" dangerouslySetInnerHTML={{ __html: readingHold ? whyLine(r, scope) : whyLine(liveRow, scope) }} />
                    <span className={`m num ${pctClass(liveRow.movePct)}`}>
                      <TickValue value={liveRow.movePct} minDelta={0.08}>{fmtPct(liveRow.movePct)}</TickValue>
                      <small>{liveRow.price != null ? `$${liveRow.price.toFixed(2)}` : "—"}</small>
                    </span>
                  </li>
                );
              })}
              {!col.rows.length ? (
                <li className="scanner-empty-row">
                  <span className="sym">—</span>
                  <span className="spd num">—</span>
                  <span className="why">Waiting for stable tape</span>
                  <span className="m num">—</span>
                </li>
              ) : null}
            </ul>
          </div>
        ))}
      </div>
      </>

      {scope === "options" && (loop?.nearMisses?.length ?? 0) > 0 ? (
        <CardTip metric="nearMiss" className="near-miss-wrap">
        <details className="near-miss-panel">
          <summary className="muted text-sm">
            Why didn&apos;t it alert? — {loop.nearMisses.length} near-miss{loop.nearMisses.length === 1 ? "" : "es"} (symbols that came close but a quality gate held them back)
          </summary>
          <ul className="ledger near-miss-list">
            {loop.nearMisses.slice(0, 8).map((m: any) => (
              <li key={`${m.symbol}-${m.t}`}>
                <span className="t num">{new Date(m.t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}</span>
                <span className="what">
                  <b>{m.symbol}</b> blocked by <b>{m.failedGate}</b>
                  <small>
                    speed {m.values?.shortRate?.toFixed?.(2) ?? "—"}%/min (needs {m.thresholds?.minRate?.toFixed?.(2)})
                    · surge {m.values?.surge?.toFixed?.(1) ?? "—"}x (needs {m.thresholds?.minSurge?.toFixed?.(1)})
                    · eff {m.values?.efficiency?.toFixed?.(2) ?? "—"}
                  </small>
                </span>
                <span className="res muted text-xs">{m.gates?.cooldownBlocked ? "cooldown" : "gate"}</span>
              </li>
            ))}
          </ul>
          <p className="muted text-xs">Fewer alerts is the design — this panel shows the bar is being enforced, not that the scanner is asleep.</p>
        </details>
        </CardTip>
      ) : null}

      <div className="section-head">
        <span className="section-title">{scope === "options" ? "Discord callouts today" : "Recent callouts"}</span>
        <span className="section-note">{scope === "options" ? "Best verified options ideas - newest first" : `Newest first - today\u2019s ${scope === "market" ? "stock" : "options"} ideas`}</span>
      </div>
      <ul className="ledger axiom-ledger">
        {settled.length ? settled.map((a) => {
          const ret = scope === "market" ? (a.latest_max_move ?? a.move_5m ?? a.eod_move) : a.option_return_pct;
          const contract = scope === "options" ? formatOptionsContract(a) : null;
          const headline = formatCalloutHeadline(a);
          const liveSpeed = tapeMap.map.get(a.ticker)?.shortRate ?? a.short_rate_at_alert;
          const sess = a.session === "afterhours" ? "AH" : a.session === "premarket" ? "Pre" : a.session === "regular" ? "RTH" : "";
          return (
            <li
              key={a.id}
              className="ledger-click"
              onClick={() => onOpenChart?.(a.ticker)}
              onKeyDown={(e) => e.key === "Enter" && onOpenChart?.(a.ticker)}
              role="button"
              tabIndex={0}
              title={`Open ${a.ticker} chart`}
            >
              <span className="t num">{fmtMarketFreshness(a.alert_time) ?? fmtMarketTime(a.alert_time)}{sess ? ` · ${sess}` : ""}</span>
              <span className="what">
                {scope === "market"
                  ? `${headline} ${a.ticker}`
                  : `${headline}${contract ? ` · ${contract}` : ` · ${a.ticker}`}`}
                <small>{speedLabel(liveSpeed)} · {a.ai_explanation?.slice(0, 60) ?? "scanner callout"}</small>
              </span>
              <span className={`res num ${ret != null && ret > 0 ? "pos" : ret != null ? "neg" : "open"}`}>
                {ret != null ? `${ret > 0 ? "+" : ""}${Math.round(ret)}%` : "open"}
              </span>
            </li>
          );
        }) : (
          <li><span className="t">—</span><span className="what muted">No {scope === "market" ? "share" : "options"} callouts yet today</span><span className="res open">waiting</span></li>
        )}
      </ul>

      <p className="foot" style={{ marginTop: "1rem", color: "var(--muted)", fontSize: ".72rem" }}>
        Research signals, never orders. Not financial advice. · <Link href="/alerts" className="chrome-link inline-link">Accuracy dashboard</Link>
      </p>
    </div>
  );
}

function checkpointMeta(alertTime: string): { label: string; pct: number; hint: string } {
  const start = Date.parse(alertTime);
  if (!Number.isFinite(start)) return { label: "just fired", pct: 0, hint: "Tracks whether the move holds at 5m, 15m, 30m, 1h" };
  const mins = (Date.now() - start) / 60_000;
  if (mins < 5) {
    return {
      label: `${Math.round(mins * 10) / 10}m → 5m`,
      pct: Math.min(100, (mins / 5) * 100),
      hint: "First 5 minutes — did price keep moving your way?",
    };
  }
  if (mins < 15) {
    return {
      label: `${Math.round(mins)}m → 15m`,
      pct: Math.min(100, ((mins - 5) / 10) * 100),
      hint: "15-minute checkpoint — early follow-through window",
    };
  }
  if (mins < 30) {
    return {
      label: `${Math.round(mins)}m → 30m`,
      pct: Math.min(100, ((mins - 15) / 15) * 100),
      hint: "30-minute checkpoint — is momentum still there?",
    };
  }
  if (mins < 60) {
    return {
      label: `${Math.round(mins)}m → 1h`,
      pct: Math.min(100, ((mins - 30) / 30) * 100),
      hint: "One-hour checkpoint — swing vs fade",
    };
  }
  return { label: "EOD track", pct: 100, hint: "Tracking through end of day" };
}

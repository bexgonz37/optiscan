"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useScannerStream } from "@/hooks/useScannerStream";
import { scanHeaders } from "@/hooks/useScanner";
import { useStableSymbolOrder } from "@/lib/stable-order";
import { applyFastFilterHysteresis } from "@/lib/tape-filter-hysteresis";
import { tickDirection } from "@/lib/tick-flash";
import { sortTape, type TapeRow, type WatchSortKey } from "@/lib/watch-score";
import { frozenCalloutVerdict } from "@/lib/trade-verdict";
import { fmtPct, pctClass } from "@/lib/format";
import { tradingDay } from "@/lib/trading-session";
import { liveCtxFor, useLiveTapeMap } from "@/hooks/useLiveTapeMap";
import { loadDashboardPrefs, saveDashboardPrefs } from "@/lib/dashboard-prefs";
import { uiDirectiveLabel } from "@/lib/language-modes";
import { useLanguageMode } from "@/hooks/useLanguageMode";

const HOT_LINGER_MS = 20_000;
const STABLE_ORDER_MS = 20_000;
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

function isHotExtended(r: TapeRow): boolean {
  return Math.abs(r.shortRate ?? 0) >= 0.2 && (r.surge ?? 0) >= 1.4 && (r.efficiency == null || r.efficiency >= 0.35);
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
      { k: "Hot names", v: displayRows.length, s: "on core + extended" },
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

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function ConvictionRing({ value }: { value: number }) {
  const r = 88;
  const c = 2 * Math.PI * r;
  const v = Math.min(100, Math.max(0, value));
  const offset = c * (1 - v / 100);
  return (
    <div className="ringwrap">
      <svg className="ring" viewBox="0 0 200 200" aria-hidden>
        <circle className="ringbg" cx="100" cy="100" r={r} />
        <circle className="ringfg" cx="100" cy="100" r={r} strokeDasharray={c} strokeDashoffset={offset} />
      </svg>
      <div className="ringctr">
        <div className="ringnum">{Math.round(v)}</div>
        <div className="ringlbl">SCORE</div>
      </div>
    </div>
  );
}

function heatCellStyle(val: number | null | undefined): React.CSSProperties {
  if (val == null) return { background: "rgba(255,255,255,.04)", color: "#5f7d93" };
  const t = Math.min(1, Math.abs(val) / 4);
  if (val >= 0) return { background: `rgba(47,240,166,${0.12 + t * 0.45})`, color: "#2ff0a6", borderColor: "rgba(47,240,166,.25)" };
  return { background: `rgba(255,81,98,${0.12 + t * 0.45})`, color: "#ff6b78", borderColor: "rgba(255,81,98,.25)" };
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
  const [holdPinned, setHoldPinned] = useState(false);
  const [heroAlert, setHeroAlert] = useState<any | null>(null);
  const [settled, setSettled] = useState<any[]>([]);
  const hotSince = useRef(new Map<string, number>());
  const fastFilterState = useRef(new Map<string, { inList: boolean; pendingSince: number | null }>());
  const { realtime: loop } = useScannerStream();
  const languageMode = useLanguageMode();
  const tapeMap = useLiveTapeMap(1000);
  const tape = (loop?.tape ?? loop?.movers ?? []) as TapeRow[];
  const readingHold = hovering || holdPinned;

  useEffect(() => {
    const saved = loadDashboardPrefs();
    if (saved.liveSort && SORTS.some((sort) => sort.key === saved.liveSort)) setSortKey(saved.liveSort);
    if (saved.liveScope === "market" || saved.liveScope === "options") setScope(saved.liveScope);
  }, []);

  useEffect(() => { onLoopStatus?.(Boolean(loop?.running)); }, [loop?.running, onLoopStatus]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/alerts?date=${tradingDay()}&limit=80`, { cache: "no-store", headers: scanHeaders() });
        const d = await res.json();
        const now = Date.now();
        const alerts = (d.alerts ?? []) as any[];
        const isCurrentProduct = (a: any) => scope === "market" ? a.asset_class === "stock" : a.asset_class !== "stock";
        const productAlerts = alerts.filter(isCurrentProduct);
        const trades = productAlerts.filter((a) => a.capture_action === "TRADE");
        trades.sort((a, b) => b.id - a.id);
        const fresh = trades.find((a) => {
          const t = Date.parse(a.alert_time ?? "");
          return Number.isFinite(t) && now - t < (scope === "market" ? 10 : 5) * 60_000;
        });
        if (!cancelled) setHeroAlert(fresh ?? trades[0] ?? null);
        const heroId = fresh?.id ?? trades[0]?.id ?? null;
        const recent = productAlerts
          .filter((a) => a.id !== heroId)
          .sort((a, b) => b.id - a.id)
          .slice(0, 10);
        if (!cancelled) setSettled(recent);
      } catch { /* best effort */ }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [scope]);

  const rows = useMemo(() => {
    const closedRecap = loop?.session === "closed";
    if (closedRecap) {
      const effectiveSort = sortKey === "speed" || sortKey === "surge" || sortKey === "level" ? "move" : sortKey;
      return sortTape([...tape], effectiveSort, effectiveSort === "symbol" ? 1 : -1).slice(0, 60);
    }
    const now = Date.now();
    let list = [...tape];
    list = list.filter((r) => {
      if (r.core) return true;
      if (isHotExtended(r)) { hotSince.current.set(r.symbol, now); return true; }
      const last = hotSince.current.get(r.symbol);
      if (last != null && now - last < HOT_LINGER_MS) return true;
      hotSince.current.delete(r.symbol);
      return false;
    });
    list = applyFastFilterHysteresis(list, fastFilterState.current, now);
    return sortTape(list, sortKey, sortKey === "symbol" ? 1 : -1).slice(0, 60);
  }, [tape, sortKey, loop?.session]);

  const stableSymbols = useStableSymbolOrder(
    rows.map((r) => r.symbol),
    { paused: readingHold, intervalMs: STABLE_ORDER_MS, resetKey: `${scope}-${sortKey}` },
  );
  const rowMap = useMemo(() => new Map(rows.map((r) => [r.symbol, r])), [rows]);
  const fullMap = useMemo(() => new Map(tape.map((r) => [r.symbol, r])), [tape]);
  const displayRows = useMemo(
    () => stableSymbols.map((s) => rowMap.get(s) ?? (readingHold ? fullMap.get(s) : undefined)).filter(Boolean) as TapeRow[],
    [stableSymbols, rowMap, fullMap, readingHold],
  );

  const sortLabel = SORTS.find((s) => s.key === sortKey)?.label ?? "Speed";
  const liveColumns = useMemo(() => buildColumns(displayRows, sortLabel, scope), [displayRows, sortLabel, scope]);
  const liveStrip = useMemo(() => buildStrip(displayRows, scope, loop, tape.length), [displayRows, scope, loop, tape.length]);
  const calmStrip = useSampledSnapshot(liveStrip, 5000, `${scope}-${sortKey}`);
  const holdKey = `${scope}-${readingHold ? "hold" : "live"}`;
  const columns = useFrozenSnapshot(liveColumns, readingHold, holdKey);
  const strip = useFrozenSnapshot(calmStrip, readingHold, holdKey);

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
  const liveSession = String(loop?.session ?? "closed");
  const marketActive = liveSession === "premarket" || liveSession === "regular" || liveSession === "afterhours";
  const optionsActive = liveSession === "regular";
  const optionsOpeningWatch = liveSession === "premarket";
  const openingCandidate = displayRows[0] ?? null;
  const openingSide = (openingCandidate?.shortRate ?? openingCandidate?.movePct ?? 0) < 0 ? "put" : "call";
  const openingCls = openingSide === "put" ? "dn" : "up";
  const sessionLabel = liveSession === "premarket"
    ? "Premarket shares live · 4:00–9:30 AM ET"
    : liveSession === "regular"
      ? "Regular session live · options + shares"
      : liveSession === "afterhours"
        ? "After-hours shares live · until 8:00 PM ET"
        : "Market closed · shares resume 4:00 AM ET";
  const productNote = scope === "options"
    ? optionsActive
      ? "0DTE options live · contracts validated now"
      : optionsOpeningWatch
        ? "Opening watch live · underlying momentum only · contracts validate at 9:30"
        : "0DTE options closed · opening watch resumes 4:00 AM ET"
    : marketActive
      ? languageMode === "public"
        ? "Share momentum live · bullish/bearish watches · no options"
        : "Share momentum live · LONG/SHORT · no options"
      : "Share momentum closed · resumes 4:00 AM ET";

  const holdNote = readingHold
    ? "Held · membership frozen · prices still tick"
    : liveSession === "closed"
      ? "Market closed · showing latest snapshot movers"
      : "Ranks refresh every 20s · hover scanners or tap Hold";

  const conviction = computeConviction(scope, heroAlert, heroVerdict, openingCandidate);
  const primeBear = scope === "options"
    ? (heroSide === "put" || openingSide === "put")
    : stockSide === "SHORT";
  const flowRows = displayRows.slice(0, 8);
  const momRows = displayRows.slice(0, 12);
  const heatRows = displayRows.slice(0, 6);

  return (
    <div className={`grid1a chrome-live${readingHold ? " reading-hold" : ""}${liveSession === "closed" ? " session-closed" : ""}`}>
      <div className="topbar">
        <div>
          <div className="brand">OPTI<b>SCAN</b></div>
          <div className="brandsub">LIVE TERMINAL</div>
        </div>
        <div className="seg" role="tablist" aria-label="Scanner product">
          <button type="button" className={`segb${scope === "options" ? " on" : ""}`} onClick={() => { setScope("options"); saveDashboardPrefs({ liveScope: "options" }); }}>Options</button>
          <button type="button" className={`segb${scope === "market" ? " on" : ""}`} onClick={() => { setScope("market"); saveDashboardPrefs({ liveScope: "market" }); }}>Market</button>
        </div>
        {strip.slice(0, 3).map((s) => (
          <div className="chip" key={s.k}>
            <div className="chipk">{s.k}</div>
            <div className="chipv num">{s.v}</div>
          </div>
        ))}
        <div className="scanpill">
          <span className="dot" />
          {marketActive ? "Scanner live" : "Session closed"} · {clockFromLoop(liveSession)}
        </div>
      </div>

      <div className="rstack">
        <div className="panel">
          <div className="ph">
            <div className="pht"><i aria-hidden />Tape flow</div>
            <div className="phc rec">Live</div>
          </div>
          <div className="pb">
            {flowRows.length ? flowRows.map((r, i) => (
              <div
                key={r.symbol}
                className={`frow ${(r.shortRate ?? r.movePct ?? 0) >= 0 ? "c" : "p"}`}
                role="button"
                tabIndex={0}
                onClick={() => onOpenChart?.(r.symbol)}
                onKeyDown={(e) => e.key === "Enter" && onOpenChart?.(r.symbol)}
              >
                <span className="ftime num">{String(i + 1).padStart(2, "0")}</span>
                <span className="fsym">{r.symbol}</span>
                <span className="fstrike">{stripHtml(whyLine(readingHold ? r : (rowMap.get(r.symbol) ?? r), scope)).slice(0, 42)}</span>
                <span className="fprem num">{fmtPct(r.movePct)}</span>
              </div>
            )) : (
              <div className="frow"><span className="fstrike" style={{ gridColumn: "1 / -1", color: "#5f7d93" }}>Building tape…</span></div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="ph">
            <div className="pht"><i aria-hidden />Session pulse</div>
            <div className="phc">{productNote.slice(0, 28)}</div>
          </div>
          <div className="pb">
            {strip.map((s) => (
              <div className="ivrow" key={s.k}>
                <span className="ivsym">{s.k.slice(0, 12)}</span>
                <div className="ivtrk"><div className="ivfill" style={{ width: `${Math.min(100, typeof s.v === "number" ? s.v : 55)}%`, background: "linear-gradient(90deg,#46b4e8,#2ff0a6)" }} /></div>
                <span className="ivr num">{s.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="cencol">
        <div className={`prime${primeBear ? " bear" : ""}${readingHold ? " reading-hold" : ""}`}>
          <div className="primebody">
            <ConvictionRing value={conviction} />
            <div>
              {scope === "options" && optionsActive && heroAlert && heroVerdict?.action === "TRADE" ? (
                <>
                  <div className="primeact">
                    BUY {heroSide.toUpperCase()}
                    <span className="nowchip">LIVE</span>
                  </div>
                  <div className="primecon">{heroAlert.ticker} ${heroAlert.strike} · {heroAlert.dte ?? 0}DTE</div>
                  <div className="primewhy">{heroVerdict.reason}</div>
                  <div className="primelevels">
                    <div className="pl"><div className="plk">Mid</div><div className="plv g num">{heroAlert.entry_mid != null ? `$${Number(heroAlert.entry_mid).toFixed(2)}` : "—"}</div></div>
                    <div className="pl"><div className="plk">Spread</div><div className="plv num">{heroAlert.entry_spread_pct != null ? `${Number(heroAlert.entry_spread_pct).toFixed(1)}%` : "—"}</div></div>
                    <div className="pl"><div className="plk">Speed</div><div className="plv num">{heroAlert.short_rate_at_alert != null ? `${heroAlert.short_rate_at_alert > 0 ? "+" : ""}${heroAlert.short_rate_at_alert.toFixed(2)}%/m` : "—"}</div></div>
                  </div>
                </>
              ) : scope === "options" && optionsOpeningWatch && openingCandidate ? (
                <>
                  <div className="primeact">OPEN WATCH<span className="nowchip">PRE</span></div>
                  <div className="primecon">{openingCandidate.symbol} · {openingSide} bias</div>
                  <div className="primewhy">Premarket {fmtPct(openingCandidate.movePct)} · speed {openingCandidate.shortRate != null ? `${openingCandidate.shortRate.toFixed(2)}%/m` : "—"} · validates at 9:30 ET</div>
                </>
              ) : scope === "market" && marketActive && heroAlert ? (
                <>
                  <div className="primeact">{stockSideLabel}<span className="nowchip">LIVE</span></div>
                  <div className="primecon">{heroAlert.ticker} shares · {stockSession}</div>
                  <div className="primewhy">{heroAlert.ai_explanation ?? heroAlert.private_label ?? "Clean directional tape with share-volume confirmation."}</div>
                  <div className="primelevels">
                    <div className="pl"><div className="plk">Entry</div><div className="plv num">{entryLow != null && entryHigh != null ? `$${entryLow.toFixed(2)}–${entryHigh.toFixed(2)}` : "—"}</div></div>
                    <div className="pl"><div className="plk">Speed</div><div className="plv num">{heroAlert.short_rate_at_alert != null ? `${heroAlert.short_rate_at_alert > 0 ? "+" : ""}${heroAlert.short_rate_at_alert.toFixed(2)}%/m` : "—"}</div></div>
                    <div className="pl"><div className="plk">Volume</div><div className="plv num">{heroAlert.volume_surge_at_alert != null ? `${heroAlert.volume_surge_at_alert.toFixed(1)}×` : "—"}</div></div>
                  </div>
                </>
              ) : (
                <>
                  <div className="primeact">{marketActive ? "SCANNING" : "CLOSED"}</div>
                  <div className="primecon">{scope === "options" ? "0DTE options desk" : "Share momentum desk"}</div>
                  <div className="primewhy">{scope === "market" && !marketActive ? "Premarket resumes 4:00 AM ET." : "When a callout clears every gate, the ticket lands here first."} Research signals only.</div>
                </>
              )}
            </div>
          </div>
          {settled.length ? (
            <div className="ondeck">
              <div className="ondeckl"><b />On deck</div>
              {settled.slice(0, 3).map((a) => {
                const ret = scope === "market" ? (a.latest_max_move ?? a.move_5m ?? a.eod_move) : a.option_return_pct;
                const side = String(a.option_side ?? "").toLowerCase().startsWith("p") ? "bear" : "bull";
                return (
                  <div key={a.id} className={`tmini${ret != null && ret > 0 ? " win" : ret != null && ret < 0 ? " loss" : ""}`}>
                    <span className={`miniact ${side}`}>{scope === "market" ? "SH" : side === "bear" ? "PUT" : "CALL"}</span>
                    <b>{a.ticker}</b>
                    <span className="num">{ret != null ? `${ret > 0 ? "+" : ""}${Math.round(ret)}%` : "open"}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="panel">
          <div className="ph">
            <div className="pht"><i aria-hidden />Signal queue</div>
            <div className="phc">{settled.length ? `${settled.length} recent` : "Waiting"}</div>
          </div>
          <div className="pb sigwrap">
            {settled.slice(0, 3).map((a) => {
              const side = String(a.option_side ?? "").toLowerCase().startsWith("p") ? "bear" : "bull";
              const ret = scope === "market" ? (a.latest_max_move ?? a.move_5m) : a.option_return_pct;
              return (
                <div key={a.id} className={`sig ${side}`}>
                  <div className="sigtop">
                    <div className="sigact">{a.ticker}{scope === "options" && a.strike ? ` $${a.strike}` : ""}</div>
                    <div className="sigconv num">{ret != null ? `${ret > 0 ? "+" : ""}${Math.round(ret)}%` : "—"}<span> ret</span></div>
                  </div>
                  <div className="sigwhy">{(a.ai_explanation ?? "scanner callout").slice(0, 90)}</div>
                </div>
              );
            })}
            {!settled.length ? <div className="sigwhy" style={{ padding: "8px 4px" }}>No {scope === "market" ? "share" : "options"} callouts yet today.</div> : null}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="ph">
          <div className="pht"><i aria-hidden />Active tracking</div>
          <div className="phc rec">Today</div>
        </div>
        <div className="pb">
          {settled.length ? settled.slice(0, 6).map((a) => {
            const ret = scope === "market" ? (a.latest_max_move ?? a.move_5m ?? a.eod_move) : a.option_return_pct;
            const side = a.trade_bias === "stock_short_candidate" || a.direction === "bearish" || String(a.option_side ?? "").toLowerCase().startsWith("p") ? "bear" : "bull";
            return (
              <div key={a.id} className={`trow${ret != null && ret > 0 ? " win" : ret != null && ret < 0 ? " loss" : ""}`}>
                <span className={`ttag ${side}`}>{side === "bear" ? "PUT" : scope === "market" ? "SH" : "CALL"}</span>
                <span className="tsym"><b>{a.ticker}</b><span className="tpx">{new Date(a.alert_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET</span></span>
                <span className={`tpnl num ${ret != null && ret > 0 ? "g" : ret != null ? "r" : ""}`}>{ret != null ? `${ret > 0 ? "+" : ""}${Math.round(ret)}%` : "open"}</span>
                <span className="ttimer"><span className="ttime">{a.capture_action === "TRADE" ? "TRADE" : "WATCH"}</span></span>
              </div>
            );
          }) : (
            <div className="trow"><span className="tsym"><b>—</b><span className="tpx">Waiting for first callout</span></span></div>
          )}
        </div>
      </div>

      <div className="botgrid">
        <div className="panel">
          <div className="ph">
            <div className="pht"><i aria-hidden />Momentum tape</div>
            <div className="phc">
              <label className="sort-control" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <span>Sort</span>
                <select value={sortKey} onChange={(e) => { const next = e.target.value as LiveSortKey; setSortKey(next); saveDashboardPrefs({ liveSort: next }); }} aria-label="Sort scanner">
                  {SORTS.map((s) => <option value={s.key} key={s.key}>{s.label}</option>)}
                </select>
              </label>
              <button type="button" className={`hold-btn${readingHold ? " on" : ""}`} style={{ marginLeft: 8 }} onClick={() => setHoldPinned((v) => !v)}>{readingHold ? "Holding" : "Hold"}</button>
            </div>
          </div>
          <div className="pb" onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
            {momRows.map((r, i) => {
              const liveRow = rowMap.get(r.symbol) ?? r;
              const spd = Math.abs(liveRow.shortRate ?? 0);
              const barW = Math.min(100, spd * 180);
              return (
                <div key={r.symbol} className="mrow" role="button" tabIndex={0} onClick={() => onOpenChart?.(r.symbol)} onKeyDown={(e) => e.key === "Enter" && onOpenChart?.(r.symbol)}>
                  <span className="mrank num">{i + 1}</span>
                  <span className="msym">{r.symbol}</span>
                  <div className="mtrk"><div className="mfill" style={{ width: `${barW}%` }} /></div>
                  <span className="mrvol num">{liveRow.surge != null ? `${liveRow.surge.toFixed(1)}×` : "—"}</span>
                  <span className={`mchg num ${pctClass(liveRow.movePct)}`}><TickValue value={liveRow.movePct} minDelta={0.08}>{fmtPct(liveRow.movePct)}</TickValue></span>
                </div>
              );
            })}
            <div className="phc" style={{ marginTop: 6 }}>{holdNote}</div>
          </div>
        </div>

        <div className="panel">
          <div className="ph">
            <div className="pht"><i aria-hidden />Tape heatmap</div>
            <div className="phc">{sortLabel}</div>
          </div>
          <div className="pb">
            <div className="hmhead">
              <span>SYM</span><span>SPD</span><span>MOVE</span><span>SURGE</span><span>LVL</span>
            </div>
            <div className="hm">
              {heatRows.map((r) => {
                const liveRow = rowMap.get(r.symbol) ?? r;
                return (
                  <div className="hmrow" key={r.symbol}>
                    <span className="hmsym">{r.symbol}</span>
                    <span className="hmcell num" style={heatCellStyle(liveRow.shortRate)}>{liveRow.shortRate != null ? liveRow.shortRate.toFixed(1) : "—"}</span>
                    <span className="hmcell num" style={heatCellStyle(liveRow.movePct)}>{liveRow.movePct != null ? `${liveRow.movePct > 0 ? "+" : ""}${liveRow.movePct.toFixed(1)}` : "—"}</span>
                    <span className="hmcell num" style={heatCellStyle((liveRow.surge ?? 1) - 1)}>{liveRow.surge != null ? liveRow.surge.toFixed(1) : "—"}</span>
                    <span className="hmcell num" style={heatCellStyle(liveRow.hodBreak ? 2 : liveRow.lodBreak ? -2 : 0)}>{liveRow.hodBreak ? "HOD" : liveRow.lodBreak ? "LOD" : "—"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function clockFromLoop(session: string): string {
  if (session === "premarket") return "Pre 4:00–9:30";
  if (session === "regular") return "RTH 9:30–4:00";
  if (session === "afterhours") return "AH until 8 PM";
  return "Closed";
}

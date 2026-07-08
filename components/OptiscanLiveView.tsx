"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ConvictionRing } from "@/components/ui/ConvictionRing";
import { Panel } from "@/components/ui/Panel";
import { SignalCard } from "@/components/ui/SignalCard";
import { StatTile } from "@/components/ui/StatTile";
import { TrackingRow } from "@/components/ui/TrackingRow";
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
  const [trackingAlerts, setTrackingAlerts] = useState<any[]>([]);
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
        const tracking = productAlerts
          .filter((a) => a.status === "tracking")
          .sort((a, b) => b.id - a.id)
          .slice(0, 8);
        if (!cancelled) setTrackingAlerts(tracking);
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
  const heroBear = scope === "options"
    ? (heroSide === "put" || (optionsOpeningWatch && openingSide === "put"))
    : stockSide === "SHORT";
  const trackingList = trackingAlerts.length ? trackingAlerts : settled.slice(0, 6);
  const heroLive = Boolean(
    (scope === "options" && optionsActive && heroAlert && heroVerdict?.action === "TRADE")
    || (scope === "market" && marketActive && heroAlert),
  );

  return (
    <div className={`axiom-live chrome-live${readingHold ? " reading-hold" : ""}${liveSession === "closed" ? " session-closed" : ""}`}>
      <div className="axiom-scan-sweep" aria-hidden />

      <div className="product-bar" aria-label="Scanner product">
        <div className="product-tabs">
          <button type="button" className={scope === "options" ? "on" : ""} onClick={() => { setScope("options"); saveDashboardPrefs({ liveScope: "options" }); }}>
            <span>Options</span><small>Opening watch 4:00–9:30 · live 9:30–4:00</small>
          </button>
          <button type="button" className={scope === "market" ? "on" : ""} onClick={() => { setScope("market"); saveDashboardPrefs({ liveScope: "market" }); }}>
            <span>Market</span><small>Shares · 4:00 AM–8:00 PM ET</small>
          </button>
        </div>
        <div className={`product-session ${marketActive ? "live" : "closed"}`}>
          <span className="product-session-dot" />{sessionLabel}
        </div>
      </div>

      <div className="axiom-hero-row">
        <SignalCard
          bear={heroBear}
          live={heroLive}
          kicker={
            scope === "options" && optionsActive && heroAlert && heroVerdict?.action === "TRADE"
              ? <>The callout · {new Date(heroAlert.alert_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} · still valid</>
              : scope === "options" && optionsOpeningWatch
                ? <>Opening watch · premarket · not executable yet</>
                : scope === "market" && marketActive && heroAlert
                  ? <>Share momentum · {stockSession}</>
                  : <>Waiting for the next {scope === "options" ? "0DTE BUY" : "SHARE CALLOUT"}</>
          }
          action={
            scope === "options" && optionsActive && heroAlert && heroVerdict?.action === "TRADE"
              ? <>BUY {heroSide.toUpperCase()}</>
              : scope === "options" && optionsOpeningWatch && openingCandidate
                ? <>WATCH {openingSide.toUpperCase()}</>
                : scope === "market" && marketActive && heroAlert
                  ? <>{stockSideLabel}</>
                  : <>{marketActive ? "SCANNING" : "CLOSED"}</>
          }
          contract={
            scope === "options" && optionsActive && heroAlert && heroVerdict?.action === "TRADE"
              ? <>{heroAlert.ticker} ${heroAlert.strike} {heroSide} · {heroAlert.dte ?? 0}DTE</>
              : scope === "options" && optionsOpeningWatch && openingCandidate
                ? <>{openingCandidate.symbol} · premarket bias</>
                : scope === "market" && marketActive && heroAlert
                  ? <>{heroAlert.ticker} shares</>
                  : <>{scope === "options" ? "0DTE desk" : "Share momentum desk"}</>
          }
          reason={
            scope === "options" && optionsActive && heroAlert && heroVerdict?.action === "TRADE"
              ? heroVerdict.reason
              : scope === "options" && optionsOpeningWatch && openingCandidate
                ? <>Premarket {fmtPct(openingCandidate.movePct)} · speed {openingCandidate.shortRate != null ? `${openingCandidate.shortRate.toFixed(2)}%/min` : "—"} · contracts validate at 9:30</>
                : scope === "market" && marketActive && heroAlert
                  ? heroAlert.ai_explanation ?? heroAlert.private_label ?? "Clean directional tape with share-volume confirmation."
                  : productNote
          }
          footer={
            <>
              <div className="convbar"><div className="convfill" style={{ width: `${conviction}%` }} /></div>
              <div className="sigmeta">
                {scope === "options" && heroAlert && heroVerdict?.action === "TRADE" ? (
                  <>
                    <div className="mm"><div className="mmk">Entry</div><div className="mmv num">{heroAlert.entry_mid != null ? `$${Number(heroAlert.entry_mid).toFixed(2)}` : "—"}</div></div>
                    <div className="mm"><div className="mmk">Spread</div><div className="mmv num">{heroAlert.entry_spread_pct != null ? `${Number(heroAlert.entry_spread_pct).toFixed(1)}%` : "—"}</div></div>
                    <div className="mm"><div className="mmk">Delta</div><div className="mmv num">{heroAlert.entry_delta != null ? Number(heroAlert.entry_delta).toFixed(2) : "—"}</div></div>
                    <div className="mm"><div className="mmk">Speed</div><div className="mmv num">{heroAlert.short_rate_at_alert != null ? `${heroAlert.short_rate_at_alert > 0 ? "+" : ""}${heroAlert.short_rate_at_alert.toFixed(2)}%/m` : "—"}</div></div>
                  </>
                ) : scope === "market" && heroAlert ? (
                  <>
                    <div className="mm"><div className="mmk">Entry</div><div className="mmv num">{entryLow != null && entryHigh != null ? `$${entryLow.toFixed(2)}–${entryHigh.toFixed(2)}` : "—"}</div></div>
                    <div className="mm"><div className="mmk">Speed</div><div className="mmv num">{heroAlert.short_rate_at_alert != null ? `${heroAlert.short_rate_at_alert > 0 ? "+" : ""}${heroAlert.short_rate_at_alert.toFixed(2)}%/m` : "—"}</div></div>
                    <div className="mm"><div className="mmk">Volume</div><div className="mmv num">{heroAlert.volume_surge_at_alert != null ? `${heroAlert.volume_surge_at_alert.toFixed(1)}×` : "—"}</div></div>
                  </>
                ) : null}
              </div>
              <p className="gates" style={{ marginTop: 10 }}>Every gate passed — <b>speed</b> · <b>volume</b> · <b>trend</b> · <b>fillable</b></p>
            </>
          }
        />

        <div className="axiom-hero-ring">
          <ConvictionRing value={conviction} bear={heroBear} label="TODAY" />
          <div className="axiom-today">Scoreline · {tradingDay()}</div>
        </div>

        <Panel title="Live tracking" meta={`${trackingList.length} open`} live>
          {trackingList.length ? trackingList.map((a) => {
            const ret = scope === "market" ? (a.latest_max_move ?? a.move_5m ?? a.eod_move) : a.option_return_pct;
            const bear = a.trade_bias === "stock_short_candidate" || a.direction === "bearish" || String(a.option_side ?? "").toLowerCase().startsWith("p");
            const cp = checkpointMeta(a.alert_time);
            return (
              <TrackingRow
                key={a.id}
                tag={bear ? (scope === "market" ? "SHORT" : "PUT") : (scope === "market" ? "LONG" : "CALL")}
                tagTone={bear ? "bear" : "bull"}
                symbol={a.ticker}
                sub={new Date(a.alert_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}
                pnl={ret != null ? `${ret > 0 ? "+" : ""}${Math.round(ret)}%` : "open"}
                pnlTone={ret != null && ret > 0 ? "g" : ret != null ? "r" : ""}
                win={ret != null && ret > 0}
                loss={ret != null && ret < 0}
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
          <StatTile key={s.k} label={s.k} value={s.v} hint={s.s} />
        ))}
      </div>

      <div className="section-head scanner-head">
        <span className="section-title">Scanners</span>
        <span className="section-head-actions">
          <span className="section-note">{productNote} · {holdNote}</span>
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
            <h3>{col.title}</h3>
            <ul>
              {col.rows.map((r) => {
                const liveRow = rowMap.get(r.symbol) ?? r;
                return (
                  <li
                    key={r.symbol}
                    onClick={() => onOpenChart?.(r.symbol)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && onOpenChart?.(r.symbol)}
                  >
                    <span className="sym">{r.symbol}</span>
                    <span className="why" dangerouslySetInnerHTML={{ __html: readingHold ? whyLine(r, scope) : whyLine(liveRow, scope) }} />
                    <span className={`m num ${pctClass(liveRow.movePct)}`}>
                      <TickValue value={liveRow.movePct} minDelta={0.08}>{fmtPct(liveRow.movePct)}</TickValue>
                      <small>{liveRow.price != null ? `$${liveRow.price.toFixed(2)}` : "—"}</small>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="section-head">
        <span className="section-title">Recent callouts</span>
        <span className="section-note">Newest first · today&apos;s {scope === "market" ? "share" : "options"} signals</span>
      </div>
      <ul className="ledger axiom-ledger">
        {settled.length ? settled.map((a) => {
          const ret = scope === "market" ? (a.latest_max_move ?? a.move_5m ?? a.eod_move) : a.option_return_pct;
          const side = String(a.option_side ?? "").toLowerCase().startsWith("p") ? "put" : "call";
          const sess = a.session === "afterhours" ? "AH" : a.session === "premarket" ? "Pre" : a.session === "regular" ? "RTH" : "";
          return (
            <li key={a.id}>
              <span className="t num">{new Date(a.alert_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}{sess ? ` · ${sess}` : ""}</span>
              <span className="what">
                {scope === "market"
                  ? `${uiDirectiveLabel(a.trade_bias === "stock_short_candidate" || a.direction === "bearish" ? "short" : "long", languageMode)}${languageMode === "public" ? " · " : " "}${a.ticker}${languageMode === "public" ? "" : " shares"}`
                  : a.capture_action === "TRADE"
                    ? languageMode === "public"
                      ? `Signal: ${a.ticker} $${a.strike} ${side}`
                      : `Bought the ${a.ticker} $${a.strike} ${side}`
                    : `Watched ${a.ticker}`}
                <small>{a.ai_explanation?.slice(0, 80) ?? "scanner callout"}</small>
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

function checkpointMeta(alertTime: string): { label: string; pct: number } {
  const start = Date.parse(alertTime);
  if (!Number.isFinite(start)) return { label: "open", pct: 0 };
  const mins = (Date.now() - start) / 60_000;
  if (mins < 5) return { label: "5m checkpoint", pct: Math.min(100, (mins / 5) * 100) };
  if (mins < 15) return { label: "15m checkpoint", pct: Math.min(100, ((mins - 5) / 10) * 100) };
  if (mins < 30) return { label: "30m checkpoint", pct: Math.min(100, ((mins - 15) / 15) * 100) };
  if (mins < 60) return { label: "1h checkpoint", pct: Math.min(100, ((mins - 30) / 30) * 100) };
  return { label: "EOD track", pct: 100 };
}

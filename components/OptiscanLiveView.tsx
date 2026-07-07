"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useScannerStream } from "@/hooks/useScannerStream";
import { scanHeaders } from "@/hooks/useScanner";
import { useStableSymbolOrder } from "@/lib/stable-order";
import { applyFastFilterHysteresis } from "@/lib/tape-filter-hysteresis";
import { tickDirection } from "@/lib/tick-flash";
import { computeWatchScore, sortTape, type TapeRow } from "@/lib/watch-score";
import { MIN_SPEED_PCT_PER_MIN, frozenCalloutVerdict } from "@/lib/trade-verdict";
import { fmtPct, pctClass } from "@/lib/format";
import { tradingDay } from "@/lib/trading-session";
import { liveCtxFor, useLiveTapeMap } from "@/hooks/useLiveTapeMap";

const HOT_LINGER_MS = 20_000;

function TickValue({ value, children, className = "" }: { value: number | null | undefined; children: React.ReactNode; className?: string }) {
  const prev = useRef(value);
  const [flash, setFlash] = useState("");
  useEffect(() => {
    const dir = tickDirection(value, prev.current);
    prev.current = value;
    if (!dir) return;
    setFlash(dir === "up" ? "live up" : "live dn");
    const t = setTimeout(() => setFlash(""), 650);
    return () => clearTimeout(t);
  }, [value]);
  return <span className={`num ${flash} ${className}`.trim()}>{children}</span>;
}

function isHotExtended(r: TapeRow): boolean {
  return Math.abs(r.shortRate ?? 0) >= 0.2 && (r.surge ?? 0) >= 1.4 && (r.efficiency == null || r.efficiency >= 0.35);
}

type Scope = "market" | "options";

function whyLine(r: TapeRow, scope: Scope): string {
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

export function OptiscanLiveView({ onOpenChart, onLoopStatus }: {
  onOpenChart?: (symbol: string) => void;
  onLoopStatus?: (running: boolean) => void;
}) {
  const [scope, setScope] = useState<Scope>("market");
  const [hovering, setHovering] = useState(false);
  const [heroAlert, setHeroAlert] = useState<any | null>(null);
  const [settled, setSettled] = useState<any[]>([]);
  const hotSince = useRef(new Map<string, number>());
  const fastFilterState = useRef(new Map<string, { inList: boolean; pendingSince: number | null }>());
  const { realtime: loop } = useScannerStream();
  const tapeMap = useLiveTapeMap(1000);
  const tape = (loop?.tape ?? loop?.movers ?? []) as TapeRow[];

  useEffect(() => { onLoopStatus?.(Boolean(loop?.running)); }, [loop?.running, onLoopStatus]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/alerts?date=${tradingDay()}&limit=80`, { cache: "no-store", headers: scanHeaders() });
        const d = await res.json();
        const now = Date.now();
        const alerts = (d.alerts ?? []) as any[];
        const trades = alerts.filter((a) => a.capture_action === "TRADE" && a.asset_class !== "stock");
        trades.sort((a, b) => b.id - a.id);
        const fresh = trades.find((a) => {
          const t = Date.parse(a.alert_time ?? "");
          return Number.isFinite(t) && now - t < 5 * 60_000;
        });
        if (!cancelled) setHeroAlert(fresh ?? trades[0] ?? null);
        const earlier = alerts.filter((a) => {
          const t = Date.parse(a.alert_time ?? "");
          return Number.isFinite(t) && now - t > 15 * 60_000;
        }).slice(0, 8);
        if (!cancelled) setSettled(earlier);
      } catch { /* best effort */ }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const rows = useMemo(() => {
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
    return sortTape(list, "speed", -1).slice(0, 60);
  }, [tape]);

  const holdList = hovering;
  const stableSymbols = useStableSymbolOrder(
    rows.map((r) => r.symbol),
    { paused: holdList, intervalMs: 12000, resetKey: scope },
  );
  const rowMap = useMemo(() => new Map(rows.map((r) => [r.symbol, r])), [rows]);
  const fullMap = useMemo(() => new Map(tape.map((r) => [r.symbol, r])), [tape]);
  const displayRows = useMemo(
    () => stableSymbols.map((s) => rowMap.get(s) ?? (holdList ? fullMap.get(s) : undefined)).filter(Boolean) as TapeRow[],
    [stableSymbols, rowMap, fullMap, holdList],
  );

  const columns = useMemo(() => {
    const bySpeed = [...displayRows].sort((a, b) => Math.abs(b.shortRate ?? 0) - Math.abs(a.shortRate ?? 0)).slice(0, 5);
    const bySurge = [...displayRows].sort((a, b) => (b.surge ?? 0) - (a.surge ?? 0)).slice(0, 5);
    const byLevel = displayRows.filter((r) => r.hodBreak || r.lodBreak).slice(0, 5);
    if (scope === "options") {
      return [
        { title: "Unusual volume vs OI", rows: bySurge },
        { title: "Premium sweeps", rows: bySpeed },
        { title: "Best entries now", rows: bySpeed.filter((r) => computeWatchScore(r) >= 70).concat(bySpeed).slice(0, 5) },
      ];
    }
    return [
      { title: "Fastest right now", rows: bySpeed },
      { title: "Volume surges", rows: bySurge },
      { title: "Level breaks", rows: byLevel.length ? byLevel : bySpeed.slice(0, 3) },
    ];
  }, [displayRows, scope]);

  const heroVerdict = heroAlert ? frozenCalloutVerdict(heroAlert, liveCtxFor(tapeMap, heroAlert.ticker)) : null;
  const heroSide = String(heroAlert?.option_side ?? "").toLowerCase().startsWith("p") ? "put" : "call";
  const heroCls = heroSide === "put" ? "dn" : "up";

  const strip = useMemo(() => {
    if (scope === "options") {
      const puts = displayRows.filter((r) => (r.shortRate ?? 0) < 0).length;
      const calls = displayRows.length - puts;
      return [
        { k: "Put / call flow", v: puts > 0 ? (puts / Math.max(calls, 1)).toFixed(2) : "—", s: puts > calls ? "puts dominating" : "mixed" },
        { k: "Hot names", v: displayRows.length, s: "on core + extended" },
        { k: "Avg speed", v: displayRows[0]?.shortRate != null ? `${Math.abs(displayRows[0].shortRate!).toFixed(2)}%/m` : "—", s: "fastest tape" },
        { k: "0DTE universe", v: loop?.coreSymbols ?? tape.length, s: "symbols scanned" },
      ];
    }
    const green = displayRows.filter((r) => (r.movePct ?? 0) > 0).length;
    return [
      { k: "Movers tracked", v: displayRows.length, s: "core + hot extended" },
      { k: "Breadth", v: displayRows.length ? Math.round((green / displayRows.length) * 100) : 0, s: "% green in list" },
      { k: "Top speed", v: displayRows[0]?.shortRate != null ? `${displayRows[0].shortRate!.toFixed(2)}%/m` : "—", s: displayRows[0]?.symbol ?? "—" },
      { k: "Loop", v: loop?.running ? "LIVE" : "OFF", s: loop?.session ?? "—" },
    ];
  }, [scope, displayRows, loop, tape.length]);

  return (
    <div className="chrome-live">
      <section className="callout">
        {heroAlert && heroVerdict?.action === "TRADE" ? (
          <>
            <p className="callout-kicker">
              The callout · {new Date(heroAlert.alert_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} · <b>still valid</b>
            </p>
            <h1 className="callout-say">
              Buy the <span className={heroCls}>{heroAlert.ticker}&nbsp;${heroAlert.strike}&nbsp;{heroSide}</span>
            </h1>
            <p className="callout-why">{heroVerdict.reason}</p>
            <div className="ticket">
              <div><span className="k">Contract</span><span className="v">{heroAlert.ticker} ${heroAlert.strike}{heroSide[0].toUpperCase()} · {heroAlert.dte ?? 0}DTE</span></div>
              <div><span className="k">Mid</span><TickValue value={null} className="v">—</TickValue></div>
              <div><span className="k">Speed</span><span className="v num">{heroAlert.short_rate_at_alert != null ? `${heroAlert.short_rate_at_alert > 0 ? "+" : ""}${heroAlert.short_rate_at_alert.toFixed(2)}%/min` : "—"}</span></div>
            </div>
            <p className="gates">Every gate passed — <b>speed</b> · <b>volume</b> · <b>trend</b> · <b>fillable</b></p>
          </>
        ) : (
          <>
            <p className="callout-kicker">Waiting for the next <b>BUY</b></p>
            <h1 className="callout-say">Nothing firing yet — tape is live</h1>
            <p className="callout-why">When a TRADE clears every gate, the ticket lands here first. Research signals only — not financial advice.</p>
          </>
        )}
      </section>

      <div className="section-head">
        <span className="section-title">Scanners</span>
        <span style={{ display: "flex", alignItems: "center", gap: "1.2rem" }}>
          <span className="section-note">{hovering ? "Holding while you read — prices still live" : "Live · hover to hold · click any name for its chart"}</span>
          <span className="seg">
            <button type="button" className={scope === "market" ? "on" : ""} onClick={() => setScope("market")}>Market</button>
            <button type="button" className={scope === "options" ? "on" : ""} onClick={() => setScope("options")}>Options</button>
          </span>
        </span>
      </div>

      <div className="strip" onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
        {strip.map((s) => (
          <div key={s.k}>
            <div className="k">{s.k}</div>
            <div className="v num">{s.v}</div>
            <div className="d">{s.s}</div>
          </div>
        ))}
      </div>

      <div className="scanners" onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
        {columns.map((col) => (
          <div className="scanner" key={col.title}>
            <h3>{col.title}</h3>
            <ul>
              {col.rows.map((r) => (
                <li key={r.symbol} onClick={() => onOpenChart?.(r.symbol)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpenChart?.(r.symbol)}>
                  <span className="sym">{r.symbol}</span>
                  <span className="why" dangerouslySetInnerHTML={{ __html: whyLine(r, scope) }} />
                  <span className={`m num ${pctClass(r.movePct)}`}>
                    <TickValue value={r.movePct}>{fmtPct(r.movePct)}</TickValue>
                    <small>{r.price != null ? `$${r.price.toFixed(2)}` : "—"}</small>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="section-head">
        <span className="section-title">Earlier today</span>
        <span className="section-note">Settled — never moves</span>
      </div>
      <ul className="ledger">
        {settled.length ? settled.map((a) => {
          const ret = a.option_return_pct;
          const side = String(a.option_side ?? "").toLowerCase().startsWith("p") ? "put" : "call";
          return (
            <li key={a.id}>
              <span className="t num">{new Date(a.alert_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}</span>
              <span className="what">
                {a.capture_action === "TRADE" ? `Bought the ${a.ticker} $${a.strike} ${side}` : `Watched ${a.ticker}`}
                <small>{a.ai_explanation?.slice(0, 80) ?? "scanner callout"}</small>
              </span>
              <span className={`res num ${ret != null && ret > 0 ? "pos" : ret != null ? "neg" : "open"}`}>
                {ret != null ? `${ret > 0 ? "+" : ""}${Math.round(ret)}%` : "open"}
              </span>
            </li>
          );
        }) : (
          <li><span className="t">—</span><span className="what muted">No settled callouts yet today</span><span className="res open">waiting</span></li>
        )}
      </ul>

      <p className="foot" style={{ marginTop: "4rem", maxWidth: 640, color: "var(--muted)", fontSize: ".72rem" }}>
        Research signals, never orders. Not financial advice. · <Link href="/alerts" className="chrome-link" style={{ display: "inline" }}>Alerts dashboard</Link>
      </p>
    </div>
  );
}

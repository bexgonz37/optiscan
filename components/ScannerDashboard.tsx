"use client";

/**
 * Scanner Dashboard — simplified ranked watchlist for the Live page.
 * Default: 6 columns. "Show details" reveals RVOL, volume, surge, VWAP, levels.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { TickerIcon, ScoreBar } from "@/components/ui";
import { changeColor, fmtPct, fmtPrice } from "@/lib/format";
import {
  computeWatchScore,
  sortTape,
  type TapeRow,
  type WatchSortKey,
} from "@/lib/watch-score";
import { useStableSymbolOrder } from "@/lib/stable-order";
import { MIN_SPEED_PCT_PER_MIN } from "@/lib/trade-verdict";

type FilterKey = "all" | "fast";

function dirChip(d: string) {
  if (d === "bullish") return <span className="dir-bull">▲</span>;
  if (d === "bearish") return <span className="dir-bear">▼</span>;
  return <span className="dir-chop">◆</span>;
}

function fmtVol(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}

export function ScannerDashboard({
  onOpenChart,
  onLoopStatus,
}: {
  onOpenChart?: (symbol: string) => void;
  onLoopStatus?: (running: boolean) => void;
}) {
  const [tape, setTape] = useState<TapeRow[]>([]);
  const [loop, setLoop] = useState<any>(null);
  const [sortKey, setSortKey] = useState<WatchSortKey>("watch");
  const [sortDir, setSortDir] = useState<-1 | 1>(-1);
  const [filter, setFilter] = useState<FilterKey>("fast");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [agoText, setAgoText] = useState("");
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/scanner/live?realtimeOnly=1", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d?.ok) {
        setTape((d.realtime?.tape ?? d.realtime?.movers ?? []) as TapeRow[]);
        setLoop(d.realtime);
        setUpdatedAt(Date.now());
        onLoopStatus?.(Boolean(d.realtime?.running));
      }
    } catch { /* best effort */ }
    finally { inFlight.current = false; }
  }, [onLoopStatus]);

  useEffect(() => {
    if (paused) return;
    poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [poll, paused]);

  useEffect(() => {
    const tick = () => {
      if (updatedAt == null) { setAgoText(""); return; }
      const ago = Math.round((Date.now() - updatedAt) / 1000);
      setAgoText(ago > 3 ? `updated ${ago}s ago` : "live · 1s refresh");
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [updatedAt]);

  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    let list = [...tape];
    if (q) list = list.filter((r) => r.symbol.includes(q));
    if (filter === "fast") list = list.filter((r) => Math.abs(r.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN);
    return sortTape(list, sortKey, sortDir).slice(0, 60);
  }, [tape, filter, query, sortKey, sortDir]);

  const stableSymbols = useStableSymbolOrder(
    rows.map((r) => r.symbol),
    { paused, intervalMs: 5000, resetKey: `${filter}:${sortKey}:${sortDir}:${query}` },
  );
  const rowMap = useMemo(() => new Map(rows.map((r) => [r.symbol, r])), [rows]);
  const displayRows = useMemo(
    () => stableSymbols.map((s) => rowMap.get(s)).filter(Boolean) as TapeRow[],
    [stableSymbols, rowMap],
  );

  function toggleSort(k: WatchSortKey) {
    if (sortKey === k) setSortDir((d) => (d === -1 ? 1 : -1));
    else { setSortKey(k); setSortDir(-1); }
  }

  const Th = ({ k, label, title }: { k: WatchSortKey; label: string; title?: string }) => (
    <th className={sortKey === k ? "sorted" : ""} onClick={() => toggleSort(k)} title={title}>
      {label}{sortKey === k ? <span className="arrow">{sortDir < 0 ? "▼" : "▲"}</span> : null}
    </th>
  );

  const chip = (id: FilterKey, label: string) => (
    <button
      type="button"
      className={`pill btn${filter === id ? " btn-primary" : ""}`}
      style={{ fontSize: 11, padding: "4px 10px" }}
      onClick={() => setFilter(id)}
    >
      {label}
    </button>
  );

  return (
    <section className="panel main section-scanner-dash">
      <div className="section-header">
        <div>
          <h2 className="section-title">What&apos;s moving</h2>
          <p className="section-sub">
            Ranked by score — how hot each ticker is right now. Rows reorder every ~5s; hit Pause to freeze.
          </p>
        </div>
        <div className="status-group">
          <span className={`status-dot ${loop?.running && !paused ? "live" : ""}`} />
          <span className="status-text">
            {paused ? "Paused" : loop?.running ? `${tape.length} symbols${agoText ? ` · ${agoText}` : ""}` : "Loop offline"}
          </span>
        </div>
      </div>

      <div className="scanner-toolbar">
        <div className="search search-inline" style={{ flex: 1, maxWidth: 220 }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter ticker" />
        </div>
        <div className="mover-filters">
          {chip("fast", "Moving now")}
          {chip("all", "All")}
          <button
            type="button"
            className={`pill btn${paused ? " btn-primary" : ""}`}
            style={{ fontSize: 11, padding: "4px 10px" }}
            onClick={() => setPaused((v) => !v)}
            title="Freeze the table while you read"
          >
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button
            type="button"
            className={`pill btn${showDetails ? " btn-primary" : ""}`}
            style={{ fontSize: 11, padding: "4px 10px" }}
            onClick={() => setShowDetails((v) => !v)}
            title="Show RVOL, volume, VWAP, and level breaks"
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
        </div>
      </div>

      <div className="table-area">
      {!displayRows.length ? (
        <div className="empty table-empty">
          <div className="big">{loop?.running ? (filter === "fast" ? "Nothing moving fast right now" : "Warming up tape…") : "Scanner offline"}</div>
          {loop?.running
            ? (filter === "fast" ? "That's normal in quiet stretches — click All to see the full list." : "Symbols appear once the loop has a few seconds of data.")
            : "Start during market hours."}
        </div>
      ) : (
        <div className="tablewrap scanner-table">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <Th k="symbol" label="Ticker" />
                <Th k="watch" label="Score" title="How hot this ticker is right now, 0–100" />
                <th title="Price direction right now">Direction</th>
                <Th k="move" label="Today %" title="Day's percent change" />
                <Th k="speed" label="Speed" title="How fast price is moving per minute" />
                {showDetails ? (
                  <>
                    <Th k="rvol" label="RVOL" title="Volume vs normal today" />
                    <Th k="volume" label="Volume" />
                    <th title="Volume burst in the last minute">Vol surge</th>
                    <Th k="vwap" label="VWAP" title="Distance from volume-weighted average price" />
                    <th title="High or low of day break">Level</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((r, i) => {
                const watch = computeWatchScore(r);
                return (
                  <tr key={r.symbol} className="clickable" onClick={() => onOpenChart?.(r.symbol)} title="Open chart">
                    <td className="num muted">{i + 1}</td>
                    <td>
                      <div className="tkr">
                        <TickerIcon symbol={r.symbol} />
                        <div>
                          <div className="tname">{r.symbol}</div>
                          <div className="tsub">{fmtPrice(r.price)}</div>
                        </div>
                      </div>
                    </td>
                    <td><ScoreBar score={watch} /></td>
                    <td>
                      <span className={`stock-dir stock-dir-${r.direction}`} title={r.direction === "bullish" ? "Moving up" : r.direction === "bearish" ? "Moving down" : "Choppy"}>
                        {dirChip(r.direction)}
                        <span className="stock-dir-label">
                          {r.direction === "bullish" ? "Up" : r.direction === "bearish" ? "Down" : "—"}
                        </span>
                      </span>
                    </td>
                    <td className="num" style={{ color: changeColor(r.movePct) }}>{fmtPct(r.movePct)}</td>
                    <td className="num" style={{ fontWeight: Math.abs(r.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN ? 700 : 400 }}>
                      {r.shortRate != null ? `${r.shortRate > 0 ? "+" : ""}${r.shortRate.toFixed(2)}%/m` : "—"}
                    </td>
                    {showDetails ? (
                      <>
                        <td className="num">{r.relVol != null ? `${r.relVol.toFixed(1)}x` : "—"}</td>
                        <td className="num muted">{fmtVol(r.volume)}</td>
                        <td className="num">{r.surge != null ? `${r.surge.toFixed(1)}x` : "—"}</td>
                        <td className={r.aboveVwap == null ? "dim" : r.aboveVwap ? "pos" : "neg"} style={{ fontSize: 12 }}>
                          {r.vwapDistPct != null ? `${r.vwapDistPct > 0 ? "+" : ""}${r.vwapDistPct.toFixed(2)}%` : r.aboveVwap == null ? "—" : r.aboveVwap ? "Above" : "Below"}
                        </td>
                        <td>
                          {r.hodBreak ? <span className="tag t-call">HOD</span> : r.lodBreak ? <span className="tag t-put">LOD</span> : "—"}
                        </td>
                      </>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </section>
  );
}

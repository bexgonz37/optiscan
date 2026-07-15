"use client";

/**
 * Scanner Dashboard — simplified ranked watchlist for the Live page.
 * Default: 6 columns. "Show details" reveals RVOL, volume, surge, VWAP, levels.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScannerStream } from "@/hooks/useScannerStream";
import { ScoreBar } from "@/components/ui";
import { TickerWithSparkline } from "@/components/TickerSparkline";
import { useSparklines } from "@/hooks/useSparklines";
import { changeColor, fmtPct, fmtPrice, pctClass } from "@/lib/format";
import {
  computeWatchScore,
  sortTape,
  type TapeRow,
  type WatchSortKey,
} from "@/lib/watch-score";
import { useStableSymbolOrder } from "@/lib/stable-order";
import { MIN_SPEED_PCT_PER_MIN } from "@/lib/trade-verdict";
import { applyFastFilterHysteresis } from "@/lib/tape-filter-hysteresis";

type FilterKey = "core" | "all" | "fast";

/** Robinhood-style tick: value updates in place with a brief up/down flash so
 * the eye can track WHAT changed instead of the whole table repainting. */
function TickValue({ value, children }: { value: number | null | undefined; children: React.ReactNode }) {
  const prev = useRef<number | null | undefined>(value);
  const [cls, setCls] = useState("");
  useEffect(() => {
    const was = prev.current;
    prev.current = value;
    if (value == null || was == null || value === was) return;
    setCls(value > was ? "tick-up" : "tick-down");
    const t = setTimeout(() => setCls(""), 650);
    return () => clearTimeout(t);
  }, [value]);
  return <span className={`tick ${cls}`}>{children}</span>;
}

/** How long a hot extended-universe name lingers after cooling off — rows
 * leaving the instant they dip under the bar is what made the list churn. */
const HOT_LINGER_MS = 20_000;

/** Extended-universe rows only surface on the default view when genuinely
 * hot — matching the TRADE trigger gates so discovery names never clutter. */
function isHotExtended(r: TapeRow): boolean {
  const speed = Math.abs(r.shortRate ?? 0);
  const surge = r.surge ?? 0;
  const eff = r.efficiency;
  return speed >= 0.2 && surge >= 1.4 && (eff == null || eff >= 0.35);
}

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

function momentumClassLabel(classification?: string | null): string | null {
  switch (classification) {
    case "FRESH_ACCELERATION": return "Fresh acceleration";
    case "CONTINUATION": return "Continuation";
    case "SLOW_GRINDER": return "Slow grinder";
    case "LATE_EXHAUSTION": return "Late exhaustion";
    case "NOISY_ILLIQUID_SPIKE": return "Noisy/illiquid";
    default: return null;
  }
}

export function ScannerDashboard({
  onOpenChart,
  onLoopStatus,
}: {
  onOpenChart?: (symbol: string) => void;
  onLoopStatus?: (running: boolean) => void;
}) {
  const [sortKey, setSortKey] = useState<WatchSortKey>("watch");
  const [sortDir, setSortDir] = useState<-1 | 1>(-1);
  const [filter, setFilter] = useState<FilterKey>("core");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [hovering, setHovering] = useState(false);
  const hotSince = useRef(new Map<string, number>());
  const [showDetails, setShowDetails] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { realtime: loop, lastEventAt: updatedAt, freshness, transport } = useScannerStream();
  const tape = (loop?.tape ?? loop?.movers ?? []) as TapeRow[];
  const [agoText, setAgoText] = useState("");
  const fastFilterState = useRef(new Map<string, { inList: boolean; pendingSince: number | null }>());
  const onLoopStatusRef = useRef(onLoopStatus);
  onLoopStatusRef.current = onLoopStatus;

  useEffect(() => {
    onLoopStatusRef.current?.(Boolean(loop?.running));
  }, [loop?.running]);

  useEffect(() => {
    const tick = () => {
      if (updatedAt == null) { setAgoText(""); return; }
      const ago = Math.round((Date.now() - updatedAt) / 1000);
      const liveLabel = transport === "sse" ? "SSE live" : "poll live";
      setAgoText(ago > 3 ? `updated ${ago}s ago · ${transport}` : `${liveLabel} · ${freshness}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [updatedAt, transport, freshness]);

  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    const now = Date.now();
    let list = [...tape];
    if (q) list = list.filter((r) => r.symbol.includes(q));
    if (filter === "core") {
      // Default: the Core Watch list, plus extended names when hot — with a
      // linger window so a name that cools for a beat doesn't pop out.
      list = list.filter((r) => {
        if (r.core) return true;
        if (isHotExtended(r)) {
          hotSince.current.set(r.symbol, now);
          return true;
        }
        const last = hotSince.current.get(r.symbol);
        if (last != null && now - last < HOT_LINGER_MS) return true;
        hotSince.current.delete(r.symbol);
        return false;
      });
    } else if (filter === "fast") {
      list = applyFastFilterHysteresis(list, fastFilterState.current, Date.now());
    }
    return sortTape(list, sortKey, sortDir).slice(0, 60);
  }, [tape, filter, query, sortKey, sortDir]);

  // Reading = holding. Hovering freezes membership + order (Robinhood never
  // moves a row under your cursor); the values inside keep ticking live.
  const holdList = paused || hovering;

  const stableSymbols = useStableSymbolOrder(
    rows.map((r) => r.symbol),
    { paused: holdList, intervalMs: 12000, resetKey: `${filter}:${sortKey}:${sortDir}:${query}` },
  );
  const rowMap = useMemo(() => new Map(rows.map((r) => [r.symbol, r])), [rows]);
  // Fall back to the raw tape while holding: a symbol that leaves the filtered
  // set keeps its row (with live values) until the hold ends.
  const tapeMap = useMemo(() => new Map(tape.map((r) => [r.symbol, r])), [tape]);
  const displayRows = useMemo(
    () => stableSymbols.map((s) => rowMap.get(s) ?? (holdList ? tapeMap.get(s) : undefined)).filter(Boolean) as TapeRow[],
    [stableSymbols, rowMap, tapeMap, holdList],
  );
  const sparklines = useSparklines(displayRows.map((r) => r.symbol));

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
      className={`pill btn btn-xs${filter === id ? " btn-primary" : ""}`}
      onClick={() => setFilter(id)}
    >
      {label}
    </button>
  );

  return (
    <section className="panel main section-scanner-dash">
      <div className="section-header">
        <div>
          <h2 className="section-title">What&apos;s moving fast</h2>
          <p className="section-sub">
            0DTE options universe — ranked by speed. Click a row for live charts. Only names moving ≥0.15%/min.
          </p>
        </div>
        <div className="status-group">
          <span className={`status-dot ${loop?.running && !paused ? "live" : ""} stream-fresh-${freshness}`} />
          <span className="status-text">
            {paused
              ? "Paused"
              : hovering
                ? "Holding while you read — prices still live"
                : loop?.running
                  ? `Showing ${displayRows.length} movers · universe ${loop.coreSymbols ?? tape.length}${agoText ? ` · ${agoText}` : ""}`
                  : "Loop offline"}
          </span>
        </div>
      </div>

      <div className="scanner-toolbar">
        <div className="search search-inline search-narrow">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter or chart ticker"
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim()) onOpenChart?.(query.trim().toUpperCase());
            }}
          />
        </div>
        {query.trim() ? (
          <button
            type="button"
            className="pill btn btn-primary btn-xs"
            onClick={() => onOpenChart?.(query.trim().toUpperCase())}
          >
            Open chart
          </button>
        ) : null}
        <div className="mover-filters">
          {chip("core", "Core Watch")}
          {chip("fast", "Moving now")}
          {showAdvanced ? chip("all", "All") : null}
          <button
            type="button"
            className={`pill btn btn-xs${showAdvanced ? " btn-primary" : ""}`}
            onClick={() => setShowAdvanced((v) => !v)}
            title="Show full universe list"
          >
            {showAdvanced ? "Hide advanced" : "Advanced"}
          </button>
          <button
            type="button"
            className={`pill btn btn-xs${paused ? " btn-primary" : ""}`}
            onClick={() => setPaused((v) => !v)}
            title="Freeze the table while you read"
          >
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button
            type="button"
            className={`pill btn btn-xs${showDetails ? " btn-primary" : ""}`}
            onClick={() => setShowDetails((v) => !v)}
            title="Show RVOL, volume, VWAP, and level breaks"
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
        </div>
      </div>

      <div
        className="table-area"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
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
                <th aria-label="Chart" />
                {showDetails ? (
                  <>
                    <Th k="rvol" label="RVOL" title="Volume vs normal today" />
                    <Th k="volume" label="Volume" />
                    <th title="Volume burst in the last minute">Vol surge</th>
                    <th title="10s volume rate minus 60s volume rate">Vol accel</th>
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
                      <TickerWithSparkline
                        symbol={r.symbol}
                        price={r.price}
                        closes={sparklines[r.symbol]}
                        direction={r.direction}
                        sub={
                          <>
                            <TickValue value={r.price}>{fmtPrice(r.price)}</TickValue>
                            {momentumClassLabel(r.classification) ||
                            (r.catalystFresh && r.catalystType && r.catalystType !== "no_clear_catalyst") ||
                            r.haltStatus === "halted" ||
                            r.haltStatus === "resumed" ? (
                              <div className="tape-badges">
                                {momentumClassLabel(r.classification) ? (
                                  <span className="tag t-vol" title={r.dominantReason ?? "Momentum timing class"}>
                                    {momentumClassLabel(r.classification)}
                                  </span>
                                ) : null}
                                {r.catalystFresh && r.catalystType && r.catalystType !== "no_clear_catalyst" ? (
                                  <span className="tag t-vol" title="Fresh catalyst (&lt;30m)">
                                    {String(r.catalystType).replace(/_/g, " ")}
                                  </span>
                                ) : null}
                                {r.haltStatus === "halted" ? (
                                  <span className="tag t-put" title="Trading halt detected in news">HALT</span>
                                ) : r.haltStatus === "resumed" ? (
                                  <span className="tag t-call" title="Trading resumed">RESUME</span>
                                ) : null}
                              </div>
                            ) : null}
                          </>
                        }
                      />
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
                    <td className={`num ${pctClass(r.movePct)}`}>
                      <TickValue value={r.movePct}>{fmtPct(r.movePct)}</TickValue>
                    </td>
                    <td className={`num ${Math.abs(r.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN ? "fw-strong" : "fw-normal"}`}>
                      <TickValue value={r.shortRate}>
                        {r.shortRate != null ? `${r.shortRate > 0 ? "+" : ""}${r.shortRate.toFixed(2)}%/m` : "—"}
                      </TickValue>
                    </td>
                    <td onClick={(ev) => ev.stopPropagation()}>
                      <button type="button" className="pill btn btn-primary btn-xs" onClick={() => onOpenChart?.(r.symbol)}>
                        Chart
                      </button>
                    </td>
                    {showDetails ? (
                      <>
                        <td className="num">{r.relVol != null ? `${r.relVol.toFixed(1)}x` : "—"}</td>
                        <td className="num muted">{fmtVol(r.volume)}</td>
                        <td className="num">{r.surge != null ? `${r.surge.toFixed(1)}x` : "—"}</td>
                        <td className="num">{r.volumeAcceleration != null ? `${r.volumeAcceleration > 0 ? "+" : ""}${r.volumeAcceleration.toFixed(2)}` : "—"}</td>
                        <td className={`text-xs ${r.aboveVwap == null ? "dim" : r.aboveVwap ? "pos" : "neg"}`}>
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

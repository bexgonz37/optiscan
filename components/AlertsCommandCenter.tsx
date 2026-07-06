"use client";

/**
 * AlertsCommandCenter — the beginner-friendly "what do I do right now" view.
 *
 * One column, top to bottom:
 *   1. Hero card — the single best signal right now (big BUY CALL / BUY PUT,
 *      contract, live speed, Watch chart button).
 *   2. Right-now list — every live candidate in ONE ranked list: trades first,
 *      then setups still forming. SKIP rows are hidden unless asked for.
 *
 * Every verdict is recomputed against the live tape on every poll, so a
 * BUY CALL that stalls downgrades to WAIT in front of you.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import type { LiveTape, LiveTapeRow } from "@/hooks/useLiveTapeMap";
import { liveCtxFor } from "@/hooks/useLiveTapeMap";
import { TickerIcon } from "@/components/ui";
import { TradeVerdictHero } from "@/components/TradeVerdictHero";
import { computeTradeVerdict, MIN_SPEED_PCT_PER_MIN, type TradeVerdict } from "@/lib/trade-verdict";
import { changeColor, fmtPct, fmtPrice } from "@/lib/format";

interface Entry {
  symbol: string;
  tapeRow: LiveTapeRow | null;
  alert: any | null;
  verdict: TradeVerdict | null;
  /** 0 = TRADE, 1 = WAIT with contract, 2 = moving but no alert yet, 3 = SKIP/slow */
  rank: number;
}

function speedText(r: LiveTapeRow | null): string {
  if (r?.shortRate == null) return "—";
  return `${r.shortRate > 0 ? "+" : ""}${r.shortRate.toFixed(2)}%/min`;
}

export function AlertsCommandCenter({
  tape,
  onOpenChart,
}: {
  tape: LiveTape;
  onOpenChart?: (symbol: string) => void;
}) {
  const [alerts, setAlerts] = useState<Map<string, any>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const pollInFlight = useRef(false);

  const pollAlerts = useCallback(async () => {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(`/api/alerts?date=${today}&limit=100`, { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      const map = new Map<string, any>();
      for (const a of d.alerts ?? []) if (!map.has(a.ticker)) map.set(a.ticker, a);
      setAlerts(map);
    } catch { /* best effort */ }
    finally { pollInFlight.current = false; }
  }, []);

  useEffect(() => {
    pollAlerts();
    const id = setInterval(pollAlerts, 5000);
    return () => clearInterval(id);
  }, [pollAlerts]);

  const entries = useMemo<Entry[]>(() => {
    const symbols = new Set<string>([...tape.map.keys(), ...alerts.keys()]);
    const out: Entry[] = [];
    for (const symbol of symbols) {
      const tapeRow = tape.map.get(symbol) ?? null;
      const alert = alerts.get(symbol) ?? null;
      const live = liveCtxFor(tape, symbol);
      const verdict = alert ? computeTradeVerdict(alert, live) : null;
      const fast = Math.abs(tapeRow?.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN;
      let rank: number;
      if (verdict?.action === "TRADE") rank = 0;
      else if (verdict?.action === "WAIT") rank = 1;
      else if (!verdict && fast) rank = 2;
      else rank = 3;
      out.push({ symbol, tapeRow, alert, verdict, rank });
    }
    out.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.rank === 0) return (b.verdict?.confidence ?? 0) - (a.verdict?.confidence ?? 0);
      const sa = Math.abs(a.tapeRow?.shortRate ?? 0);
      const sb = Math.abs(b.tapeRow?.shortRate ?? 0);
      if (sb !== sa) return sb - sa;
      return a.symbol.localeCompare(b.symbol);
    });
    return out;
  }, [tape, alerts]);

  const visible = useMemo(
    () => (showAll ? entries : entries.filter((e) => e.rank < 3)).slice(0, 30),
    [entries, showAll],
  );

  const hero = useMemo(() => {
    if (selected) {
      const found = entries.find((e) => e.symbol === selected);
      if (found && found.verdict?.action !== "SKIP") return found;
    }
    const trade = entries.find((e) => e.verdict?.action === "TRADE");
    if (trade) return trade;
    const wait = entries.find((e) => e.verdict?.action === "WAIT" && e.alert);
    if (wait) return wait;
    return null;
  }, [entries, selected]);

  function pick(symbol: string) {
    setSelected(symbol);
    onOpenChart?.(symbol);
  }

  const heroLive = hero ? liveCtxFor(tape, hero.symbol) : undefined;
  const heroTape = hero?.tapeRow ?? null;
  const tradeCount = entries.filter((e) => e.rank === 0).length;

  return (
    <section className="panel main section-live">
      <div className="section-header">
        <div>
          <h2 className="section-title">Right now</h2>
          <p className="section-sub">
            One list, best first. BUY only shows when the stock is moving the right way at this moment.
          </p>
        </div>
        <div className="status-group">
          <span className={`status-dot ${tape.running ? "live" : ""}`} />
          <span className="status-text">
            {tape.running ? (tradeCount ? `${tradeCount} live trade signal${tradeCount === 1 ? "" : "s"}` : "Watching — no trade yet") : "Scanner offline"}
          </span>
        </div>
      </div>

      {/* Hero: the one signal to look at */}
      {hero?.alert ? (
        <div className="acc-hero">
          <div className="acc-hero-main">
            <div className="acc-hero-symbol">
              <TickerIcon symbol={hero.symbol} />
              <div>
                <div className="tname" style={{ fontSize: 16 }}>{hero.symbol}</div>
                <div className="tsub">{fmtPrice(heroLive?.price ?? hero.alert.price_at_alert)}</div>
              </div>
            </div>
            <TradeVerdictHero alert={hero.alert} live={heroLive} />
          </div>
          <div className="acc-hero-side">
            <div className="acc-stat">
              <span className="label">Speed now</span>
              <span className="num" style={{ fontWeight: Math.abs(heroTape?.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN ? 700 : 400 }}>
                {speedText(heroTape)}
              </span>
            </div>
            <div className="acc-stat">
              <span className="label">Day move</span>
              <span className="num" style={{ color: changeColor(heroTape?.movePct ?? hero.alert.percent_move_at_alert) }}>
                {fmtPct(heroTape?.movePct ?? hero.alert.percent_move_at_alert)}
              </span>
            </div>
            <div className="acc-stat">
              <span className="label">Volume burst</span>
              <span className="num">{heroTape?.surge != null ? `${heroTape.surge.toFixed(1)}x` : "—"}</span>
            </div>
            <div className="acc-stat">
              <span className="label">VWAP</span>
              <span className="num">
                {heroTape?.vwapDistPct != null
                  ? `${heroTape.vwapDistPct > 0 ? "+" : ""}${heroTape.vwapDistPct.toFixed(2)}%`
                  : heroTape?.aboveVwap == null ? "—" : heroTape.aboveVwap ? "Above" : "Below"}
              </span>
            </div>
            <button className="pill btn btn-primary acc-chart-btn" onClick={() => onOpenChart?.(hero.symbol)}>
              Watch chart
            </button>
          </div>
        </div>
      ) : (
        <div className="empty">
          <div className="big">{tape.running ? "No trade signal right now" : "Scanner is off"}</div>
          {tape.running
            ? "That's normal — most of the day is waiting. Names appear below as they start moving."
            : "Start the app during market hours to see live signals."}
        </div>
      )}

      {/* Single ranked list */}
      <div className="acc-list-header">
        <span className="muted" style={{ fontSize: 12 }}>Click a row to load it above and open the chart.</span>
        <button className={`pill btn${showAll ? " btn-primary" : ""}`} style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Hide skipped / slow" : "Show skipped / slow"}
        </button>
      </div>

      {!visible.length ? (
        <div className="empty small">
          {tape.running ? "Nothing worth listing yet — names show up when they start moving." : "Scanner offline."}
        </div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Signal</th>
                <th>Speed now</th>
                <th>Day move</th>
                <th>Contract</th>
                <th>Confidence</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => {
                const v = e.verdict;
                return (
                  <tr
                    key={e.symbol}
                    className={`clickable${hero?.symbol === e.symbol ? " acc-row-selected" : ""}`}
                    onClick={() => pick(e.symbol)}
                    title="Load above and open chart"
                  >
                    <td>
                      <div className="tkr">
                        <TickerIcon symbol={e.symbol} />
                        <div>
                          <div className="tname">{e.symbol}</div>
                          <div className="tsub">{fmtPrice(e.tapeRow?.price ?? e.alert?.price_at_alert ?? null)}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      {v ? (
                        <span className={`verdict-pill verdict-${v.action.toLowerCase()}`} title={v.reason}>{v.headline}</span>
                      ) : (
                        <span className="verdict-pill verdict-wait">
                          {e.tapeRow?.direction === "bullish" ? "MOVING UP" : e.tapeRow?.direction === "bearish" ? "MOVING DOWN" : "MOVING"}
                        </span>
                      )}
                    </td>
                    <td className="num" style={{ fontWeight: Math.abs(e.tapeRow?.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN ? 700 : 400 }}>
                      {speedText(e.tapeRow)}
                    </td>
                    <td className="num" style={{ color: changeColor(e.tapeRow?.movePct ?? e.alert?.percent_move_at_alert) }}>
                      {fmtPct(e.tapeRow?.movePct ?? e.alert?.percent_move_at_alert)}
                    </td>
                    <td className="num muted" style={{ fontSize: 12 }}>{v?.contractLine ?? "—"}</td>
                    <td className="num">{v ? `${v.confidence}%` : "—"}</td>
                    <td onClick={(ev) => ev.stopPropagation()}>
                      <button className="pill btn" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => pick(e.symbol)}>
                        Chart
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

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
import { calledAgoLabel, calledAgoLong, sideFromAlert, stillMovingStatus } from "@/lib/signal-live";
import { useStableSymbolOrder } from "@/lib/stable-order";
import { changeColor, fmtPct, fmtPrice, pctClass } from "@/lib/format";
import { sessionGroupLabel } from "@/lib/language-modes";
import { groupAlertsBySession } from "@/lib/alert-session-groups";

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

/** Only alerts from the last few minutes attach to Right now — older ones live in History. */
const RIGHT_NOW_WINDOW_MS = 5 * 60_000;
/** Recent calls strip — session memory for "what was called and is it still moving". */
const RECENT_CALLS_WINDOW_MS = 45 * 60_000;

function isFreshAlert(alert: { alert_time?: string | null }, nowMs = Date.now()): boolean {
  if (!alert?.alert_time) return false;
  const t = Date.parse(alert.alert_time);
  return Number.isFinite(t) && nowMs - t <= RIGHT_NOW_WINDOW_MS;
}

/** Default list: live BUY only, or a stock moving fast with no stale alert attached. */
function isRightNowEntry(e: Entry): boolean {
  if (e.verdict?.action === "TRADE") return true;
  const fast = Math.abs(e.tapeRow?.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN;
  return fast && !e.alert;
}

export function AlertsCommandCenter({
  tape,
  onOpenChart,
}: {
  tape: LiveTape;
  onOpenChart?: (symbol: string) => void;
}) {
  const [alerts, setAlerts] = useState<Map<string, any>>(new Map());
  const [recentCalls, setRecentCalls] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [paused, setPaused] = useState(false);
  const pollInFlight = useRef(false);

  const pollAlerts = useCallback(async () => {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(`/api/alerts?date=${today}&limit=100`, { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      const nowMs = Date.now();
      const map = new Map<string, any>();
      const recent: any[] = [];
      const recentCutoff = nowMs - RECENT_CALLS_WINDOW_MS;
      for (const a of d.alerts ?? []) {
        const t = Date.parse(a.alert_time ?? "");
        if (Number.isFinite(t) && t >= recentCutoff) recent.push(a);
        if (!isFreshAlert(a, nowMs)) continue;
        const prev = map.get(a.ticker);
        if (!prev || a.id > prev.id) map.set(a.ticker, a);
      }
      recent.sort((a, b) => b.id - a.id);
      const dedupedRecent: any[] = [];
      const seen = new Set<string>();
      for (const a of recent) {
        if (seen.has(a.ticker)) continue;
        seen.add(a.ticker);
        dedupedRecent.push(a);
      }
      setRecentCalls(dedupedRecent.slice(0, 12));
      setAlerts((prev) => {
        if (prev.size === map.size) {
          let same = true;
          for (const [k, v] of map) {
            const p = prev.get(k);
            if (!p || p.id !== v.id) { same = false; break; }
          }
          if (same) return prev;
        }
        return map;
      });
    } catch { /* best effort */ }
    finally { pollInFlight.current = false; }
  }, []);

  useEffect(() => {
    pollAlerts();
    const id = setInterval(pollAlerts, 1000);
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
    () => (showAll ? entries.filter((e) => e.rank < 3) : entries.filter(isRightNowEntry)).slice(0, 30),
    [entries, showAll],
  );

  const stableSymbols = useStableSymbolOrder(
    visible.map((e) => e.symbol),
    { paused, intervalMs: 5000, resetKey: showAll ? "all" : "active" },
  );
  const entryMap = useMemo(() => new Map(visible.map((e) => [e.symbol, e])), [visible]);
  const displayEntries = useMemo(
    () => stableSymbols.map((s) => entryMap.get(s)).filter(Boolean) as Entry[],
    [stableSymbols, entryMap],
  );

  const hero = useMemo(() => {
    if (selected) {
      const found = entries.find((e) => e.symbol === selected && e.verdict?.action === "TRADE");
      if (found) return found;
    }
    return entries.find((e) => e.verdict?.action === "TRADE") ?? null;
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
            Live BUY signals only — stocks moving the right way this second. Updates every second. Older setups are in History.
          </p>
        </div>
        <div className="status-group">
          <span className={`status-dot ${tape.running ? "live" : ""}`} />
          <span className="status-text">
            {tape.running ? (tradeCount ? `${tradeCount} live trade signal${tradeCount === 1 ? "" : "s"}` : "Watching — no trade yet") : "Scanner offline"}
          </span>
        </div>
      </div>

      {/* Hero: the one signal to look at — fixed slot height so the page doesn't jump */}
      <div className="acc-hero-slot">
      {hero?.alert ? (
        <div className="acc-hero">
          <div className="acc-hero-main">
            <div className="acc-hero-symbol">
              <TickerIcon symbol={hero.symbol} />
              <div>
                <div className="tname text-lg">{hero.symbol}</div>
                <div className="tsub">
                  {fmtPrice(heroLive?.price ?? hero.alert.price_at_alert)}
                  {calledAgoLong(hero.alert.alert_time) ? ` · ${calledAgoLong(hero.alert.alert_time)}` : ""}
                </div>
                {heroTape ? (
                  <div className={`signal-momentum signal-momentum-${stillMovingStatus(sideFromAlert(hero.alert), heroTape).tone} text-xs mt-1`}>
                    {stillMovingStatus(sideFromAlert(hero.alert), heroTape).label}
                  </div>
                ) : null}
              </div>
            </div>
            <TradeVerdictHero alert={hero.alert} live={heroLive} />
          </div>
          <div className="acc-hero-side">
            <div className="acc-stat">
              <span className="label">Speed now</span>
              <span className={`num ${Math.abs(heroTape?.shortRate ?? 0) >= MIN_SPEED_PCT_PER_MIN ? "fw-strong" : "fw-normal"}`}>
                {speedText(heroTape)}
              </span>
            </div>
            <div className="acc-stat">
              <span className="label">Day move</span>
              <span className={`num ${pctClass(heroTape?.movePct ?? hero.alert.percent_move_at_alert)}`}>
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
        <div className="empty acc-hero-empty">
          <div className="big">{tape.running ? "No trade signal right now" : "Scanner is off"}</div>
          {tape.running
            ? "That's normal — most of the day is waiting. Names appear below as they start moving."
            : "Start the app during market hours to see live signals."}
        </div>
      )}
      </div>

      {/* Single ranked list */}
      <div className="acc-list-header">
        <span className="muted" style={{ fontSize: 12 }}>Click a row to load it above and open the chart.</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className={`pill btn${paused ? " btn-primary" : ""}`}
            style={{ fontSize: 11, padding: "4px 10px" }}
            onClick={() => setPaused((v) => !v)}
            title="Freeze list order while you read"
          >
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button className={`pill btn${showAll ? " btn-primary" : ""}`} style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Hide WAIT setups" : "Show WAIT setups"}
          </button>
        </div>
      </div>

      <div className="table-area">
      {!displayEntries.length ? (
        <div className="empty small table-empty">
          {tape.running ? "Nothing live right now — a BUY appears here the moment a stock is moving fast enough." : "Scanner offline."}
        </div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Ticker</th>
                <th>Signal</th>
                <th>Called</th>
                <th>Momentum</th>
                <th>Stock</th>
                <th>Speed now</th>
                <th>Day move</th>
                <th>Contract</th>
                <th>Confidence</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {displayEntries.map((e, i) => {
                const v = e.verdict;
                const side = e.alert ? sideFromAlert(e.alert) : "NONE";
                const momentum = stillMovingStatus(side, e.tapeRow);
                return (
                  <tr
                    key={e.symbol}
                    className={`clickable${hero?.symbol === e.symbol ? " acc-row-selected" : ""}`}
                    onClick={() => pick(e.symbol)}
                    title="Load above and open chart"
                  >
                    <td className="num muted">{i + 1}</td>
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
                    <td className="num muted" style={{ fontSize: 11 }}>
                      {e.alert ? calledAgoLabel(e.alert.alert_time) ?? "—" : "—"}
                    </td>
                    <td>
                      <span className={`signal-momentum signal-momentum-${momentum.tone}`}>{momentum.label}</span>
                    </td>
                    <td>
                      <span className={`stock-dir stock-dir-${e.tapeRow?.direction ?? "chop"}`}>
                        {e.tapeRow?.direction === "bullish" ? "▲ Up" : e.tapeRow?.direction === "bearish" ? "▼ Down" : "—"}
                      </span>
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
      </div>

      {recentCalls.length > 0 ? (
        <div className="acc-recent-calls" style={{ marginTop: 16 }}>
          <div className="label muted" style={{ fontSize: 11, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Called recently (last 45 min) — click to check if still moving
          </div>
          {groupAlertsBySession(recentCalls).map(({ key, items }) => (
            <div key={key} className="alert-session-group">
              <div className="alert-session-divider">
                {sessionGroupLabel(key, items[0]?.asset_class ?? "options")}
              </div>
              <div className="acc-on-track-chips">
                {items.map((a) => {
                  const tapeRow = tape.map.get(a.ticker) ?? null;
                  const side = sideFromAlert(a);
                  const momentum = stillMovingStatus(side, tapeRow);
                  const live = liveCtxFor(tape, a.ticker);
                  const nowVerdict = computeTradeVerdict(a, live);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className="pill btn acc-on-track-chip"
                      onClick={() => pick(a.ticker)}
                      title={nowVerdict.reason}
                    >
                      <span className="tname">{a.ticker}</span>
                      <span className="muted">{calledAgoLabel(a.alert_time)}</span>
                      <span className={`signal-momentum signal-momentum-${momentum.tone}`}>{momentum.label}</span>
                      <span className="muted">{nowVerdict.headline}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

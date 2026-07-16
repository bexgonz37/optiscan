"use client";

/**
 * /terminal — the OptiScan Trading Terminal: a dense, dark, keyboard-first
 * multi-panel workstation that combines movers, selected-ticker detail, options,
 * alerts, paper, funnel, AI, and runtime health onto ONE operating screen.
 *
 * Frontend + information-architecture only. It reuses EXISTING authenticated GET
 * APIs (scanner/live, runtime/status, diagnostics/funnel, paper/trades, alerts)
 * and changes no scanner / paper / AI / Discord / provider logic. The live options
 * chain is loaded ONLY on explicit user action so automatic polling never adds a
 * provider call.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import {
  fmtNum, fmtPct, fmtUsd, fmtVol, terminalContractLine, classificationTone, signTone,
  deriveStatusIndicators, filterMovers, sortRows, paperPortfolios, type StatusState,
} from "@/lib/terminal-view";
import s from "./terminal.module.css";

const POLL_MS = 5000;
type Region = "movers" | "ticker" | "options" | "alerts" | "paper" | "funnel" | "ai";

async function getJson(url: string): Promise<any> {
  try {
    const res = await fetch(url, { headers: scanHeaders() });
    return await res.json();
  } catch (e: any) { return { ok: false, error: e?.message ?? "fetch failed" }; }
}

function toneClass(t: "pos" | "neg" | "warn" | "info" | "muted"): string {
  return t === "pos" ? s.pos : t === "neg" ? s.neg : t === "warn" ? s.warn : t === "info" ? s.info : s.muted;
}

export default function TerminalPage() {
  const [live, setLive] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [funnel, setFunnel] = useState<any>(null);
  const [paper, setPaper] = useState<any>(null);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [chain, setChain] = useState<any>(null);
  const [lastAt, setLastAt] = useState<number | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [region, setRegion] = useState<Region>("movers");
  const [paperTab, setPaperTab] = useState<0 | 1 | 2>(0);
  const [sortKey, setSortKey] = useState<string>("shortRate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [clsFilter, setClsFilter] = useState("");
  const [actFilter, setActFilter] = useState<"all" | "actionable" | "rejected">("all");
  const searchRef = useRef<HTMLInputElement>(null);

  // Centralized polling — ONE set of fetches feeds every panel (no per-panel refetch).
  const refresh = useCallback(async () => {
    const [l, st, fn, pp, al] = await Promise.all([
      getJson("/api/scanner/live"),
      getJson("/api/runtime/status"),
      getJson("/api/diagnostics/funnel"),
      getJson("/api/paper/trades"),
      getJson("/api/alerts?limit=40"),
    ]);
    if (l?.ok !== false) setLive(l);
    if (st?.ok !== false) setStatus(st.status ?? st);
    if (fn?.ok !== false) setFunnel(fn);
    if (pp?.ok !== false) setPaper(pp);
    if (Array.isArray(al?.alerts)) setAlerts(al.alerts);
    setLastAt(Date.now());
  }, []);

  useEffect(() => { refresh(); const id = setInterval(refresh, POLL_MS); return () => clearInterval(id); }, [refresh]);

  const tape: any[] = Array.isArray(live?.tape) ? live.tape : [];
  const visibleMovers = useMemo(() => {
    const filtered = filterMovers(tape, { search, classification: clsFilter, actionable: actFilter });
    return sortRows(filtered, sortKey, sortDir);
  }, [tape, search, clsFilter, actFilter, sortKey, sortDir]);

  const selectedRow = useMemo(() => tape.find((r) => r.symbol === selected) ?? null, [tape, selected]);

  // Explicit, user-initiated live-chain load (never on the poll interval → no
  // automatic provider-call increase).
  const loadChain = useCallback(async (ticker: string) => {
    setChain({ loading: true, ticker });
    const c = await getJson(`/api/options/${encodeURIComponent(ticker)}`);
    setChain({ loading: false, ticker, ...c });
  }, []);

  const selectTicker = useCallback((sym: string | null) => { setSelected(sym); setChain(null); }, []);

  // ── keyboard navigation ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "Escape") { selectTicker(null); (document.activeElement as HTMLElement)?.blur?.(); return; }
      if (typing) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); return; }
      const map: Record<string, Region> = { m: "movers", o: "options", p: "paper", f: "funnel", a: "ai" };
      const r = map[e.key.toLowerCase()];
      if (r) { setRegion(r); return; }
      if (region === "movers" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        const idx = visibleMovers.findIndex((x) => x.symbol === selected);
        const next = e.key === "ArrowDown" ? Math.min(visibleMovers.length - 1, idx + 1) : Math.max(0, idx - 1);
        const row = visibleMovers[next < 0 ? 0 : next];
        if (row) setSelected(row.symbol);
      }
      // Enter never triggers a write/trade/Discord action — only local drill-down.
      if (e.key === "Enter" && region === "movers" && selected) loadChain(selected);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [region, visibleMovers, selected, selectTicker, loadChain]);

  const indicators = useMemo(() => {
    const rd = status?.readiness ?? status?.config?.readiness ?? null;
    return deriveStatusIndicators({
      session: live?.session ?? status?.session ?? null,
      etTime: status?.etTime ?? status?.easternTime ?? new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }),
      deploySha: status?.deploy?.commitShort ?? status?.commitShort ?? status?.commit ?? null,
      providerHealthy: status?.provider?.healthy ?? status?.providerHealthy ?? (status?.health?.provider !== "down"),
      scannerRunning: live?.running ?? status?.scanner?.running ?? null,
      lastScanAtMs: live?.lastTickAt ?? null,
      supervisorRunning: status?.supervisor?.running ?? funnel?.options?.lastCycleAtMs != null,
      lastOptionsAtMs: funnel?.options?.lastCycleAtMs ?? null,
      stockReady: rd?.stockCallouts ?? null,
      optionsReady: rd?.optionsCallouts ?? null,
      paperEnabled: status?.paper?.enabled ?? paper?.ok ?? null,
      aiEnabled: status?.ai?.enabled ?? null,
    });
  }, [live, status, funnel, paper]);

  const staleSec = lastAt ? Math.round((Date.now() - lastAt) / 1000) : null;

  return (
    <div className={s.root}>
      <StatusBar indicators={indicators} staleSec={staleSec} />

      <div className={s.grid}>
        <MoversPanel
          rows={visibleMovers} selected={selected} focused={region === "movers"}
          onSelect={(sym: string) => { setSelected(sym); setRegion("ticker"); }}
          onSort={(k: string) => { setSortDir((d) => (sortKey === k && d === "desc" ? "asc" : "desc")); setSortKey(k); }}
          sortKey={sortKey} sortDir={sortDir}
          search={search} setSearch={setSearch} searchRef={searchRef}
          clsFilter={clsFilter} setClsFilter={setClsFilter}
          actFilter={actFilter} setActFilter={setActFilter}
        />
        <TickerPanel row={selectedRow} focused={region === "ticker"} onLoadChain={loadChain} />
        <OptionsPanel funnel={funnel?.options ?? null} chain={chain} selected={selected} focused={region === "options"} onLoadChain={loadChain} />
      </div>

      <div className={s.bottom}>
        <AlertsPanel alerts={alerts} focused={region === "alerts"} />
        <PaperPanel paper={paper} tab={paperTab} setTab={setPaperTab} focused={region === "paper"} />
        <FunnelPanel funnel={funnel} focused={region === "funnel"} />
        <AiPanel status={status} funnel={funnel} focused={region === "ai"} />
        <LogPanel live={live} status={status} funnel={funnel} lastAt={lastAt} />
      </div>

      <div className={s.hint}>
        keys: / search · M movers · O options · P paper · F funnel · A ai · ↑↓ rows · Enter load chain · Esc clear · read-only, no trades sent
      </div>
    </div>
  );
}

// ── Status bar ───────────────────────────────────────────────────────────────
function StatusBar({ indicators, staleSec }: { indicators: { label: string; value: string; state: StatusState }[]; staleSec: number | null }) {
  return (
    <div className={s.statusbar}>
      {indicators.map((it) => (
        <span className={s.statusItem} key={it.label}>
          <span className={`${s.dot} ${s[`d${it.state}`]}`} />
          <span className="k">{it.label}</span>
          <span className={`${s.num} ${s[`s${it.state}`]}`}>{it.value}</span>
        </span>
      ))}
      <span className={s.statusItem} style={{ marginLeft: "auto" }}>
        <span className={s.staleNote}>{staleSec == null ? "…" : `updated ${staleSec}s ago`}</span>
      </span>
    </div>
  );
}

// ── Movers ───────────────────────────────────────────────────────────────────
const MOVER_COLS: { key: string; label: string }[] = [
  { key: "symbol", label: "TICK" }, { key: "price", label: "PX" }, { key: "movePct", label: "DAY%" },
  { key: "volume", label: "VOL" }, { key: "ret10s", label: "10s" }, { key: "ret30s", label: "30s" },
  { key: "ret60s", label: "60s" }, { key: "shortRate", label: "VEL" }, { key: "accel", label: "ACC" },
  { key: "volumeAcceleration", label: "VACC" }, { key: "vwapDistPct", label: "VWAP%" }, { key: "classification", label: "CLASS" },
  { key: "stockPolicyOk", label: "ACT" },
];
function MoversPanel(props: any) {
  const { rows, selected, focused, onSelect, onSort, sortKey, sortDir, search, setSearch, searchRef, clsFilter, setClsFilter, actFilter, setActFilter } = props;
  return (
    <div className={`${s.panel} ${focused ? s.focused : ""}`}>
      <div className={s.panelHead}>Broad Market Movers <span className="meta">{rows.length} rows</span></div>
      <div className={s.toolbar}>
        <input ref={searchRef} className={s.input} placeholder="/ ticker" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 80 }} />
        <select className={s.select} value={clsFilter} onChange={(e) => setClsFilter(e.target.value)}>
          <option value="">all class</option>
          {["FRESH_ACCELERATION", "CONTINUATION", "EARLY_CONTINUATION", "SLOW_GRINDER", "LATE_EXHAUSTION", "NOISY_ILLIQUID_SPIKE"].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className={s.select} value={actFilter} onChange={(e) => setActFilter(e.target.value as any)}>
          <option value="all">all</option><option value="actionable">actionable</option><option value="rejected">rejected</option>
        </select>
      </div>
      <div className={s.panelBody}>
        <table className={s.table}>
          <thead><tr>{MOVER_COLS.map((c) => <th key={c.key} onClick={() => onSort(c.key)}>{c.label}{sortKey === c.key ? (sortDir === "desc" ? "▾" : "▴") : ""}</th>)}</tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={MOVER_COLS.length} className={s.empty}>no movers in view</td></tr> : rows.map((r: any) => (
              <tr key={r.symbol} className={`${s.row} ${r.symbol === selected ? s.rowSel : ""}`} onClick={() => onSelect(r.symbol)}>
                <td>{r.symbol}{r.core ? <span className={s.chip} style={{ marginLeft: 4 }}>C</span> : null}</td>
                <td className={s.num}>{fmtNum(r.price)}</td>
                <td className={`${s.num} ${toneClass(signTone(r.movePct))}`}>{fmtPct(r.movePct)}</td>
                <td className={s.num}>{fmtVol(r.volume)}</td>
                <td className={`${s.num} ${toneClass(signTone(r.ret10s))}`}>{fmtPct(r.ret10s)}</td>
                <td className={`${s.num} ${toneClass(signTone(r.ret30s))}`}>{fmtPct(r.ret30s)}</td>
                <td className={`${s.num} ${toneClass(signTone(r.ret60s))}`}>{fmtPct(r.ret60s)}</td>
                <td className={`${s.num} ${toneClass(signTone(r.shortRate))}`}>{fmtNum(r.shortRate)}</td>
                <td className={`${s.num} ${toneClass(signTone(r.accel))}`}>{fmtNum(r.accel)}</td>
                <td className={s.num}>{fmtNum(r.volumeAcceleration)}</td>
                <td className={s.num}>{fmtNum(r.vwapDistPct)}</td>
                <td className={toneClass(classificationTone(r.classification))} style={{ textAlign: "left" }}>{r.classification ?? "N/A"}</td>
                <td className={r.stockPolicyOk ? s.pos : s.muted}>{r.stockPolicyOk ? "YES" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Selected ticker ──────────────────────────────────────────────────────────
function TickerPanel({ row, focused, onLoadChain }: { row: any; focused: boolean; onLoadChain: (t: string) => void }) {
  return (
    <div className={`${s.panel} ${focused ? s.focused : ""}`}>
      <div className={s.panelHead}>
        Selected Ticker <span className="meta">{row?.symbol ?? "— pick a mover"}</span>
      </div>
      <div className={s.panelBody}>
        {!row ? <div className={s.empty}>Click a ticker in Movers (or ↑↓ + focus) to drill in.</div> : (
          <>
            <div className={s.oneline}>{row.symbol} · {fmtUsd(row.price)} · {fmtPct(row.movePct)} · {row.classification ?? "N/A"}</div>
            <div className={s.kv}>
              <KV k="Price" v={fmtUsd(row.price)} />
              <KV k="Day gain" v={fmtPct(row.movePct)} tone={signTone(row.movePct)} />
              <KV k="10s / 30s / 60s" v={`${fmtPct(row.ret10s)} / ${fmtPct(row.ret30s)} / ${fmtPct(row.ret60s)}`} />
              <KV k="Velocity (short rate)" v={fmtNum(row.shortRate)} tone={signTone(row.shortRate)} />
              <KV k="Acceleration" v={fmtNum(row.accel)} tone={signTone(row.accel)} />
              <KV k="Volume (DTD)" v={fmtVol(row.volume)} />
              <KV k="Volume rate / accel" v={`${fmtNum(row.volumeRate)} / ${fmtNum(row.volumeAcceleration)}`} />
              <KV k="VWAP dist" v={fmtPct(row.vwapDistPct)} />
              <KV k="Above VWAP" v={row.aboveVwap == null ? "N/A" : row.aboveVwap ? "yes" : "no"} />
              <KV k="HOD / LOD break" v={`${row.hodBreak ? "HOD" : "—"} / ${row.lodBreak ? "LOD" : "—"}`} />
              <KV k="Spread%" v={fmtNum(row.spreadPct ?? (row.ask != null && row.bid != null && row.price ? ((row.ask - row.bid) / row.price) * 100 : null))} />
              <KV k="Rel vol" v={fmtNum(row.relVol)} />
              <KV k="Direction" v={String(row.direction ?? "N/A")} />
              <KV k="Classification" v={row.classification ?? "N/A"} tone={classificationTone(row.classification) === "pos" ? "pos" : classificationTone(row.classification) === "neg" ? "neg" : "muted"} />
              <KV k="Actionable" v={row.stockPolicyOk ? "YES" : "no"} tone={row.stockPolicyOk ? "pos" : "muted"} />
            </div>
            <div className={s.gates}>
              {row.stockPolicyReason ? <span className={row.stockPolicyOk ? s.gateOk : s.gateBad}>{row.stockPolicyReason}</span> : <span className={s.muted}>no gate detail</span>}
            </div>
            <div style={{ padding: "0 8px 8px" }}>
              <button className={s.chip} onClick={() => onLoadChain(row.symbol)}>Load live options chain →</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
function KV({ k, v, tone }: { k: string; v: string; tone?: "pos" | "neg" | "muted" | "warn" }) {
  return <><span className="k">{k}</span><span className={`v ${tone === "pos" ? s.pos : tone === "neg" ? s.neg : tone === "warn" ? s.warn : ""}`}>{v}</span></>;
}

// ── Options ──────────────────────────────────────────────────────────────────
function OptionsPanel({ funnel, chain, selected, focused, onLoadChain }: any) {
  const contracts: any[] = Array.isArray(chain?.contracts) ? chain.contracts
    : Array.isArray(chain?.chain) ? chain.chain : [];
  return (
    <div className={`${s.panel} ${focused ? s.focused : ""}`}>
      <div className={s.panelHead}>Options {selected ? <span className="meta">{selected}</span> : <span className="meta">core universe</span>}</div>
      <div className={s.panelBody}>
        {funnel ? (
          <div className={s.kv}>
            <KV k="Underlyings evaluated" v={String(funnel.underlyingsEvaluated ?? "N/A")} />
            <KV k="Chains ok / failed" v={`${funnel.chainsOk ?? "N/A"} / ${funnel.chainsFailed ?? "N/A"}`} />
            <KV k="Canonical → collapsed" v={`${funnel.canonical ?? "N/A"} → ${funnel.collapsed ?? "N/A"}`} />
            <KV k="Emitted / delivered" v={`${funnel.emitted ?? "N/A"} / ${funnel.delivered ?? "N/A"}`} />
          </div>
        ) : <div className={s.empty}>options funnel unavailable</div>}
        {Array.isArray(funnel?.selectedContracts) && funnel.selectedContracts.length ? (
          <div style={{ padding: "2px 8px" }}>
            <span className={s.muted}>selected: </span>
            {funnel.selectedContracts.map((c: string) => <span key={c} className={s.chip} style={{ marginRight: 3 }}>{c}</span>)}
          </div>
        ) : null}

        {!selected ? <div className={s.empty}>pick a ticker to load its live chain (explicit — no auto provider calls)</div> : chain?.loading ? (
          <div className={s.empty}>loading {chain.ticker} chain…</div>
        ) : chain && contracts.length === 0 ? (
          <div style={{ padding: 8 }}>
            <span className={s.muted}>{chain.error ?? "no contracts returned"}</span>
            <div><button className={s.chip} onClick={() => onLoadChain(selected)} style={{ marginTop: 6 }}>retry</button></div>
          </div>
        ) : contracts.length ? (
          <ContractTable contracts={contracts} />
        ) : (
          <div style={{ padding: 8 }}><button className={s.chip} onClick={() => onLoadChain(selected)}>Load {selected} live chain</button></div>
        )}
      </div>
    </div>
  );
}
function ContractTable({ contracts }: { contracts: any[] }) {
  const best = contracts.reduce((acc: any, c: any) => (c?.selected || c?.eligible ? c : acc), null) ?? contracts[0];
  const line = best ? terminalContractLine({ ticker: best.ticker ?? best.underlying, strike: best.strike, side: best.side ?? best.type, expiration: best.expiration, price: best.mid ?? best.ask }) : null;
  return (
    <>
      {line ? <div className={s.oneline}>{line}</div> : null}
      <table className={s.table}>
        <thead><tr>{["EXP", "DTE", "STRK", "S", "BID", "ASK", "MID", "SPR%", "VOL", "OI", "IV", "DLT", "ELIG"].map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {contracts.slice(0, 60).map((c: any, i: number) => (
            <tr key={c.optionSymbol ?? i} className={`${s.row} ${c === best ? s.rowSel : ""}`}>
              <td style={{ textAlign: "left" }}>{c.expiration ?? "N/A"}</td>
              <td className={s.num}>{c.dte ?? "N/A"}</td>
              <td className={s.num}>{fmtNum(c.strike, 1)}</td>
              <td>{String(c.side ?? c.type ?? "").toUpperCase().startsWith("P") ? "P" : "C"}</td>
              <td className={s.num}>{fmtNum(c.bid)}</td>
              <td className={s.num}>{fmtNum(c.ask)}</td>
              <td className={s.num}>{fmtNum(c.mid)}</td>
              <td className={s.num}>{fmtNum(c.spreadPct, 1)}</td>
              <td className={s.num}>{fmtVol(c.volume)}</td>
              <td className={s.num}>{fmtVol(c.openInterest)}</td>
              <td className={s.num}>{fmtNum(c.iv, 2)}</td>
              <td className={s.num}>{fmtNum(c.delta, 2)}</td>
              <td className={c.eligible ? s.pos : s.muted}>{c.eligible ? "OK" : (c.rejectReason ? "×" : "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ── Alerts ───────────────────────────────────────────────────────────────────
function AlertsPanel({ alerts, focused }: { alerts: any[]; focused: boolean }) {
  const [f, setF] = useState<"all" | "stock" | "options">("all");
  const rows = alerts.filter((a) => f === "all" || (f === "stock" ? a.asset_class === "stock" : a.asset_class !== "stock"));
  return (
    <div className={`${s.panel} ${focused ? s.focused : ""}`}>
      <div className={s.panelHead}>Alerts <span className="meta">{rows.length}</span></div>
      <div className={s.toolbar}>
        {(["all", "stock", "options"] as const).map((k) => <span key={k} className={`${s.chip} ${f === k ? s.chipSel : ""}`} onClick={() => setF(k)}>{k}</span>)}
      </div>
      <div className={s.panelBody}>
        <table className={s.table}>
          <thead><tr>{["TIME", "TICK", "TYPE", "STATE", "REASON"].map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={5} className={s.empty}>no alerts</td></tr> : rows.slice(0, 40).map((a: any, i: number) => (
              <tr key={a.id ?? i}>
                <td style={{ textAlign: "left" }}>{a.created_at ? new Date(a.created_at).toLocaleTimeString() : (a.detected_at ?? "N/A")}</td>
                <td style={{ textAlign: "left" }}>{a.ticker ?? "N/A"}</td>
                <td>{a.asset_class === "stock" ? "STK" : "OPT"}</td>
                <td className={String(a.capture_action).toUpperCase() === "TRADE" ? s.pos : s.muted}>{a.capture_action ?? a.alert_tier ?? "N/A"}</td>
                <td style={{ textAlign: "left" }} className={s.muted}>{(a.invalidation_reason ?? a.move_status ?? "").slice(0, 40) || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Paper ────────────────────────────────────────────────────────────────────
function PaperPanel({ paper, tab, setTab, focused }: any) {
  const ports = paperPortfolios(paper);
  const p = ports[tab] ?? ports[0];
  const ch = paper?.challenge ?? null;
  const showChallengeAudit = p.key === "CHALLENGE" && ch;
  return (
    <div className={`${s.panel} ${focused ? s.focused : ""}`}>
      <div className={s.panelHead}>Paper</div>
      <div className={s.tabs}>
        {ports.map((pp, i) => <span key={pp.key} className={`${s.tab} ${tab === i ? s.tabActive : ""} ${!pp.enabled ? s.muted : ""}`} onClick={() => setTab(i)}>{pp.name}</span>)}
      </div>
      <div className={s.panelBody}>
        {!p.enabled && p.key !== "PRIMARY" ? <div className={s.empty}>{p.name} not enabled</div> : (
          <div className={s.kv}>
            <KV k="Equity" v={fmtUsd(p.equity)} />
            <KV k="Realized P&L" v={fmtUsd(p.realizedPnl)} tone={signTone(p.realizedPnl)} />
            <KV k="Unrealized P&L" v={fmtUsd(p.unrealizedPnl)} tone={signTone(p.unrealizedPnl)} />
            <KV k="Open positions" v={p.openPositions == null ? "N/A" : String(p.openPositions)} />
          </div>
        )}
        {showChallengeAudit ? (
          <div className={s.kv}>
            <span className="k" style={{ gridColumn: "1 / -1", color: "var(--tt-info)", marginTop: 6 }}>CHALLENGE TODAY {ch.today?.day ?? ""}</span>
            <KV k="signals / sizing / created" v={`${ch.today?.signals ?? 0} / ${ch.today?.sizingAttempts ?? 0} / ${ch.today?.created ?? 0}`} tone={(ch.today?.created ?? 0) > 0 ? "pos" : "muted"} />
            <KV k="rejections / duplicates" v={`${ch.today?.rejections ?? 0} / ${ch.today?.duplicates ?? 0}`} />
            <KV k="open / exposure" v={`${ch.openPositions ?? 0} / ${ch.exposurePctOfEquity != null ? ch.exposurePctOfEquity + "%" : "N/A"}`} />
            <KV k="buying power" v={fmtUsd(ch.availableBuyingPowerDollars)} />
            <KV k="last binding" v={ch.today?.lastBindingConstraint ?? ch.lastExecution?.bindingConstraint ?? "—"} tone="warn" />
            <span className="k" style={{ gridColumn: "1 / -1", color: "var(--tt-dim)", marginTop: 4 }}>
              effective caps · risk {ch.caps?.maxLossAtStopPct ?? "?"}% · pos {ch.caps?.maxPositionPct ?? "?"}% · exp {ch.caps?.maxTotalExposurePct ?? "?"}% · 0DTE {ch.caps?.allowZeroDte ? "on" : "off"}
            </span>
            {ch.today?.lastReason ? <span className="k" style={{ gridColumn: "1 / -1", color: "var(--tt-dim)" }}>last: {ch.today.lastReason}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Funnel ───────────────────────────────────────────────────────────────────
function FunnelPanel({ funnel, focused }: any) {
  const st = funnel?.stock ?? null; const op = funnel?.options ?? null;
  const td = funnel?.today ?? null;
  const clock = (ms: number | null | undefined) => (typeof ms === "number" ? new Date(ms).toLocaleTimeString() : "—");
  const lastNotif = td ? clock(td.lastNotificationMs) : "—";
  const silentToday = td && td.hasData && td.lastNotificationMs == null;
  return (
    <div className={`${s.panel} ${focused ? s.focused : ""}`}>
      <div className={s.panelHead}>
        Funnel
        <span className="meta">last alert {lastNotif}</span>
      </div>
      <div className={s.panelBody}>
        {td ? (
          <div className={s.kv}>
            <span className="k" style={{ gridColumn: "1 / -1", color: silentToday ? "var(--tt-neg)" : "var(--tt-warn)" }}>
              TODAY {td.tradingDay}{silentToday ? " — 0 notifications sent" : ""}
            </span>
            <KV k="stock cand / actionable / sent" v={`${td.stocks?.candidates ?? "N/A"} / ${td.stocks?.actionable ?? "N/A"} / ${td.stocks?.delivered ?? "N/A"}`} tone={(td.stocks?.delivered ?? 0) > 0 ? "pos" : "muted"} />
            <KV k="stock last sent" v={clock(td.stocks?.lastDeliveryMs)} />
            <KV k="opt canon / emit / deliv" v={`${td.options?.canonical ?? "N/A"} / ${td.options?.emitted ?? "N/A"} / ${td.options?.delivered ?? "N/A"}`} tone={(td.options?.delivered ?? 0) > 0 ? "pos" : "muted"} />
            <KV k="opt dedup / portfolio supp." v={`${td.options?.dedupSuppressed ?? "N/A"} / ${td.options?.portfolioSuppressed ?? "N/A"}`} />
            <KV k="opt last sent" v={clock(td.options?.lastDeliveryMs)} />
            {td.stocks?.topReasons?.[0] ? <KV k="stock top reason" v={`${td.stocks.topReasons[0].reason} ×${td.stocks.topReasons[0].count}`} /> : null}
            {!td.hasData ? <span className="k" style={{ gridColumn: "1 / -1", color: "var(--tt-dim)" }}>no persisted diagnostics for today yet</span> : null}
          </div>
        ) : null}
        {td?.options?.diagnosis ? <div className={s.hint} style={{ color: "var(--tt-warn)" }}>{td.options.diagnosis}</div> : null}
        <div className={s.kv}>
          <span className="k" style={{ gridColumn: "1 / -1", color: "var(--tt-info)", marginTop: td ? 6 : 0 }}>STOCK · this cycle</span>
          <KV k="universe → broad → fast" v={`${st?.universeSize ?? "N/A"} → ${st?.broadPass ?? "N/A"} → ${st?.fastMoverPass ?? "N/A"}`} />
          <span className="k" style={{ gridColumn: "1 / -1", color: "var(--tt-info)", marginTop: 6 }}>OPTIONS</span>
          <KV k="canon → collapse → emit" v={`${op?.canonical ?? "N/A"} → ${op?.collapsed ?? "N/A"} → ${op?.emitted ?? "N/A"}`} />
          <KV k="dedup / portfolio supp." v={`${op?.dedupSuppressed ?? "N/A"} / ${op?.portfolioSuppressed ?? "N/A"}`} />
          <KV k="delivered" v={String(op?.delivered ?? "N/A")} tone={(op?.delivered ?? 0) > 0 ? "pos" : "muted"} />
        </div>
        {op?.topReason ? <div className={s.hint}>{op.topReason}</div> : null}
      </div>
    </div>
  );
}

// ── AI ───────────────────────────────────────────────────────────────────────
function AiPanel({ status, funnel, focused }: any) {
  const st = funnel?.stock ?? null;
  const topRej = Array.isArray(st?.topRejections) && st.topRejections.length ? `${st.topRejections[0].reason} ×${st.topRejections[0].count}` : "N/A";
  return (
    <div className={`${s.panel} ${focused ? s.focused : ""}`}>
      <div className={s.panelHead}>AI Findings <span className="meta">advisory</span></div>
      <div className={s.panelBody}>
        <div className={s.kv}>
          <KV k="AI enabled" v={status?.ai?.enabled ? "yes" : "no"} tone={status?.ai?.enabled ? "pos" : "muted"} />
          <KV k="Top stock rejection" v={topRej} />
          <KV k="Fast-mover pass" v={String(st?.fastMoverPass ?? "N/A")} />
          <KV k="Broad pass" v={String(st?.broadPass ?? "N/A")} />
        </div>
        <div style={{ padding: "0 8px 8px" }}><a className={s.chip} href="/quant">full quant research →</a></div>
      </div>
    </div>
  );
}

// ── System log ───────────────────────────────────────────────────────────────
function LogPanel({ live, status, funnel, lastAt }: any) {
  const lines = [
    `scanner tick: ${live?.lastTickAt ? new Date(live.lastTickAt).toLocaleTimeString() : "N/A"} · ticks ${live?.ticks ?? "N/A"} · err ${live?.errors ?? "N/A"}`,
    `discovery: ${live?.discoveryStats ? `${live.discoveryStats.source} · uni ${live.discoveryStats.universeSize} · promo ${live.discoveryStats.promoted}` : "N/A"}`,
    `options cycle: ${funnel?.options?.lastCycleAtMs ? new Date(funnel.options.lastCycleAtMs).toLocaleTimeString() : "N/A"}`,
    `note: ${live?.note ?? status?.note ?? "—"}`,
    `refreshed: ${lastAt ? new Date(lastAt).toLocaleTimeString() : "…"}`,
  ];
  return (
    <div className={s.panel}>
      <div className={s.panelHead}>System Log</div>
      <div className={s.panelBody} style={{ padding: 8, fontFamily: "var(--tt-mono)", fontSize: 11 }}>
        {lines.map((l, i) => <div key={i} className={s.muted} style={{ marginBottom: 3 }}>{l}</div>)}
      </div>
    </div>
  );
}

"use client";

/**
 * /funnel — the live current-session alert funnels. When the stock or options
 * channel is sending zero alerts, this page makes the exact drop-off point
 * immediately visible: universe size, how broad the scan really was, how many
 * names survived each gate, the classification breakdown, the top rejection
 * reasons, and the exact config gate (blockedBy) blocking delivery.
 */

import { useCallback, useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { Panel } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";

type Rejection = { reason: string; count: number };
type StockFunnel = {
  lastCycleAtMs: number | null; universeSize: number; curatedCount: number;
  broadCount: number; broadPass: number; promoted: number; source: string;
  fastMoverPass: number; classifications: Record<string, number>;
  topRejections: Rejection[]; actionableReady: boolean; premarketReady: boolean; blockedBy: string[];
};
type SuppressedItem = { ticker: string; direction: string; optionSymbol: string | null; status: string; previousStatus: string | null; suppressionReason: string; materialChange: boolean };
type OptionsFunnel = {
  lastCycleAtMs: number | null; underlyingsEvaluated: number; chainsOk: number; chainsFailed: number;
  tickersWithCanonical: number; canonical: number; actionable: number; collapsed: number;
  dedupSuppressed: number; portfolioSuppressed: number; emitted: number; delivered: number;
  notActionableNow: number; contractIncomplete: number; contractMismatch: number;
  selectedContracts: string[]; topReason: string | null; deliveryGateReason: string | null;
  ready: boolean; blockedBy: string[]; suppressedItems: SuppressedItem[];
};
type FunnelData = { ok: boolean; session: string; generatedAtMs: number; stock: StockFunnel; options: OptionsFunnel };

const ts = (ms: number | null) => (ms ? new Date(ms).toLocaleTimeString() : "—");

function GateBadge({ ready, blockedBy }: { ready: boolean; blockedBy: string[] }) {
  return (
    <span className={`axiom-badge ${ready ? "ok" : "warn"}`} style={{ marginLeft: 8 }}>
      {ready ? "READY" : `BLOCKED: ${blockedBy.join(", ") || "unknown"}`}
    </span>
  );
}

export default function FunnelPage() {
  const [data, setData] = useState<FunnelData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/diagnostics/funnel", { headers: scanHeaders() });
      const j = await res.json();
      if (!j.ok) { setErr(j.error ?? "unavailable"); return; }
      setErr(null); setData(j);
    } catch (e: any) { setErr(e?.message ?? "fetch failed"); }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 10_000); return () => clearInterval(id); }, [load]);

  const stock = data?.stock;
  const options = data?.options;

  return (
    <div className="axiom-page">
      <h1 className="axiom-h1">Live alert funnel <span className="axiom-sub">({data?.session ?? "…"})</span></h1>
      <p className="axiom-sub">Why a channel is or isn&apos;t sending — updated every 10s. {err ? <span className="axiom-badge warn">{err}</span> : null}</p>

      <Panel title="Stock momentum funnel" meta={`last discovery ${ts(stock?.lastCycleAtMs ?? null)}`}>
        {stock ? (
          <>
            <div className="axiom-stat-row">
              <StatTile label="Universe scanned" value={stock.universeSize} hint={stock.source} />
              <StatTile label="Whole-market snapshot" value={stock.broadCount} hint="all US names" />
              <StatTile label="Passed broad floor" value={stock.broadPass} hint="$0.50–$50, ≥500k, ≥+10%" />
              <StatTile label="Promoted to 1s loop" value={stock.promoted} hint="ranked runners" />
              <StatTile label="Fast-mover pass" value={stock.fastMoverPass} hint="10s/30s + velocity" />
            </div>
            <div style={{ marginTop: 12 }}>
              <strong>Classifications:</strong>{" "}
              {Object.keys(stock.classifications).length
                ? Object.entries(stock.classifications).map(([k, v]) => <span key={k} className="axiom-chip">{k}: {v}</span>)
                : <span className="axiom-sub">no tape yet</span>}
            </div>
            <div style={{ marginTop: 12 }}>
              <strong>Top rejection reasons:</strong>
              {stock.topRejections.length ? (
                <ul className="axiom-list">{stock.topRejections.map((r) => <li key={r.reason}>{r.reason} <span className="axiom-sub">×{r.count}</span></li>)}</ul>
              ) : <span className="axiom-sub"> none</span>}
            </div>
            <div style={{ marginTop: 12 }}>
              <div>Regular-hours stock Discord <GateBadge ready={stock.actionableReady} blockedBy={stock.blockedBy} /></div>
              <div>Premarket notifications <GateBadge ready={stock.premarketReady} blockedBy={stock.blockedBy} /></div>
            </div>
          </>
        ) : <span className="axiom-sub">loading…</span>}
      </Panel>

      <Panel title="Options funnel" meta={`last cycle ${ts(options?.lastCycleAtMs ?? null)}`}>
        {options ? (
          <>
            {/* Full pipeline: canonical → actionable → collapsed → suppressed → emitted → delivered. */}
            <div className="axiom-stat-row">
              <StatTile label="Underlyings evaluated" value={options.underlyingsEvaluated} hint={`${options.chainsOk} chains ok · ${options.chainsFailed} failed`} />
              <StatTile label="Canonical" value={options.canonical} hint={`${options.tickersWithCanonical} tickers`} />
              <StatTile label="Actionable" value={options.actionable} hint="ACTIONABLE_NOW (pre-collapse)" />
              <StatTile label="Collapsed" value={options.collapsed} hint="best per ticker/direction" />
              <StatTile label="Dedup suppressed" value={options.dedupSuppressed} hint="unchanged / not material" />
              <StatTile label="Portfolio suppressed" value={options.portfolioSuppressed} hint="outside top-N by quality" />
              <StatTile label="Emitted" value={options.emitted} hint={`${options.notActionableNow} not actionable`} />
              <StatTile label="Delivered" value={options.delivered} hint="to Discord" />
            </div>
            <div style={{ marginTop: 12 }}>
              <strong>Selected contracts:</strong>{" "}
              {options.selectedContracts.length
                ? options.selectedContracts.map((c) => <span key={c} className="axiom-chip">{c}</span>)
                : <span className="axiom-sub">none this cycle</span>}
            </div>
            {options.topReason ? <div style={{ marginTop: 8 }} className="axiom-sub">Top gate: {options.topReason}</div> : null}
            {options.deliveryGateReason ? <div style={{ marginTop: 8 }}><span className="axiom-badge warn">Delivery gate: {options.deliveryGateReason}</span></div> : null}
            <div style={{ marginTop: 12 }}>Options Discord <GateBadge ready={options.ready} blockedBy={options.blockedBy} /></div>
            {options.suppressedItems?.length ? (
              <div style={{ marginTop: 12, overflowX: "auto" }}>
                <strong className="text-xs">Why each canonical candidate did not emit</strong>
                <table className="text-xs" style={{ marginTop: 4, width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr style={{ textAlign: "left" }}><th>Ticker</th><th>Dir</th><th>Contract</th><th>Status</th><th>Prev</th><th>Material?</th><th>Reason</th></tr></thead>
                  <tbody>
                    {options.suppressedItems.slice(0, 30).map((it, i) => (
                      <tr key={`${it.ticker}-${it.direction}-${i}`}>
                        <td>{it.ticker}</td><td>{it.direction}</td><td>{it.optionSymbol ?? "—"}</td>
                        <td>{it.status}</td><td>{it.previousStatus ?? "—"}</td><td>{it.materialChange ? "yes" : "no"}</td>
                        <td>{it.suppressionReason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : <span className="axiom-sub">loading…</span>}
      </Panel>
    </div>
  );
}

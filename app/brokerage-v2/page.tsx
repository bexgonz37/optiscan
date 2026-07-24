"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PageContainer,
  PageHeader,
  Card,
  LoadingState,
  EmptyState,
  ErrorState,
  StatusBadge,
} from "@/components/ui/Shell";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

const V2_LABEL = "Research / Brokerage V2 — Not Yet Authoritative";

type AccountSummary = {
  label?: string;
  startingCash: number;
  cash: number;
  reservedCash: number;
  buyingPower: number;
  totalEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openPositionMarketValue: number;
  highWaterMark: number;
  drawdownDollars: number;
  drawdownPct: number;
  completeness?: string;
  missingMarkCount?: number;
  staleMarkCount?: number;
  reconciliation?: { ok: boolean };
  account: {
    id: string;
    accountKey: string;
    accountType: string;
    displayName: string;
  };
};

type Position = {
  occSymbol: string;
  underlying: string | null;
  right: string | null;
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  contracts: number;
  averageEntryCost: number;
  currentMark: number | null;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedReturnPct: number | null;
  markTimestampMs: number | null;
  markStatus: string;
  evidenceChainId: string | null;
};

type OrderRow = {
  id: string;
  status: string;
  side: string;
  quantity: number;
  requestedPrice: number | null;
  fillPrice: number | null;
  slippage: number | null;
  commissions: number;
  marketSnapshotId: string | null;
  legacyLinkage: { legacyTable: string; legacyId: string } | null;
  parityStatus: { allMatched: boolean } | null;
  symbol: string;
  evidenceChainId: string | null;
};

type LedgerEntry = {
  sequenceNum: number;
  entryKind: string;
  cashDelta: number;
  reservedDelta: number;
  cashBalanceAfter: number;
  reservedBalanceAfter: number;
  buyingPowerAfter: number;
  refKind: string;
  refId: string;
  description: string | null;
  createdAtMs: number;
};

type CurvePoint = {
  atMs: number;
  totalEquity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  highWaterMark: number | null;
  drawdownPct: number | null;
  drawdownDollars: number | null;
  completeness: string | null;
  incomplete: boolean;
  staleOrMissingMarks: boolean;
};

type EvidencePayload = {
  evidenceChainId: string;
  stages: Array<{ stage: string; [k: string]: unknown }>;
  chain: Record<string, unknown>;
};

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function ts(ms: number | null | undefined): string {
  if (ms == null) return "—";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "—";
  }
}

export default function BrokerageV2Page() {
  const [accountKey, setAccountKey] = useState("research_shadow");
  const [audience, setAudience] = useState("");
  const [underlying, setUnderlying] = useState("");
  const [status, setStatus] = useState("");
  const [completeness, setCompleteness] = useState("");
  const [fromMs, setFromMs] = useState("");
  const [toMs, setToMs] = useState("");
  const [strategy, setStrategy] = useState("");

  const [disabled, setDisabled] = useState(false);
  const [disableMsg, setDisableMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadState, setLoadState] = useState<"ok" | "empty" | "error">("ok");
  const [errorTitle, setErrorTitle] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [curve, setCurve] = useState<CurvePoint[]>([]);
  const [evidence, setEvidence] = useState<EvidencePayload | null>(null);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (accountKey) p.set("account", accountKey);
    if (audience) p.set("audience", audience);
    if (underlying.trim()) p.set("underlying", underlying.trim().toUpperCase());
    if (status.trim()) p.set("status", status.trim());
    if (completeness) p.set("completeness", completeness);
    if (fromMs.trim()) p.set("fromMs", fromMs.trim());
    if (toMs.trim()) p.set("toMs", toMs.trim());
    if (strategy.trim()) p.set("strategy", strategy.trim());
    p.set("limit", "100");
    return p.toString();
  }, [accountKey, audience, underlying, status, completeness, fromMs, toMs, strategy]);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorTitle(null);
    setErrorDetail(null);
    setDisabled(false);
    setDisableMsg(null);
    setEvidence(null);
    setEvidenceId(null);

    const accountRes = await apiFetchJson<AccountSummary & { enabled?: boolean; code?: string; error?: string; empty?: boolean }>(
      `/api/paper/account?${qs}`,
    );

    if (!accountRes.ok) {
      const { title, detail } = describeApiLoadFailure(accountRes);
      setLoadState("error");
      setErrorTitle(title);
      setErrorDetail(detail);
      setAccount(null);
      setLoading(false);
      return;
    }

    const body = accountRes.data;
    if (body && body.enabled === false) {
      setDisabled(true);
      setDisableMsg(body.error ?? "Brokerage V2 is disabled.");
      setLoadState("ok");
      setAccount(null);
      setPositions([]);
      setOrders([]);
      setLedger([]);
      setCurve([]);
      setLoading(false);
      return;
    }

    if (body?.empty || !body?.account) {
      setLoadState("empty");
      setAccount(null);
      setLoading(false);
      return;
    }

    const [posRes, ordRes, ledRes, eqRes] = await Promise.all([
      apiFetchJson<{ positions?: Position[] }>(`/api/paper/positions?${qs}`),
      apiFetchJson<{ orders?: OrderRow[] }>(`/api/paper/orders?${qs}`),
      apiFetchJson<{ entries?: LedgerEntry[] }>(`/api/paper/ledger?${qs}`),
      apiFetchJson<{ points?: CurvePoint[] }>(`/api/paper/equity-curve?${qs}`),
    ]);

    setAccount(body as AccountSummary);
    setPositions(posRes.ok ? posRes.data?.positions ?? [] : []);
    setOrders(ordRes.ok ? ordRes.data?.orders ?? [] : []);
    setLedger(ledRes.ok ? ledRes.data?.entries ?? [] : []);
    setCurve(eqRes.ok ? eqRes.data?.points ?? [] : []);
    setLoadState("ok");
    setLoading(false);
  }, [qs]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEvidence = async (id: string | null) => {
    if (!id) return;
    setEvidenceId(id);
    const res = await apiFetchJson<EvidencePayload>(`/api/paper/evidence?evidenceChainId=${encodeURIComponent(id)}`);
    if (res.ok && res.data) setEvidence(res.data);
    else setEvidence(null);
  };

  return (
    <PageContainer>
      <PageHeader title="Brokerage V2" subtitle={V2_LABEL} />
      <Card title="Surface status">
        <StatusBadge tone="warn">{V2_LABEL}</StatusBadge>
        <p style={{ marginTop: 8, fontSize: 13 }}>
          Legacy paper APIs and dashboards remain authoritative. This page never mixes legacy rows into V2
          tables.
        </p>
      </Card>

      <Card title="Filters">
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))" }}>
          <label>
            Account
            <select value={accountKey} onChange={(e) => setAccountKey(e.target.value)} style={{ display: "block", width: "100%" }}>
              <option value="research_shadow">research_shadow</option>
              <option value="subscriber_paper">subscriber_paper</option>
              <option value="replay_lab">replay_lab</option>
            </select>
          </label>
          <label>
            Audience
            <select value={audience} onChange={(e) => setAudience(e.target.value)} style={{ display: "block", width: "100%" }}>
              <option value="">(any)</option>
              <option value="delivered">delivered subscriber</option>
              <option value="research">research shadow</option>
              <option value="replay">replay</option>
            </select>
          </label>
          <label>
            Underlying
            <input value={underlying} onChange={(e) => setUnderlying(e.target.value)} placeholder="SPY" style={{ display: "block", width: "100%" }} />
          </label>
          <label>
            Status
            <input value={status} onChange={(e) => setStatus(e.target.value)} placeholder="FILLED / MISSING" style={{ display: "block", width: "100%" }} />
          </label>
          <label>
            Strategy
            <input value={strategy} onChange={(e) => setStrategy(e.target.value)} style={{ display: "block", width: "100%" }} />
          </label>
          <label>
            Snapshot completeness
            <select value={completeness} onChange={(e) => setCompleteness(e.target.value)} style={{ display: "block", width: "100%" }}>
              <option value="">(any)</option>
              <option value="COMPLETE">complete</option>
              <option value="INCOMPLETE">incomplete/partial</option>
              <option value="PARTIAL">partial</option>
            </select>
          </label>
          <label>
            From ms
            <input value={fromMs} onChange={(e) => setFromMs(e.target.value)} style={{ display: "block", width: "100%" }} />
          </label>
          <label>
            To ms
            <input value={toMs} onChange={(e) => setToMs(e.target.value)} style={{ display: "block", width: "100%" }} />
          </label>
        </div>
        <button type="button" className="ui-btn ui-btn-sm" style={{ marginTop: 10 }} onClick={() => void load()}>
          Refresh
        </button>
      </Card>

      {loading && <LoadingState label="Loading Brokerage V2…" />}
      {!loading && loadState === "error" && errorTitle && (
        <ErrorState title={errorTitle} detail={errorDetail ?? undefined} onRetry={load} />
      )}
      {!loading && disabled && (
        <EmptyState
          title="Brokerage V2 disabled"
          reason={disableMsg ?? "Set PAPER_BROKER_V2_ENABLED=1 to activate research dual-write and these APIs."}
        />
      )}
      {!loading && !disabled && loadState === "empty" && (
        <EmptyState
          title="No V2 account yet"
          reason="No broker_accounts row matched filters. Dual-write creates accounts when PAPER_BROKER_V2_ENABLED=1."
        />
      )}

      {!loading && !disabled && loadState === "ok" && account && (
        <>
          <Card title="Account summary">
            <p>
              {account.account.displayName} · {account.account.accountKey} · {account.account.accountType}
            </p>
            <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", fontSize: 13 }}>
              <div>Starting cash: {money(account.startingCash)}</div>
              <div>Cash: {money(account.cash)}</div>
              <div>Reserved: {money(account.reservedCash)}</div>
              <div>Buying power: {money(account.buyingPower)}</div>
              <div>Total equity: {money(account.totalEquity)}</div>
              <div>Realized P&amp;L: {money(account.realizedPnl)}</div>
              <div>Unrealized P&amp;L: {money(account.unrealizedPnl)}</div>
              <div>Open MV: {money(account.openPositionMarketValue)}</div>
              <div>HWM: {money(account.highWaterMark)}</div>
              <div>Drawdown $: {money(account.drawdownDollars)}</div>
              <div>Drawdown %: {pct(account.drawdownPct)}</div>
              <div>
                Completeness: {account.completeness ?? "n/a"}
                {account.missingMarkCount ? ` · missing marks ${account.missingMarkCount}` : ""}
                {account.staleMarkCount ? ` · stale ${account.staleMarkCount}` : ""}
              </div>
              <div>Reconcile: {account.reconciliation?.ok ? "ok" : "check failures"}</div>
            </div>
          </Card>

          <Card title="Open positions">
            {positions.length === 0 ? (
              <p>No open positions.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>
                      {[
                        "OCC",
                        "U",
                        "CP",
                        "Strike",
                        "Exp",
                        "DTE",
                        "Qty",
                        "Avg",
                        "Mark",
                        "MV",
                        "uP&L",
                        "uRet%",
                        "Mark ts",
                        "Quality",
                        "Evidence",
                      ].map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: "4px 6px", borderBottom: "1px solid var(--border,#334)" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => (
                      <tr key={p.occSymbol}>
                        <td style={{ padding: "4px 6px" }}>{p.occSymbol}</td>
                        <td style={{ padding: "4px 6px" }}>{p.underlying ?? "—"}</td>
                        <td style={{ padding: "4px 6px" }}>{p.right ?? "—"}</td>
                        <td style={{ padding: "4px 6px" }}>{p.strike ?? "—"}</td>
                        <td style={{ padding: "4px 6px" }}>{p.expiration ?? "—"}</td>
                        <td style={{ padding: "4px 6px" }}>{p.dte ?? "—"}</td>
                        <td style={{ padding: "4px 6px" }}>{p.contracts}</td>
                        <td style={{ padding: "4px 6px" }}>{money(p.averageEntryCost)}</td>
                        <td style={{ padding: "4px 6px" }}>{p.currentMark == null ? "—" : money(p.currentMark)}</td>
                        <td style={{ padding: "4px 6px" }}>{money(p.marketValue)}</td>
                        <td style={{ padding: "4px 6px" }}>{money(p.unrealizedPnl)}</td>
                        <td style={{ padding: "4px 6px" }}>{pct(p.unrealizedReturnPct)}</td>
                        <td style={{ padding: "4px 6px" }}>{ts(p.markTimestampMs)}</td>
                        <td style={{ padding: "4px 6px" }}>
                          <StatusBadge
                            tone={
                              p.markStatus === "MISSING" || p.markStatus === "STALE" || p.markStatus === "ONE_SIDED"
                                ? "warn"
                                : "bull"
                            }
                          >
                            {p.markStatus}
                          </StatusBadge>
                        </td>
                        <td style={{ padding: "4px 6px" }}>
                          {p.evidenceChainId ? (
                            <button type="button" className="ui-btn ui-btn-sm" onClick={() => void openEvidence(p.evidenceChainId)}>
                              Open
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Orders & fills">
            {orders.length === 0 ? (
              <p>No orders.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12 }}>
                {orders.map((o) => (
                  <li key={o.id} style={{ borderTop: "1px solid var(--border,#334)", padding: "8px 0" }}>
                    <strong>{o.status}</strong> {o.side} {o.quantity} {o.symbol} · req {money(o.requestedPrice)} · fill{" "}
                    {money(o.fillPrice)} · slip {o.slippage ?? "—"} · fees {money(o.commissions)}
                    <br />
                    snapshot={o.marketSnapshotId ?? "n/a"} · legacy=
                    {o.legacyLinkage ? `${o.legacyLinkage.legacyTable}:${o.legacyLinkage.legacyId}` : "n/a"} · parity=
                    {o.parityStatus == null ? "n/a" : o.parityStatus.allMatched ? "matched" : "mismatch"}
                    {o.evidenceChainId ? (
                      <>
                        {" "}
                        ·{" "}
                        <button type="button" className="ui-btn ui-btn-sm" onClick={() => void openEvidence(o.evidenceChainId)}>
                          Evidence
                        </button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Equity curve (dollars)">
            {curve.length === 0 ? (
              <p>No equity snapshots.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12, maxHeight: 280, overflow: "auto" }}>
                {curve.map((p) => (
                  <li
                    key={`${p.atMs}-${p.totalEquity}`}
                    style={{
                      borderTop: "1px solid var(--border,#334)",
                      padding: "6px 0",
                      background: p.incomplete || p.staleOrMissingMarks ? "rgba(180,120,40,0.12)" : undefined,
                    }}
                  >
                    {ts(p.atMs)} · equity {money(p.totalEquity)} · realized {money(p.realizedPnl)} · unrealized{" "}
                    {money(p.unrealizedPnl)} · HWM {money(p.highWaterMark)} · DD {money(p.drawdownDollars)} /{" "}
                    {pct(p.drawdownPct)} · {p.completeness ?? "n/a"}
                    {p.incomplete || p.staleOrMissingMarks ? " · INCOMPLETE/STALE MARKS" : ""}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Ledger (append-only)">
            {ledger.length === 0 ? (
              <p>No ledger entries.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12, maxHeight: 320, overflow: "auto" }}>
                {ledger.map((e) => (
                  <li key={e.sequenceNum} style={{ borderTop: "1px solid var(--border,#334)", padding: "6px 0" }}>
                    #{e.sequenceNum} {e.entryKind} · cash Δ {money(e.cashDelta)} · reserved Δ {money(e.reservedDelta)} ·
                    cash after {money(e.cashBalanceAfter)} · BP {money(e.buyingPowerAfter)} · {e.refKind}:{e.refId}
                    {e.description ? ` · ${e.description}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {evidenceId && (
            <Card title={`Evidence chain · ${evidenceId}`}>
              {!evidence ? (
                <p>Unable to resolve evidence chain.</p>
              ) : (
                <ol style={{ fontSize: 12 }}>
                  {evidence.stages.map((s) => (
                    <li key={s.stage} style={{ marginBottom: 8 }}>
                      <strong>{s.stage}</strong>
                      <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0 0", fontSize: 11, opacity: 0.9 }}>
                        {JSON.stringify(s, null, 2).slice(0, 1200)}
                      </pre>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}
        </>
      )}
    </PageContainer>
  );
}

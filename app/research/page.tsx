"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client-auth";

/**
 * /research — READ-ONLY operational view of the multi-lane research rebuild (Phase 8).
 * Summary cards first, drill-down below. Inactive/missing-provider states are shown
 * honestly (never a misleading "healthy" green). No write controls. All paper — never
 * real money. Data comes from GET /api/research/overview (persisted state only).
 */

type Overview = Record<string, any>;

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: "#1a7f37", ACTIVE_READ_ONLY: "#1a7f37",
  INACTIVE_DISABLED: "#6b7280", INACTIVE_MISSING_DATA: "#b45309", INACTIVE_MISSING_PROVIDER: "#b45309", ERROR: "#b91c1c",
};

function Badge({ state }: { state: string }) {
  return <span style={{ background: STATUS_COLOR[state] ?? "#6b7280", color: "#fff", borderRadius: 6, padding: "2px 8px", fontSize: 12, fontWeight: 600 }}>{state}</span>;
}

export default function ResearchOverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiFetch("/api/research/overview");
        const j = await res.json();
        if (!alive) return;
        if (!res.ok || !j.ok) setError(j.error ?? `HTTP ${res.status}`);
        else setData(j.overview);
      } catch (e: any) {
        if (alive) setError(String(e?.message ?? e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (loading) return <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>Loading research overview…</main>;
  if (error) return <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}><h1>Research Overview</h1><p style={{ color: "#b91c1c" }}>Could not load: {error}</p><p style={{ color: "#6b7280" }}>This dashboard needs your OptiScan access token.</p></main>;

  const caps: any[] = Array.isArray(data?.capabilities) ? data!.capabilities : [];
  const funnel = data?.candidateFunnel ?? {};
  const ports = data?.portfolios?.portfolios ?? {};

  const Section = ({ title, obj }: { title: string; obj: any }) => (
    <details style={{ margin: "8px 0", border: "1px solid #e5e7eb", borderRadius: 8 }}>
      <summary style={{ cursor: "pointer", padding: "10px 14px", fontWeight: 600 }}>{title}{obj?.error ? " ⚠️" : ""}</summary>
      <pre style={{ margin: 0, padding: 14, overflowX: "auto", fontSize: 12, background: "#0b0f16", color: "#d1d5db", borderRadius: "0 0 8px 8px" }}>{JSON.stringify(obj ?? {}, null, 2)}</pre>
    </details>
  );

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 4 }}>Research Platform — Operational View</h1>
      <p style={{ color: "#6b7280", marginTop: 0 }}>Read-only · paper only (never real money) · new capabilities are OFF by default until explicitly enabled.</p>

      <h2 style={{ fontSize: 16 }}>Capabilities</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
        {caps.map((c) => (
          <div key={c.capability} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: 13 }}>{c.capability}</strong>
              <Badge state={c.runtimeState} />
            </div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>{c.reason}</div>
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 6 }}>
              wired: {String(c.wiredIntoLiveCycle)} · Discord: {String(c.canAffectDiscord)} · trades: {String(c.canCreatePaperTrades)}
            </div>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Candidate tiers</h2>
      {funnel?.available === false ? (
        <p style={{ color: "#6b7280" }}>No candidates captured yet — {funnel.note}.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
          {["PRODUCTION_QUALITY", "EXPERIMENTAL_VALID", "NEAR_MISS_VALID", "REJECTED_INVALID"].map((t) => (
            <div key={t} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{funnel?.byTier?.[t] ?? 0}</div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>{t}</div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Portfolios (independent — not mirrors)</h2>
      {Object.keys(ports).length === 0 ? (
        <p style={{ color: "#6b7280" }}>No paper trades yet.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
          {Object.entries(ports).map(([name, p]: [string, any]) => (
            <div key={name} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <strong>{name}</strong>
              <div style={{ fontSize: 12, color: "#6b7280" }}>{p.independent}</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>equity ${p.equity} · closed {p.closedTrades} · win {p.winRatePct ?? "—"}%</div>
              <div style={{ fontSize: 11, color: "#9ca3af" }}>cooldown: {p.cooldownScope}</div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 16, marginTop: 24 }}>All sections</h2>
      {["laneRouting", "experiments", "counterfactuals", "gateEffectiveness", "strategyAgents", "aiResearch", "replay", "sessionProvider"].map((k) => (
        <Section key={k} title={k} obj={data?.[k]} />
      ))}
    </main>
  );
}

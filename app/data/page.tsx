"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { useLiveTapeMap } from "@/hooks/useLiveTapeMap";
import { Panel } from "@/components/ui/Panel";
import { fmtPct } from "@/lib/format";

interface HealthBody {
  ok?: boolean;
  provider?: string;
  keyPresent?: boolean;
  loopRunning?: boolean;
  lastTickAgeMs?: number | null;
  session?: string | null;
  quotaExceeded?: boolean;
  ticks?: number | null;
  triggers?: number | null;
  alerts?: number | null;
  errors?: number | null;
  intervalMs?: number | null;
  note?: string | null;
  callsToday?: number | null;
  callsThisMinute?: number | null;
  dailyCap?: number | null;
  minuteCap?: number | null;
  dbWritable?: boolean | null;
}

type FhKind = "t" | "q" | "a" | "o";

interface FhLine {
  id: string;
  kind: FhKind;
  sym: string;
  text: string;
}

function fmtAge(ms: number | null | undefined) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function DataCorePage() {
  const tape = useLiveTapeMap(1000);
  const [health, setHealth] = useState<HealthBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store", headers: scanHeaders() });
      const body = (await res.json()) as HealthBody;
      setHealth(body);
      setError(body.ok === false ? "Health check degraded" : null);
    } catch (err: any) {
      setError(err?.message ?? "Health unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshHealth();
    const id = setInterval(refreshHealth, 5000);
    return () => clearInterval(id);
  }, [refreshHealth]);

  const quotaPct = useMemo(() => {
    if (health?.callsToday == null || health?.dailyCap == null || !health.dailyCap) return null;
    return Math.min(100, Math.round((health.callsToday / health.dailyCap) * 100));
  }, [health]);

  const firehose = useMemo(() => {
    const lines: FhLine[] = [];
    const now = Date.now();
    for (const r of tape.rows.slice(0, 24)) {
      const rate = r.shortRate ?? 0;
      const kind: FhKind = Math.abs(rate) >= 0.25 ? "t" : r.surge != null && r.surge >= 1.4 ? "q" : "o";
      lines.push({
        id: `${r.symbol}-${kind}`,
        kind,
        sym: r.symbol,
        text: `${rate > 0 ? "+" : ""}${rate.toFixed(2)}%/min · surge ${r.surge?.toFixed(2) ?? "—"} · ${fmtPct(r.movePct)} day`,
      });
    }
    if (health?.lastTickAgeMs != null) {
      lines.unshift({
        id: `loop-${now}`,
        kind: "a",
        sym: "LOOP",
        text: `tick ${fmtAge(health.lastTickAgeMs)} ago · ${health.ticks ?? 0} ticks · ${health.triggers ?? 0} triggers`,
      });
    }
    return lines.slice(0, 28);
  }, [tape.rows, health]);

  return (
    <div className="page-deck pg-data">
      <div className="page-deck-toolbar">
        <div className="alerts-tab-header muted">
          Data Core — Polygon health, loop counters, and live scanner firehose. Read-only telemetry.
        </div>
        <button type="button" className="pill btn btn-xs" onClick={refreshHealth} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className="axiom-alert-banner">
          <div className="label">Data core warning</div>
          <div className="sub">{error}</div>
        </div>
      ) : null}

      <div className="data-core-grid">
        <Panel title="Data core" meta={health?.provider ?? "Polygon"} live={Boolean(health?.loopRunning)}>
          <div className="dqgrid">
            <div className="dqtile">
              <div className="dqk">Provider</div>
              <div className="dqv">{health?.provider ?? "—"}</div>
            </div>
            <div className="dqtile">
              <div className="dqk">Session</div>
              <div className="dqv">{health?.session ?? "—"}</div>
            </div>
            <div className="dqtile">
              <div className="dqk">Loop</div>
              <div className={`dqv ${health?.loopRunning ? "" : "neg"}`}>{health?.loopRunning ? "RUN" : "OFF"}</div>
            </div>
            <div className="dqtile">
              <div className="dqk">Last tick</div>
              <div className="dqv">{fmtAge(health?.lastTickAgeMs)}</div>
            </div>
            <div className="dqtile">
              <div className="dqk">Alerts fired</div>
              <div className="dqv">{health?.alerts ?? "—"}</div>
            </div>
            <div className="dqtile">
              <div className="dqk">DB</div>
              <div className={`dqv ${health?.dbWritable === false ? "neg" : ""}`}>
                {health?.dbWritable == null ? "—" : health.dbWritable ? "OK" : "ERR"}
              </div>
            </div>
          </div>
          {health?.note ? <p className="muted text-xs data-core-note">{health.note}</p> : null}
        </Panel>

        <Panel
          title="API quota"
          meta={
            health?.callsToday != null && health?.dailyCap != null
              ? `${health.callsToday} / ${health.dailyCap} today`
              : "Polygon calls"
          }
        >
          <div className="bigstat data-quota-stat">
            <div className="bsk">Daily usage</div>
            <div className="bsv blue">{quotaPct != null ? `${quotaPct}%` : "—"}</div>
            <div className="bssub">
              {health?.callsThisMinute ?? "—"} / {health?.minuteCap ?? "—"} this minute
              {health?.quotaExceeded ? " · quota exceeded" : ""}
            </div>
            {quotaPct != null ? (
              <div className="bsbar">
                <div className="bsfill" style={{ width: `${quotaPct}%` }} />
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel
          title="Live firehose"
          meta={`${tape.transport.toUpperCase()} · ${tape.rows.length} movers`}
          live={tape.running}
          className="data-firehose-panel"
        >
          <div className="fh data-firehose">
            {firehose.length ? (
              firehose.map((line) => (
                <div key={line.id} className="fhl">
                  <span className={`fhch ${line.kind}`}>{line.kind.toUpperCase()}</span>
                  <span className="fhsym">{line.sym}</span>
                  <span className="fhtxt">{line.text}</span>
                </div>
              ))
            ) : (
              <div className="empty small">Firehose fills once the scanner loop publishes movers.</div>
            )}
          </div>
          <p className="muted text-xs data-core-foot">
            T = trigger-grade speed · Q = quote/surge · A = alert/loop · O = other · Tape via existing SSE stream
          </p>
        </Panel>
      </div>
    </div>
  );
}

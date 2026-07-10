"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";
import { useScannerStream } from "@/hooks/useScannerStream";

/**
 * Polygon Data Core + Firehose (read-only telemetry).
 * No new Polygon calls — reads existing /api/health + the live scanner stream.
 */

type Health = {
  ok?: boolean;
  provider?: string;
  keyPresent?: boolean;
  loopRunning?: boolean;
  lastTickAgeMs?: number;
  session?: string;
  ticks?: number;
  triggers?: number;
  alerts?: number;
  errors?: number;
  intervalMs?: number;
  callsToday?: number;
  dailyCap?: number;
  callsThisMinute?: number;
  minuteCap?: number;
  quotaExceeded?: boolean;
};

type Line = { id: string; ch: "T" | "Q" | "A" | "O"; sym: string; txt: string; tone: "up" | "dn" | "" };
type DataHealth = {
  market_session?: string;
  provider?: { connected?: boolean; last_latency_ms?: number | null; rate_limit_status?: string };
  freshness?: Record<string, { freshness_status?: string; symbol?: string; data_age_seconds?: number | null }>;
  stale_symbols?: string[];
  monitored_symbols?: string[];
};
type DiscordHealth = {
  webhooks?: Record<string, boolean>;
  summary?: { status: string; count: number }[];
  recentFailures?: { status: string; failure_reason?: string | null; webhook_name?: string }[];
};

const FIREHOSE_MAX = 16;
let firehoseSeq = 0;

export default function DataCorePage() {
  const { realtime: loop } = useScannerStream();
  const [health, setHealth] = useState<Health | null>(null);
  const [dataHealth, setDataHealth] = useState<DataHealth | null>(null);
  const [discordHealth, setDiscordHealth] = useState<DiscordHealth | null>(null);
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const d = (await res.json()) as Health;
        if (!cancelled) setHealth(d);
      } catch {
        /* best effort */
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const [dh, discord] = await Promise.all([
          fetch("/api/system/data-health", { cache: "no-store" }).then((r) => r.json()),
          fetch("/api/discord/health", { cache: "no-store" }).then((r) => r.json()),
        ]);
        if (!cancelled) {
          setDataHealth(dh);
          setDiscordHealth(discord);
        }
      } catch {
        /* telemetry only */
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Firehose = the real live tape, rendered as raw channel messages.
  const tape = ((loop?.tape ?? loop?.movers ?? []) as any[]) ?? [];
  useEffect(() => {
    if (!tape.length) return;
    const now = Date.now();
    const next: Line[] = tape.slice(0, 6).map((r: any, i: number) => {
      const move = typeof r.movePct === "number" ? r.movePct : 0;
      const tone: Line["tone"] = move > 0 ? "up" : move < 0 ? "dn" : "";
      const ch: Line["ch"] = r.hodBreak || r.lodBreak ? "A" : "T";
      const price = r.price != null ? `$${Number(r.price).toFixed(2)}` : "—";
      const spd = r.shortRate != null ? `${r.shortRate > 0 ? "+" : ""}${r.shortRate.toFixed(2)}%/m` : "";
      const seq = firehoseSeq++;
      return {
        id: `${ch}-${r.symbol ?? "UNK"}-${now}-${seq}-${i}`,
        ch,
        sym: r.symbol,
        txt: `${price} · ${move > 0 ? "+" : ""}${move.toFixed(2)}% ${spd ? `· ${spd}` : ""}`,
        tone,
      };
    });
    setLines((prev) => [...next, ...prev].slice(0, FIREHOSE_MAX));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loop?.lastTickAt, tape.length]);

  const rate = health?.callsThisMinute != null ? `${health.callsThisMinute}/${health.minuteCap ?? "—"}` : "—";
  const loopUp = Boolean(health?.loopRunning ?? loop?.running);
  const hasKey = Boolean(health?.keyPresent);
  const loopHint =
    loopUp
      ? "streaming ticks"
      : hasKey
        ? "idle — usually starts within ~2 min after dev restart"
        : "add MASSIVE/POLYGON_API_KEY to .env.local";
  const providerLabel = health?.provider === "polygon" ? "massive" : (health?.provider ?? "—");
  const clusterStat = (live: boolean) => (live ? "● LIVE" : hasKey ? "○ IDLE" : "○ DOWN");
  const clusters = [
    { name: "STOCKS", ch: "T · Q · A", ok: loopUp && hasKey },
    { name: "OPTIONS", ch: "O · A", ok: loopUp && hasKey },
    { name: "SCANNER LOOP", ch: `${health?.intervalMs ?? 1000}ms`, ok: loopUp },
  ];

  const freshnessRows = ["stock_quote", "one_minute_candle", "options_chain", "options_quote", "greeks", "news"].map((kind) => ({
    kind,
    sample: dataHealth?.freshness?.[kind],
  }));
  const sentCount = discordHealth?.summary?.find((s) => s.status === "SENT")?.count ?? 0;
  const failedCount = (discordHealth?.summary ?? [])
    .filter((s) => ["FAILED", "RETRYING", "SUPPRESSED", "NOT_CONFIGURED"].includes(s.status))
    .reduce((n, s) => n + Number(s.count ?? 0), 0);

  return (
    <div className="page-deck axiom-data">
      <div className="axiom-scan-sweep" aria-hidden />

      <div className="axiom-strip">
        <StatTile label="Provider" value={providerLabel} hint={health?.keyPresent ? "Massive key present" : "no key"} />
        <StatTile label="Loop" value={loopUp ? "RUNNING" : "IDLE"} hint={loopHint} />
        <StatTile label="Calls today" value={health?.callsToday != null ? `${health.callsToday}` : "—"} hint={`cap ${health?.dailyCap ?? "—"}`} />
        <StatTile label="Rate / min" value={rate} hint={health?.quotaExceeded ? "QUOTA HIT" : "within cap"} />
        <StatTile label="Freshness" value={dataHealth?.stale_symbols?.length ? "BLOCKING" : "OK"} hint={`${dataHealth?.stale_symbols?.length ?? 0} stale symbols`} />
        <StatTile label="Discord" value={failedCount ? "CHECK" : "OK"} hint={`${sentCount} sent · ${failedCount} needs review`} />
      </div>

      <p className="live-guide" style={{ marginBottom: 12 }}>
        <b>Feed health</b> = is the Massive data pipe + scanner loop running?
        <b> Live tick stream</b> = raw price ticks as they arrive (like a terminal tape).
      </p>

      <div className="axiom-hero-row" style={{ gridTemplateColumns: "minmax(0,0.9fr) minmax(0,1.1fr)" }}>
        <Panel title="Feed health" meta={`Massive · ${health?.session ?? "—"}`} live={loopUp}>
          {clusters.map((c) => (
            <div className="clrow" key={c.name}>
              <span className="cldot" style={c.ok ? undefined : { background: hasKey ? "#ffc879" : "#ff5162", boxShadow: hasKey ? "0 0 9px #ffc879" : "0 0 9px #ff5162" }} />
              <div className="clnamewrap">
                <span className="clname">{c.name}</span>
                <span className="clch">{c.ch}</span>
              </div>
              <span className="clstat">{clusterStat(c.ok)}</span>
            </div>
          ))}
          <div className="clrow">
            <span className="cldot" />
            <div className="clnamewrap">
              <span className="clname">THROUGHPUT</span>
              <span className="clch">ticks {health?.ticks ?? 0} · triggers {health?.triggers ?? 0} · alerts {health?.alerts ?? 0}</span>
            </div>
            <span className="clstat">{health?.errors ? `${health.errors} err` : "OK"}</span>
          </div>
        </Panel>

        <Panel title="Live tick stream" meta="TICKS AS THEY ARRIVE" live>
          <div className="fh">
            {lines.length ? (
              lines.map((l) => (
                <div className="fhl" key={l.id}>
                  <span className={`fhch ${l.ch.toLowerCase()}`}>{l.ch}</span>
                  <span className="fhsym">{l.sym}</span>
                  <span className={`fhtxt ${l.tone}`}>{l.txt}</span>
                </div>
              ))
            ) : (
              <div className="sigwhy">
                {loopUp
                  ? "Waiting for first tick on the tape…"
                  : hasKey
                    ? "Scanner loop is idle — start dev server or wait ~2 min for the lock to clear."
                    : "No Polygon key — add POLYGON_API_KEY to .env.local"}
              </div>
            )}
          </div>
        </Panel>
      </div>

      <div className="axiom-hero-row" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", marginTop: 14 }}>
        <Panel title="Actionable data freshness" meta={dataHealth?.market_session ?? "session unknown"} live={!dataHealth?.stale_symbols?.length}>
          {freshnessRows.map(({ kind, sample }) => (
            <div className="clrow" key={kind}>
              <span className="cldot" style={sample?.freshness_status === "LIVE" || sample?.freshness_status === "DEGRADED" ? undefined : { background: "#ff5162", boxShadow: "0 0 9px #ff5162" }} />
              <div className="clnamewrap">
                <span className="clname">{kind.replaceAll("_", " ").toUpperCase()}</span>
                <span className="clch">{sample?.symbol ?? "no sample yet"} · age {sample?.data_age_seconds ?? "n/a"}s</span>
              </div>
              <span className="clstat">{sample?.freshness_status ?? "NO_DATA"}</span>
            </div>
          ))}
          {!dataHealth?.monitored_symbols?.length ? (
            <div className="sigwhy">No freshness samples yet. The scanner will populate this after the next provider responses.</div>
          ) : null}
        </Panel>

        <Panel title="Discord delivery" meta="webhook + retry ledger" live={!failedCount}>
          {(["options", "stocks", "recap"] as const).map((kind) => (
            <div className="clrow" key={kind}>
              <span className="cldot" style={discordHealth?.webhooks?.[kind] ? undefined : { background: "#ffc879", boxShadow: "0 0 9px #ffc879" }} />
              <div className="clnamewrap">
                <span className="clname">{kind.toUpperCase()} WEBHOOK</span>
                <span className="clch">{discordHealth?.webhooks?.[kind] ? "configured" : "not configured"}</span>
              </div>
              <span className="clstat">{discordHealth?.webhooks?.[kind] ? "OK" : "MISSING"}</span>
            </div>
          ))}
          {discordHealth?.recentFailures?.length ? (
            <div className="sigwhy">
              Latest Discord issue: {discordHealth.recentFailures[0].status} · {discordHealth.recentFailures[0].failure_reason ?? discordHealth.recentFailures[0].webhook_name}
            </div>
          ) : (
            <div className="sigwhy">No recent Discord delivery failures in the new ledger.</div>
          )}
        </Panel>
      </div>

      <p className="foot" style={{ marginTop: "1rem", color: "var(--muted)", fontSize: ".72rem" }}>
        Read-only telemetry from your Massive feed. No extra API calls.
      </p>
    </div>
  );
}

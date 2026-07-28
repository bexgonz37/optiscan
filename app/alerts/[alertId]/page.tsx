import Link from "next/link";
import { notFound } from "next/navigation";
import { getAlertDetail } from "@/lib/alert-store";
import { fmtMarketTime, fmtPct, fmtPrice } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function value(v: unknown): string {
  if (v == null || v === "") return "missing";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "missing";
  return String(v);
}

function pct(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? fmtPct(n) : "missing";
}

function price(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? fmtPrice(n) : "missing";
}

function DetailGrid({ rows }: { rows: Array<[string, unknown]> }) {
  return (
    <div className="alert-detail-grid">
      {rows.map(([k, v]) => (
        <div key={k} className="alert-detail-kv">
          <span>{k}</span>
          <b>{value(v)}</b>
        </div>
      ))}
    </div>
  );
}

function Section({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className="alert-detail-section">
      <div className="alert-detail-section-head">
        <h2>{title}</h2>
        {meta ? <span>{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

export default async function AlertDetailPage({ params }: { params: Promise<{ alertId: string }> }) {
  const { alertId } = await params;
  const id = Number(alertId);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const detail = getAlertDetail(id);
  if (!detail) notFound();

  const meta = detail.metadata;
  const cls = detail.classification;
  const alert = detail.alert;
  const discord = detail.discord;
  const proof = detail.deliveryProof ?? [];
  const timeline = detail.timeline ?? [];
  const returns = detail.returnCalculations ?? [];
  const snapshots = detail.pricePath?.snapshots ?? detail.snapshots ?? [];

  return (
    <main className="alert-detail-page">
      <div className="alert-detail-back">
        <Link href="/alerts?tab=history">Back to Alerts</Link>
      </div>

      <header className="alert-detail-hero">
        <div>
          <span className={`alert-detail-badge ${cls.verifiedDelivered ? "ok" : "warn"}`}>{cls.badge}</span>
          <h1>
            {meta.symbol} {meta.strike != null ? `$${meta.strike}` : ""} {String(meta.side ?? "").toUpperCase()}
          </h1>
          <p>
            {meta.optionSymbol ?? "No OCC"} - {alert.trading_day ?? "no date"} - {fmtMarketTime(alert.alert_time)}
          </p>
        </div>
        <div className="alert-detail-status">
          <span>{cls.finalStatus}</span>
          <b>{cls.lane}</b>
        </div>
      </header>

      {!cls.verifiedDelivered ? (
        <div className="alert-detail-warning">
          <b>NO VERIFIED DISCORD DELIVERY</b>
          <span>{cls.suppressionReason ?? "No subscriber Discord message proof was found for this row."}</span>
        </div>
      ) : null}

      <Section title="Identity">
        <DetailGrid rows={[
          ["Alert ID", meta.alertId],
          ["Opportunity case ID", meta.opportunityCaseId],
          ["Opportunity fingerprint", meta.opportunityFingerprint],
          ["Independent alert ID", meta.independentAlertId],
          ["Paper trade ID", meta.paperTradeId],
          ["Discord message ID", meta.discordMessageId],
          ["OCC", meta.optionSymbol],
          ["Strike", meta.strike],
          ["Expiration", meta.expiration],
          ["DTE", meta.dte],
          ["Setup family", meta.setupFamily],
          ["Direction", meta.direction],
          ["Confidence", meta.confidence],
        ]} />
      </Section>

      <Section title="Delivery Proof" meta={detail.proofSummary?.status}>
        <div className="alert-detail-table-wrap">
          <table className="alert-detail-table">
            <thead><tr><th>Check</th><th>Status</th><th>Source</th><th>Detail</th></tr></thead>
            <tbody>
              {proof.map((p: any) => (
                <tr key={p.label}>
                  <td>{p.label}</td>
                  <td className={p.status === "PASS" ? "pos" : p.status === "FAIL" ? "neg" : "muted"}>{p.status}</td>
                  <td>{p.source}</td>
                  <td>{p.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Timeline">
        <div className="alert-detail-timeline">
          {timeline.length ? timeline.map((e: any, i: number) => (
            <div key={`${e.timestamp}-${i}`} className="alert-detail-event">
              <span className="num">{e.timestamp ? fmtMarketTime(e.timestamp) : "time missing"}</span>
              <b>{e.label}</b>
              <em>{e.source}</em>
              <p>{e.detail || "No detail recorded"}</p>
            </div>
          )) : <p className="muted text-sm">No lifecycle events recorded.</p>}
        </div>
      </Section>

      <Section title="Discord Payload" meta={discord.sent ? "verified sent" : "not sent"}>
        {discord.sent ? (
          <pre className="alert-detail-pre">{discord.payloadText ?? JSON.stringify(discord.payload, null, 2)}</pre>
        ) : (
          <div className="alert-detail-empty">
            NO VERIFIED DISCORD DELIVERY
            {discord.suppressionReason ? <span>{discord.suppressionReason}</span> : null}
          </div>
        )}
      </Section>

      <Section title="Entry And Contract">
        <DetailGrid rows={[
          ["Frozen entry mid", price(detail.entryDetails?.frozenEntry)],
          ["Detection bid", price(detail.entryDetails?.frozenBid)],
          ["Detection ask", price(detail.entryDetails?.frozenAsk)],
          ["Entry source", detail.entryDetails?.entrySource],
          ["Volume", detail.entryDetails?.entrySnapshot?.volume ?? alert.volume],
          ["Open interest", detail.entryDetails?.entrySnapshot?.open_interest],
          ["Spread %", pct(detail.entryDetails?.entrySnapshot?.spread_pct)],
          ["Delta", detail.entryDetails?.entrySnapshot?.delta],
        ]} />
      </Section>

      <Section title="Return Calculation">
        <div className="alert-detail-table-wrap">
          <table className="alert-detail-table">
            <thead><tr><th>Convention</th><th>Entry</th><th>Exit</th><th>Return</th><th>1-contract P/L</th></tr></thead>
            <tbody>
              {returns.map((r: any) => (
                <tr key={r.label}>
                  <td><b>{r.label}</b><br /><span className="muted text-xs">{r.convention}</span></td>
                  <td>{price(r.entry)}</td>
                  <td>{price(r.exit)}</td>
                  <td className={Number(r.returnPct ?? 0) >= 0 ? "pos" : "neg"}>{pct(r.returnPct)}</td>
                  <td>{r.oneContractPnl != null ? fmtPrice(r.oneContractPnl) : "missing"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Price Path">
        <div className="alert-detail-table-wrap">
          <table className="alert-detail-table">
            <thead><tr><th>Time</th><th>Checkpoint</th><th>Bid</th><th>Ask</th><th>Mid</th><th>Spread</th></tr></thead>
            <tbody>
              {snapshots.map((s: any, i: number) => (
                <tr key={`${s.taken_at}-${i}`}>
                  <td>{s.taken_at ? fmtMarketTime(s.taken_at) : "missing"}</td>
                  <td>{s.checkpoint ?? "mark"}</td>
                  <td>{price(s.bid)}</td>
                  <td>{price(s.ask)}</td>
                  <td>{price(s.mid)}</td>
                  <td>{pct(s.spread_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Missed Opportunity">
        <div className="alert-detail-empty">
          {detail.missedOpportunity?.explanation}
        </div>
      </Section>
    </main>
  );
}

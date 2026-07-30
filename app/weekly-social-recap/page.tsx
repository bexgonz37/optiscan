"use client";

/**
 * Weekly Social Recap — PRIVATE owner tool.
 *
 * Generates deterministic weekly recap drafts for the owner to review, edit, copy,
 * and post BY HAND. There is deliberately no post, send, or schedule action anywhere
 * on this page: the only outputs are Copy and Export text.
 */

import { useCallback, useEffect, useState } from "react";
import { PageContainer, PageHeader, Card, LoadingState, ErrorState } from "@/components/ui/Shell";
import { apiFetchJson, describeApiLoadFailure } from "@/lib/client-auth";

type Draft = {
  style: string;
  label: string;
  text: string;
  parts: string[];
  wordingOk: boolean;
  wordingViolations: Array<{ phrase: string; why: string }>;
  validation: { ok: boolean; failures: Array<{ kind: string; detail: string }> };
};

type LaneTotals = {
  eligibleCallouts: number;
  closedCallouts: number;
  openCallouts: number;
  winners: number;
  losers: number;
  winRatePct: number | null;
  combinedPeakMovePct: number | null;
  combinedTrackedResultPct: number | null;
  averageTrackedPct: number | null;
  bestPeak: { contractLabel: string; pct: number } | null;
  bestTracked: { contractLabel: string; pct: number } | null;
  largestLoss: { contractLabel: string; pct: number } | null;
  profitGivenBackCount: number;
};

type Recap = {
  window: { label: string; startDay: string; endDay: string; tradingDays: string[]; holidaysSkipped: string[] };
  verifiedSubscriber: LaneTotals;
  researchOnly: LaneTotals;
  watchlist: LaneTotals;
  callouts: { verifiedSubscriber: any[]; researchOnly: any[]; watchlist: any[] };
  exclusions: Array<{ alertId: string; symbol: string; reason: string }>;
  warnings: string[];
  lowSample: boolean;
  labels: { combinedPeak: string; combinedTracked: string };
};

type Response = {
  recap?: Recap;
  drafts?: Draft[];
  styles?: Array<{ id: string; label: string }>;
  aiRewrite?: { ok: boolean; status: string; note: string; variants: Array<{ text: string }>; rejected: unknown[] } | null;
};

const pct = (n: number | null | undefined) =>
  n == null || !Number.isFinite(Number(n)) ? "unavailable" : `${Number(n) < 0 ? "-" : "+"}${Math.abs(Number(n)).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

function mondayOf(date: Date): string {
  const d = new Date(date);
  const day = d.getUTCDay();
  const delta = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export default function WeeklySocialRecapPage() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [week, setWeek] = useState<string>("");
  const [verifiedOnly, setVerifiedOnly] = useState(true);
  const [includeOpen, setIncludeOpen] = useState(false);
  const [includeWatchlist, setIncludeWatchlist] = useState(true);
  const [style, setStyle] = useState<string>("ALL");
  const [useAi, setUseAi] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (week) params.set("week", week);
      if (verifiedOnly) params.set("verifiedOnly", "1");
      if (includeOpen) params.set("includeOpen", "1");
      if (!includeWatchlist) params.set("includeWatchlist", "0");
      if (style !== "ALL") params.set("style", style);
      if (useAi) params.set("ai", "1");
      const res = await apiFetchJson<Response>(`/api/research/social/weekly-recap?${params.toString()}`);
      if (!res.ok || !res.data) {
        setError(describeApiLoadFailure(res));
        return;
      }
      setData(res.data);
    } catch (err: any) {
      setError({ title: "Could not generate the recap", detail: err?.message ?? "Unknown error" });
    } finally {
      setLoading(false);
    }
  }, [week, verifiedOnly, includeOpen, includeWatchlist, style, useAi]);

  useEffect(() => { void generate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 2000);
    } catch { /* clipboard unavailable; the textarea is still selectable */ }
  }, []);

  const exportText = useCallback((text: string, name: string) => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const recap = data?.recap ?? null;
  const t = recap?.verifiedSubscriber;

  return (
    <PageContainer>
      <PageHeader
        title="Weekly Social Recap"
        subtitle="Private owner drafts. Nothing here posts, sends, or schedules — copy and post manually."
      />

      <Card title="Controls">
        <div className="recap-controls">
          <label>
            Week (Monday, ET)
            <input
              type="date"
              value={week}
              onChange={(e) => setWeek(e.target.value ? mondayOf(new Date(e.target.value)) : "")}
            />
            <small>Blank uses the most recent completed Mon-Fri week.</small>
          </label>
          <label className="recap-check">
            <input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} />
            Verified subscriber only
          </label>
          <label className="recap-check">
            <input type="checkbox" checked={includeOpen} onChange={(e) => setIncludeOpen(e.target.checked)} />
            Include open trades (peaks only; never tracked results)
          </label>
          <label className="recap-check">
            <input type="checkbox" checked={includeWatchlist} onChange={(e) => setIncludeWatchlist(e.target.checked)} />
            Include Watchlist section
          </label>
          <label>
            Draft style
            <select value={style} onChange={(e) => setStyle(e.target.value)}>
              <option value="ALL">All styles</option>
              {(data?.styles ?? []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className="recap-check">
            <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
            AI wording variations (numbers are locked)
          </label>
          <button type="button" onClick={generate} disabled={loading}>
            {loading ? "Generating..." : "Generate"}
          </button>
        </div>
        <p className="recap-note">
          Deterministic code computes every number and selects every eligible row. AI may only rewrite
          wording, and any variant whose figures or tickers do not match the report is discarded.
        </p>
      </Card>

      {loading && !recap ? <Card title="Generating"><LoadingState rows={4} /></Card> : null}
      {error ? <ErrorState title={error.title} detail={error.detail} /> : null}

      {recap && t ? (
        <>
          <Card title="Verified subscriber callouts" meta={recap.window.label}>
            {recap.warnings.length ? (
              <div className="recap-warnings">
                {recap.warnings.map((w) => <p key={w}>{w}</p>)}
              </div>
            ) : null}
            <div className="recap-grid">
              <span><strong>Eligible callouts</strong>{t.eligibleCallouts}</span>
              <span><strong>Closed</strong>{t.closedCallouts}</span>
              <span><strong>Open</strong>{t.openCallouts}</span>
              <span><strong>Winners</strong>{t.winners}</span>
              <span><strong>Losers</strong>{t.losers}</span>
              <span><strong>Win rate</strong>{t.winRatePct == null ? "unavailable" : `${t.winRatePct}%`}</span>
              <span><strong>{recap.labels.combinedPeak}</strong>{pct(t.combinedPeakMovePct)}</span>
              <span><strong>{recap.labels.combinedTracked}</strong>{pct(t.combinedTrackedResultPct)}</span>
              <span><strong>Average callout (tracked)</strong>{pct(t.averageTrackedPct)}</span>
              <span><strong>Profit given back</strong>{t.profitGivenBackCount}</span>
              <span className="wide"><strong>Highest verified peak</strong>{t.bestPeak ? `${t.bestPeak.contractLabel} ${pct(t.bestPeak.pct)}` : "none"}</span>
              <span className="wide"><strong>Highest tracked result</strong>{t.bestTracked ? `${t.bestTracked.contractLabel} ${pct(t.bestTracked.pct)}` : "none"}</span>
              <span className="wide"><strong>Largest loss</strong>{t.largestLoss ? `${t.largestLoss.contractLabel} ${pct(t.largestLoss.pct)}` : "none"}</span>
            </div>
            <p className="recap-note">
              {recap.labels.combinedPeak} is the sum of individual callout peaks — not a portfolio return,
              account return, or realized result. OptiScan can verify what a callout did; it cannot prove
              any person entered, exited, or captured it.
            </p>
          </Card>

          {recap.callouts.researchOnly.length ? (
            <Card title="Research-only callouts" meta="Never sent to subscribers · never counted in subscriber totals">
              <div className="recap-list">
                {recap.callouts.researchOnly.map((c: any) => (
                  <p key={c.alertId}>{c.contractLabel} · peak {pct(c.peakPct)} · {c.status === "OPEN" ? "OPEN" : `tracked ${pct(c.trackedPct)}`}</p>
                ))}
              </div>
            </Card>
          ) : null}

          {recap.callouts.watchlist.length ? (
            <Card
              title="Watchlist → verified callouts"
              meta="Not included in subscriber totals"
            >
              <p className="recap-note">
                Watchlist symbols that later produced a verified subscriber callout during the
                selected period.
              </p>
              <div className="recap-warnings">
                <p>
                  Watchlist outcome tracking is not yet available, so no result is assigned to the
                  Watchlist plan itself. The figures below belong to the verified subscriber callout
                  that followed. Nothing here implies the original Watchlist trigger was entered.
                </p>
              </div>
              <div className="recap-list">
                {recap.callouts.watchlist.map((c: any) => (
                  <p key={`wl-${c.alertId}`}>
                    {c.symbol} — later produced verified callout {c.contractLabel} (peak {pct(c.peakPct)},{" "}
                    {c.status === "OPEN" ? "still open" : `tracked ${pct(c.trackedPct)}`})
                  </p>
                ))}
              </div>
            </Card>
          ) : null}

          {recap.exclusions.length ? (
            <Card title="Excluded rows" meta={`${recap.exclusions.length} excluded`}>
              <div className="recap-list">
                {recap.exclusions.map((e, i) => (
                  <p key={`${e.alertId}-${i}`}>{e.symbol || e.alertId}: {e.reason}</p>
                ))}
              </div>
            </Card>
          ) : null}

          {data?.aiRewrite ? (
            <Card title="AI wording variations" meta={data.aiRewrite.status}>
              <p className="recap-note">{data.aiRewrite.note}</p>
              {data.aiRewrite.variants.map((v, i) => (
                <div key={`ai-${i}`} className="recap-draft">
                  <div className="recap-draft-head">
                    <strong>Variation {i + 1}</strong>
                    <span>
                      <button type="button" onClick={() => copy(v.text, `ai-${i}`)}>{copied === `ai-${i}` ? "Copied" : "Copy"}</button>
                      <button type="button" onClick={() => exportText(v.text, `optiscan-weekly-ai-${i + 1}.txt`)}>Export text</button>
                    </span>
                  </div>
                  <textarea readOnly rows={12} value={v.text} />
                </div>
              ))}
              {data.aiRewrite.rejected.length ? (
                <p className="recap-warnings">
                  {data.aiRewrite.rejected.length} AI variant(s) were discarded for failing numeric validation.
                </p>
              ) : null}
            </Card>
          ) : null}

          {(data?.drafts ?? []).map((d) => (
            <Card key={d.style} title={d.label} meta={d.validation.ok ? "numbers validated" : "VALIDATION FAILED"}>
              {!d.validation.ok || !d.wordingOk ? (
                <div className="recap-warnings">
                  {d.validation.failures.map((f, i) => <p key={`f-${i}`}>{f.kind}: {f.detail}</p>)}
                  {d.wordingViolations.map((v, i) => <p key={`w-${i}`}>Wording: &quot;{v.phrase}&quot; {v.why}</p>)}
                </div>
              ) : null}
              <div className="recap-draft">
                <div className="recap-draft-head">
                  <strong>{d.parts.length > 1 ? `${d.parts.length} parts` : "Single post"}</strong>
                  <span>
                    <button type="button" onClick={() => copy(d.text, d.style)}>{copied === d.style ? "Copied" : "Copy"}</button>
                    <button type="button" onClick={() => exportText(d.text, `optiscan-weekly-${d.style.toLowerCase()}.txt`)}>Export text</button>
                  </span>
                </div>
                <textarea readOnly rows={d.parts.length > 1 ? 18 : 14} value={d.text} />
              </div>
            </Card>
          ))}
        </>
      ) : null}
    </PageContainer>
  );
}

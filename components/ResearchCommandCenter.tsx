"use client";

/**
 * ResearchCommandCenter — the PRIVATE research view.
 *
 * One page the owner can open and understand: what happened today, what the forward
 * edge currently is, what the shadow experiment has and has not established, what the
 * system has learned, what the open risk questions are, and how early the callouts
 * actually were.
 *
 * ── What this deliberately is not ─────────────────────────────────────────────
 *
 * Not an engineering diagnostics dump. Every number is rendered with its denominator,
 * its population and its evidence state, because the same profit factor means opposite
 * things over 6 trades and over 60. Raw JSON lives behind disclosures, never in the
 * reading path.
 *
 * ── Three things the layout is responsible for ────────────────────────────────
 *
 * 1. OPENED TODAY and CLOSED TODAY are separate tiles that are never adjacent to a
 *    total, because 42 of 74 owner callouts cross a session boundary and a single
 *    "today" number would be wrong for more than half of them.
 * 2. SHADOW DOES NOT AFFECT LIVE CALLOUTS is a banner on the experiment card, not a
 *    footnote under it, and an INSUFFICIENT_EVIDENCE experiment is rendered in a muted
 *    tone so a promising-looking arm cannot read as a proven one.
 * 3. Owner-validation evidence is labelled as such on every card that carries it.
 *    Nothing on this page is subscriber performance.
 *
 * Subscribers never see this surface. Nothing here can change a threshold, promote an
 * experiment, enable delivery, or post anything anywhere.
 */

import { useCallback, useEffect, useState } from "react";
import {
  PageContainer, ResponsiveGrid, Card, KeyValue, StatusBadge,
  LoadingState, ErrorState, DetailsDisclosure,
} from "@/components/ui/Shell";
import { InfoTip } from "@/components/InfoTip";
import { apiFetchJson } from "@/lib/client-auth";
import { authHeaders } from "@/lib/client-auth";

type Nullable = number | null;

type Panels = {
  today: {
    sessionDate: string; openedToday: number; closedToday: number; wins: number;
    losses: number; openNow: number; winRate: Nullable; expectancyPct: Nullable;
    profitFactor: Nullable; meanReturnPct: Nullable; medianReturnPct: Nullable;
    closedTodayOpenedEarlier: number; note: string;
  };
  currentEdge: {
    population: string; sampleSize: number; independentSessions: number;
    dateRange: { from: string | null; to: string | null };
    evidenceState: string; excursionEvidenceState: string;
    profitFactor: Nullable; expectancyPct: Nullable; medianReturnPct: Nullable;
    winRate: Nullable; profitFactorExBest: Nullable;
    avgWinnerPct: Nullable; avgLoserPct: Nullable;
    expectedMfePct: Nullable; expectedMaePct: Nullable;
    probabilities: Record<string, { rate: Nullable; reached: number; of: number }>;
    limitations: string[];
  };
  shadowExperiments: Array<{
    experimentId: string; experimentVersion: number; mode: string;
    definitionHash: string; definitionFrozen: boolean; prospectiveStartDate: string;
    status: string; statusReason: string;
    prospectiveClosedOutcomes: number; requiredClosedOutcomes: number;
    independentSessions: number; requiredIndependentSessions: number;
    baseline: { profitFactor: Nullable; expectancyPct: Nullable; medianReturnPct: Nullable; winRate: Nullable; sampleSize: number };
    shadow: { profitFactor: Nullable; expectancyPct: Nullable; medianReturnPct: Nullable; winRate: Nullable; sampleSize: number };
    winnerRetention: Nullable; lossRejection: Nullable; winnersRejected: Nullable;
    profitFactorExBest: Nullable; tailRobustness: string;
    limitations: string[];
  }>;
  learned: {
    deterministicFindings: Array<{ key: string; title: string; statement: string; evidenceStrength: string; sampleSize: Nullable; limitations: string[] }>;
    aiFindings: Array<{ key: string; title: string; statement: string; evidenceStrength: string; sampleSize: Nullable; limitations: string[] }>;
    insufficientEvidence: string[];
  };
  riskResearch: {
    cards: Array<{ id: string; title: string; headline: string; detail: string; sampleSize: Nullable; supported: boolean }>;
    note: string;
  };
  earlyDiscovery: any;
  earlyDiscoveryV1Caveat: { stage: string; share: string; whyUnusable: string };
  readiness: {
    buckets: Array<{
      id: string; title: string;
      facts: Array<{ label: string; value: string | number | null }>;
      blocking: string[];
    }>;
    subscriberReady: false;
    humanApprovalRequired: true;
    note: string;
  };
  faults: string[];
};

type Payload = {
  report: Panels;
  budget: { spendUsd?: number; hardLimitUsd?: number; remainingUsd?: number; status?: string } | null;
};

type ExplainState = {
  key: string;
  loading: boolean;
  error: string | null;
  data: any | null;
};

// ── formatting ───────────────────────────────────────────────────────────────
//
// A null is rendered as an em dash and NEVER as 0. "No trades closed today" and "the
// trades that closed today averaged zero" are different statements, and a 0 in place
// of an unknown is the single easiest way for this page to lie.
const NA = "—";
const num = (v: Nullable, digits = 2): string => (v == null ? NA : v.toFixed(digits));
const pct = (v: Nullable): string => (v == null ? NA : `${(v * 100).toFixed(1)}%`);
const signed = (v: Nullable): string => (v == null ? NA : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

function statusTone(status: string): "bull" | "warn" | "bear" | "muted" {
  if (status === "READY_FOR_HUMAN_REVIEW") return "warn";
  if (status === "PROMISING") return "warn";
  if (status === "FAILED" || status === "WEAKENING") return "bear";
  return "muted";
}

/**
 * Risk cards to glossary keys. The definition lives in `lib/metric-glossary.ts` and is
 * never restated here — one wording in one place is the only way the tooltip on a card
 * and the explanation behind it cannot drift.
 */
const RISK_CARD_METRIC: Record<string, string> = {
  GOOD_MOVE_THEN_REVERSED: "giveback",
  EVENTUAL_T1_WINNER: "mfe",
  STOP_LEAKAGE: "stopLeakage",
  OPENING_BELL_GAPS: "stopLeakage",
};

function evidenceTone(state: string): "bull" | "warn" | "muted" {
  if (state === "SUPPORTED") return "bull";
  if (state === "INSUFFICIENT_EVIDENCE") return "muted";
  return "warn";
}

export function ResearchCommandCenter() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [explain, setExplain] = useState<ExplainState | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetchJson<any>("/api/research/command-center", { cache: "no-store" });
      if (!r.ok || !r.data?.report) throw new Error(r.message ?? "could not load research evidence");
      setData({ report: r.data.report, budget: r.data.budget ?? null });
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not load research evidence.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Ask OptiScan about one thing, by its stable id.
   *
   * The id is passed straight through — a case id, an experiment id, a metric key.
   * Nothing here reconstructs a trade from the text on the card it was clicked from.
   */
  const askExplain = useCallback(async (kind: string, id: string, population?: string) => {
    const key = `${kind}:${id}:${population ?? ""}`;
    setExplain({ key, loading: true, error: null, data: null });
    try {
      const res = await fetch("/api/research/explain", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ kind, id, population }),
      });
      const j = await res.json();
      if (!j?.ok) throw new Error(j?.error ?? "explanation unavailable");
      setExplain({ key, loading: false, error: null, data: j });
    } catch (err: any) {
      setExplain({ key, loading: false, error: err?.message ?? "explanation unavailable", data: null });
    }
  }, []);

  const ExplainButton = ({ kind, id, population, label = "Explain this" }: {
    kind: string; id: string; population?: string; label?: string;
  }) => (
    <button
      type="button"
      className="ui-btn-ghost"
      onClick={() => askExplain(kind, id, population)}
      style={{ fontSize: 11, padding: "2px 8px", cursor: "pointer" }}
    >
      {label}
    </button>
  );

  if (error && !data) return <PageContainer><ErrorState detail={error} onRetry={load} /></PageContainer>;
  if (!data) return <PageContainer><Card title="Loading research evidence"><LoadingState rows={5} /></Card></PageContainer>;

  const r = data.report;
  const t = r.today;
  const e = r.currentEdge;
  const v2 = r.earlyDiscovery;

  return (
    <PageContainer>
      <Card
        title="Research Command Center"
        meta="OWNER ONLY · owner-validation evidence · nothing here is subscriber performance"
      >
        <p style={{ fontSize: 12, opacity: 0.8, margin: 0 }}>
          Every figure below comes from the private callouts&rsquo; own paper mirrors on the exact
          contract that was called. No subscriber received these trades. No experiment on this page
          has any live authority and none can promote itself.
        </p>
        {r.faults.length ? (
          <p style={{ fontSize: 11, color: "#e0a020", marginTop: 8 }}>
            Some panels could not be built: {r.faults.join(" · ")}
          </p>
        ) : null}
      </Card>

      {/* ── TODAY ────────────────────────────────────────────────────────── */}
      <Card title={`Today — ${t.sessionDate}`} meta="Opened and closed are different populations and are never summed">
        <ResponsiveGrid min={150}>
          <Tile label="Opened today" value={String(t.openedToday)} hint="callouts sent today" />
          <Tile
            label="Closed today"
            value={String(t.closedToday)}
            hint={t.closedTodayOpenedEarlier > 0
              ? `${t.closedTodayOpenedEarlier} opened on an earlier session`
              : "all opened today"}
          />
          <Tile label="Open now" value={String(t.openNow)} hint="no result yet — excluded from the rates" />
          <Tile label="Wins" value={String(t.wins)} hint="of the trades that closed today" />
          <Tile label="Losses" value={String(t.losses)} hint="of the trades that closed today" />
        </ResponsiveGrid>
        <ResponsiveGrid min={150}>
          <Tile metric="winRate" label="Win rate" value={pct(t.winRate)} hint={`${t.wins}/${t.closedToday} closed`} />
          <Tile metric="expectancy" label="Expectancy" value={signed(t.expectancyPct)} hint="mean realized return" />
          <Tile metric="profitFactor" label="Profit factor" value={num(t.profitFactor)} hint="gross gains ÷ gross losses" />
          <Tile metric="meanReturn" label="Mean return" value={signed(t.meanReturnPct)} />
          <Tile metric="medianReturn" label="Median return" value={signed(t.medianReturnPct)} />
        </ResponsiveGrid>
        <p style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>{t.note}</p>
      </Card>

      {/* ── CURRENT EDGE ─────────────────────────────────────────────────── */}
      <Card
        title="Current edge"
        meta={`${e.population} · ${e.dateRange.from ?? "?"} to ${e.dateRange.to ?? "?"}`}
        actions={<ExplainButton kind="COHORT" id="CURRENT_EDGE" label="Explain this population" />}
      >
        <div style={{ marginBottom: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <StatusBadge tone={evidenceTone(e.evidenceState)}>REALIZED: {e.evidenceState}</StatusBadge>
          <StatusBadge tone={evidenceTone(e.excursionEvidenceState)}>EXCURSION: {e.excursionEvidenceState}</StatusBadge>
          <StatusBadge tone="muted">OWNER VALIDATION / PAPER-TRACKED</StatusBadge>
        </div>
        <ResponsiveGrid min={150}>
          <Tile metric="sampleSize" label="Sample size" value={String(e.sampleSize)} hint="closed outcomes" />
          <Tile metric="independentSessions" label="Independent sessions" value={String(e.independentSessions)} />
          <Tile metric="profitFactor" label="Profit factor" value={num(e.profitFactor)} explain={{ kind: "METRIC", id: "profitFactor" }} onExplain={askExplain} />
          <Tile metric="expectancy" label="Expectancy" value={signed(e.expectancyPct)} explain={{ kind: "METRIC", id: "expectancy" }} onExplain={askExplain} />
          <Tile metric="medianReturn" label="Median return" value={signed(e.medianReturnPct)} />
          <Tile metric="winRate" label="Win rate" value={pct(e.winRate)} />
          <Tile
            metric="profitFactorExBest"
            label="PF ex-best"
            value={num(e.profitFactorExBest)}
            hint="how much of the result is one trade"
            explain={{ kind: "METRIC", id: "profitFactorExBest" }}
            onExplain={askExplain}
          />
        </ResponsiveGrid>
        <ResponsiveGrid min={150}>
          <Tile metric="averageWinner" label="Average winner" value={signed(e.avgWinnerPct)} />
          <Tile metric="averageLoser" label="Average loser" value={signed(e.avgLoserPct)} />
          <Tile metric="mfe" label="E[MFE]" value={signed(e.expectedMfePct)} hint="the peak, not the result" />
          <Tile metric="mae" label="E[MAE]" value={signed(e.expectedMaePct)} hint="the worst drawdown held through" />
        </ResponsiveGrid>
        <ResponsiveGrid min={150}>
          {Object.entries(e.probabilities).map(([k, v]) => (
            <Tile
              key={k}
              metric="probabilityTouch"
              label={k}
              value={v.rate == null ? NA : pct(v.rate)}
              hint={v.rate == null ? `${v.reached}/${v.of} — floors not met` : `${v.reached}/${v.of}`}
            />
          ))}
        </ResponsiveGrid>
        <DetailsDisclosure summary={`Limitations (${e.limitations.length})`}>
          {e.limitations.map((l, i) => (
            <p key={i} style={{ fontSize: 12, margin: "4px 0", opacity: 0.85 }}>• {l}</p>
          ))}
        </DetailsDisclosure>
      </Card>

      {/* ── SHADOW EXPERIMENTS ───────────────────────────────────────────── */}
      {r.shadowExperiments.map((x) => (
        <Card
          key={x.experimentId}
          title={`${x.experimentId} v${x.experimentVersion}`}
          meta={`${x.mode} · prospective from ${x.prospectiveStartDate}`}
          actions={<ExplainButton kind="EXPERIMENT" id={x.experimentId} label="Explain this experiment" />}
        >
          <div
            style={{
              border: "1px solid #e0a02055", background: "#e0a02012", borderRadius: 6,
              padding: "8px 10px", marginBottom: 10, fontSize: 12, fontWeight: 700, letterSpacing: 0.3,
            }}
          >
            SHADOW ONLY — THIS RULE DOES NOT AFFECT LIVE CALLOUTS. No callout has been rejected,
            delayed, reordered or annotated by it, and it cannot become live automatically.
          </div>

          <div style={{ marginBottom: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <StatusBadge tone={statusTone(x.status)}>{x.status.replace(/_/g, " ")}</StatusBadge>
            <StatusBadge tone={x.definitionFrozen ? "muted" : "bad"}>
              {x.definitionFrozen ? "DEFINITION FROZEN" : "DEFINITION CHANGED — SAMPLE INVALID"}
            </StatusBadge>
          </div>
          <p style={{ fontSize: 12, opacity: 0.85, margin: "0 0 10px" }}>{x.statusReason}</p>

          <ResponsiveGrid min={170}>
            <Tile
              label="Prospective outcomes"
              value={`${x.prospectiveClosedOutcomes} / ${x.requiredClosedOutcomes}`}
              hint="closed since the rule was frozen"
            />
            <Tile
              metric="independentSessions"
              label="Independent sessions"
              value={`${x.independentSessions} / ${x.requiredIndependentSessions}`}
            />
          </ResponsiveGrid>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 10 }}>
            <div>
              <h4 style={{ fontSize: 12, margin: "0 0 6px", opacity: 0.8 }}>
                <InfoTip metric="baselineProfitFactor">BASELINE</InfoTip> · n={x.baseline.sampleSize}
              </h4>
              <KeyValue k="Profit factor" v={num(x.baseline.profitFactor)} />
              <KeyValue k="Expectancy" v={signed(x.baseline.expectancyPct)} />
              <KeyValue k="Median return" v={signed(x.baseline.medianReturnPct)} />
              <KeyValue k="Win rate" v={pct(x.baseline.winRate)} />
            </div>
            <div>
              <h4 style={{ fontSize: 12, margin: "0 0 6px", opacity: 0.8 }}>
                <InfoTip metric="shadowProfitFactor">SHADOW</InfoTip> · n={x.shadow.sampleSize}
              </h4>
              <KeyValue k="Profit factor" v={num(x.shadow.profitFactor)} />
              <KeyValue k="Expectancy" v={signed(x.shadow.expectancyPct)} />
              <KeyValue k="Median return" v={signed(x.shadow.medianReturnPct)} />
              <KeyValue k="Win rate" v={pct(x.shadow.winRate)} />
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <KeyValue k={<InfoTip metric="winnerRetention">Winner retention</InfoTip>} v={pct(x.winnerRetention)} />
            <KeyValue k={<InfoTip metric="lossRejection">Loss rejection</InfoTip>} v={pct(x.lossRejection)} />
            <KeyValue k="Winners rejected" v={x.winnersRejected ?? NA} tone={(x.winnersRejected ?? 0) > 0 ? "warn" : undefined} />
            <KeyValue k={<InfoTip metric="profitFactorExBest">PF ex-best</InfoTip>} v={num(x.profitFactorExBest)} />
            <KeyValue k={<InfoTip metric="tailDependence">Tail robustness</InfoTip>} v={x.tailRobustness} />
            <KeyValue k="Definition hash" v={<code style={{ fontSize: 11 }}>{x.definitionHash}</code>} />
          </div>

          <DetailsDisclosure summary={`Limitations (${x.limitations.length})`}>
            {x.limitations.map((l, i) => (
              <p key={i} style={{ fontSize: 12, margin: "4px 0", opacity: 0.85 }}>• {l}</p>
            ))}
          </DetailsDisclosure>
        </Card>
      ))}

      {/* ── WHAT OPTISCAN LEARNED ────────────────────────────────────────── */}
      <Card title="What OptiScan learned" meta="Deterministic findings first; validated AI findings second">
        <FindingList title="Deterministic findings" items={r.learned.deterministicFindings} />
        <FindingList title="Validated nightly AI findings" items={r.learned.aiFindings} />
        {r.learned.insufficientEvidence.length ? (
          <DetailsDisclosure summary={`Insufficient evidence (${r.learned.insufficientEvidence.length})`}>
            {r.learned.insufficientEvidence.map((l, i) => (
              <p key={i} style={{ fontSize: 12, margin: "3px 0", opacity: 0.8 }}>• {l}</p>
            ))}
          </DetailsDisclosure>
        ) : null}
      </Card>

      {/* ── RISK RESEARCH ────────────────────────────────────────────────── */}
      <Card title="Risk research" meta="Observation only — no profit-protection policy exists or runs">
        <ResponsiveGrid min={260}>
          {r.riskResearch.cards.map((c) => (
            <div key={c.id} style={{ border: "1px solid var(--hairline, #ffffff18)", borderRadius: 6, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <strong style={{ fontSize: 13 }}>
                  {RISK_CARD_METRIC[c.id]
                    ? <InfoTip metric={RISK_CARD_METRIC[c.id]}>{c.title}</InfoTip>
                    : c.title}
                </strong>
                {!c.supported ? <StatusBadge tone="muted">not a finding</StatusBadge> : null}
              </div>
              <p style={{ fontSize: 13, margin: "6px 0 4px", fontWeight: 600 }}>{c.headline}</p>
              <p style={{ fontSize: 12, opacity: 0.8, margin: 0 }}>{c.detail}</p>
            </div>
          ))}
        </ResponsiveGrid>
        <p style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>{r.riskResearch.note}</p>
      </Card>

      {/* ── EARLY DISCOVERY ──────────────────────────────────────────────── */}
      <Card
        title="Early discovery — PRE_MOVE_DISCOVERY_V2"
        meta={v2 ? `${v2.population.label}` : "unavailable"}
      >
        {v2 ? (
          <>
            <div style={{ marginBottom: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <StatusBadge tone={evidenceTone(v2.verdict)}>{v2.verdict.replace(/_/g, " ")}</StatusBadge>
              <StatusBadge tone={v2.definitionFrozen?.frozen ? "muted" : "bad"}>
                {v2.definitionFrozen?.frozen ? "DEFINITION FROZEN" : "DEFINITION CHANGED"}
              </StatusBadge>
            </div>
            <p style={{ fontSize: 12, opacity: 0.85 }}>{v2.verdictReason}</p>
            <KeyValue k="Captured callouts" v={`${v2.coverage?.capturedOwnerRows ?? 0}`} />
            <KeyValue
              k="Rows predating the capture"
              v={`${v2.coverage?.uncapturedRows ?? 0}`}
            />

            <h4 style={{ fontSize: 12, margin: "12px 0 6px", opacity: 0.8 }}>
              <InfoTip metric="discoveryStage">Stage distribution</InfoTip>
            </h4>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", opacity: 0.7 }}>
                  <th>Stage</th><th>Rows</th><th>Closed</th><th>W/L</th>
                  <th><InfoTip metric="moveConsumed">Move consumed</InfoTip></th>
                  <th><InfoTip metric="rewardRemaining">Reward left</InfoTip></th>
                  <th>+10</th><th>+25</th><th>T1</th>
                </tr>
              </thead>
              <tbody>
                {(v2.byStage ?? []).map((s: any) => (
                  <tr key={s.stage} style={{ opacity: s.rows === 0 ? 0.45 : 1 }}>
                    <td>{s.stage.replace(/_/g, " ")}</td>
                    <td>{s.rows}</td>
                    <td>{s.closedOutcomes}</td>
                    <td>{s.winners}/{s.losers}</td>
                    <td>{s.medianMoveConsumedFraction == null ? NA : pct(s.medianMoveConsumedFraction)}</td>
                    <td>{s.medianRewardRemainingFraction == null ? NA : pct(s.medianRewardRemainingFraction)}</td>
                    <td>{s.medianMsToPlus10 == null ? NA : `${Math.round(s.medianMsToPlus10 / 60000)}m`}</td>
                    <td>{s.medianMsToPlus25 == null ? NA : `${Math.round(s.medianMsToPlus25 / 60000)}m`}</td>
                    <td>{s.medianMsToTarget1 == null ? NA : `${Math.round(s.medianMsToTarget1 / 60000)}m`}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ marginTop: 10 }}>
              {(v2.questions ?? []).map((q: any, i: number) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <p style={{ fontSize: 12, fontWeight: 600, margin: 0 }}>{q.question}</p>
                  <p style={{ fontSize: 12, opacity: q.supported ? 0.9 : 0.65, margin: "2px 0 0" }}>{q.answer}</p>
                </div>
              ))}
            </div>

            <DetailsDisclosure summary={`Limitations (${(v2.limitations ?? []).length})`}>
              {(v2.limitations ?? []).map((l: string, i: number) => (
                <p key={i} style={{ fontSize: 12, margin: "4px 0", opacity: 0.85 }}>• {l}</p>
              ))}
            </DetailsDisclosure>
          </>
        ) : <p style={{ fontSize: 12, opacity: 0.7 }}>V2 evidence is unavailable.</p>}

        <DetailsDisclosure summary="Why the old V1 number is not shown as earliness">
          <p style={{ fontSize: 12, opacity: 0.85 }}>
            V1 reports <strong>{r.earlyDiscoveryV1Caveat.share}</strong> as{" "}
            <strong>{r.earlyDiscoveryV1Caveat.stage}</strong>. {r.earlyDiscoveryV1Caveat.whyUnusable}
          </p>
        </DetailsDisclosure>
      </Card>

      {/* ── READINESS TRAJECTORY ─────────────────────────────────────────── */}
      <Card
        title="Readiness trajectory"
        meta="Reads the existing gates — changes no readiness rule"
      >
        <div
          style={{
            border: "1px solid #e0602055", background: "#e0602012", borderRadius: 6,
            padding: "8px 10px", marginBottom: 10, fontSize: 12, fontWeight: 700, letterSpacing: 0.3,
          }}
        >
          NOT SUBSCRIBER READY. Subscriber approval is a named human act taken elsewhere.
          No status on this page, and no experiment it can reach, enables delivery.
        </div>
        <ResponsiveGrid min={260}>
          {r.readiness.buckets.map((b) => (
            <div key={b.id} style={{ border: "1px solid var(--hairline, #ffffff18)", borderRadius: 6, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <strong style={{ fontSize: 13 }}>{b.title}</strong>
                <StatusBadge tone={b.blocking.length ? "warn" : "bull"}>
                  {b.blocking.length ? `${b.blocking.length} blocking` : "clear"}
                </StatusBadge>
              </div>
              <div style={{ marginTop: 6 }}>
                {b.facts.map((f, i) => (
                  <KeyValue key={i} k={f.label} v={f.value == null ? NA : String(f.value)} />
                ))}
              </div>
              {b.blocking.length ? (
                <div style={{ marginTop: 6 }}>
                  {b.blocking.map((x, i) => (
                    <p key={i} style={{ fontSize: 11, margin: "3px 0", opacity: 0.85 }}>⛔ {x}</p>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </ResponsiveGrid>
        <p style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>{r.readiness.note}</p>
      </Card>

      {/* ── EXPLAIN THIS ─────────────────────────────────────────────────── */}
      {explain ? (
        <Card
          title="Explain this"
          meta="Ask OptiScan · ADVISORY ONLY"
          actions={<button type="button" onClick={() => setExplain(null)} style={{ fontSize: 11, padding: "2px 8px" }}>Close</button>}
        >
          {explain.loading ? <LoadingState label="Resolving evidence…" rows={2} /> : null}
          {explain.error ? <p style={{ fontSize: 12, color: "#e06060" }}>{explain.error}</p> : null}
          {explain.data ? <ExplainPanel payload={explain.data} /> : null}
        </Card>
      ) : null}

      {/* ── AI BUDGET ────────────────────────────────────────────────────── */}
      {data.budget ? (
        <Card title="AI budget" meta="One hard cap across every AI ledger — Explain This spends from it">
          <KeyValue k="Spent this month" v={`$${(data.budget.spendUsd ?? 0).toFixed(4)}`} />
          <KeyValue k="Hard cap" v={`$${(data.budget.hardLimitUsd ?? 20).toFixed(2)}`} />
          <KeyValue k="Remaining" v={`$${(data.budget.remainingUsd ?? 0).toFixed(4)}`} />
          <p style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
            When the cap is reached, AI narration stops and every deterministic figure on this
            page keeps rendering. No trading or research statistic depends on model availability.
          </p>
        </Card>
      ) : null}
    </PageContainer>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Tile({
  label, value, hint, metric, explain, onExplain,
}: {
  label: string;
  value: string;
  hint?: string;
  /** A key in lib/metric-glossary.ts. The definition is never restated here. */
  metric?: string;
  explain?: { kind: string; id: string; population?: string };
  onExplain?: (kind: string, id: string, population?: string) => void;
}) {
  return (
    <div className="stat-item" style={{ padding: 8 }}>
      <span className="stat-label">
        {metric ? <InfoTip metric={metric}>{label}</InfoTip> : label}
      </span>
      <span className="stat-val num">{value}</span>
      {hint ? <span className="stat-hint">{hint}</span> : null}
      {explain && onExplain ? (
        <button
          type="button"
          onClick={() => onExplain(explain.kind, explain.id, explain.population)}
          style={{ fontSize: 10, marginTop: 4, padding: "1px 6px", cursor: "pointer" }}
        >
          Explain
        </button>
      ) : null}
    </div>
  );
}

function FindingList({ title, items }: { title: string; items: Panels["learned"]["deterministicFindings"] }) {
  if (!items.length) {
    return (
      <div style={{ marginBottom: 10 }}>
        <h4 style={{ fontSize: 12, margin: "0 0 4px", opacity: 0.8 }}>{title}</h4>
        <p style={{ fontSize: 12, opacity: 0.6, margin: 0 }}>None recorded yet.</p>
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <h4 style={{ fontSize: 12, margin: "0 0 6px", opacity: 0.8 }}>{title}</h4>
      {items.slice(0, 8).map((f) => (
        <div key={f.key} style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 13 }}>{f.title}</strong>
            <StatusBadge tone={f.evidenceStrength === "INSUFFICIENT" ? "muted" : "info"}>
              {f.evidenceStrength}
            </StatusBadge>
            {f.sampleSize != null ? (
              <span style={{ fontSize: 11, opacity: 0.7 }}>n={f.sampleSize}</span>
            ) : null}
          </div>
          <p style={{ fontSize: 12, margin: "2px 0", opacity: 0.85 }}>{f.statement}</p>
          {f.limitations.length ? (
            <p style={{ fontSize: 11, margin: 0, opacity: 0.65 }}>
              Does not establish: {f.limitations.join("; ")}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * The deterministic block renders FIRST and always. AI narration is appended, and its
 * absence is stated rather than left as a blank panel.
 */
function ExplainPanel({ payload }: { payload: any }) {
  const t = payload?.deterministic?.target;
  const ai = payload?.ai;
  if (!t) return <p style={{ fontSize: 12 }}>Nothing to explain.</p>;

  return (
    <div>
      <h3 style={{ fontSize: 14, margin: "0 0 4px" }}>{t.title}</h3>
      {!t.resolved ? (
        <p style={{ fontSize: 12, color: "#e0a020" }}>{t.unresolvedReason}</p>
      ) : null}

      {t.definition ? (
        <div style={{ marginBottom: 10 }}>
          <p style={{ fontSize: 12, margin: "2px 0" }}><b>What it is:</b> {t.definition.what}</p>
          <p style={{ fontSize: 12, margin: "2px 0" }}><b>Why it matters:</b> {t.definition.why}</p>
          <p style={{ fontSize: 12, margin: "2px 0" }}><b>Higher or lower?</b> {t.definition.direction}</p>
          <p style={{ fontSize: 12, margin: "2px 0", opacity: 0.8 }}><b>Risk:</b> {t.definition.risk}</p>
        </div>
      ) : null}

      {t.facts?.length ? (
        <div style={{ marginBottom: 10 }}>
          {t.facts.map((f: any, i: number) => (
            <KeyValue
              key={i}
              k={f.label}
              v={
                <>
                  {f.value == null ? NA : String(f.value)}
                  {f.unit ? <span style={{ opacity: 0.6 }}> {f.unit}</span> : null}
                  {f.note ? <span style={{ display: "block", fontSize: 10, opacity: 0.6 }}>{f.note}</span> : null}
                </>
              }
            />
          ))}
        </div>
      ) : null}

      <div style={{ borderTop: "1px solid var(--hairline, #ffffff18)", paddingTop: 8, marginTop: 8 }}>
        {ai?.available ? (
          <>
            <p style={{ fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}>{ai.answer}</p>
            {ai.evidence?.length ? (
              <p style={{ fontSize: 10, opacity: 0.6, marginTop: 6 }}>
                Cited: {ai.evidence.map((x: any) => x.label).join(" · ")}
              </p>
            ) : null}
          </>
        ) : (
          <p style={{ fontSize: 12, fontWeight: 600, color: "#e0a020", margin: 0 }}>
            {ai?.message ?? "AI EXPLANATION UNAVAILABLE — the deterministic evidence above is complete."}
          </p>
        )}
      </div>

      {t.mustNotBeReadAs?.length ? (
        <div style={{ marginTop: 10, fontSize: 11, opacity: 0.8 }}>
          {t.mustNotBeReadAs.map((m: string, i: number) => (
            <p key={i} style={{ margin: "3px 0" }}>⚠ {m}</p>
          ))}
        </div>
      ) : null}

      {t.limitations?.length ? (
        <DetailsDisclosure summary={`Limitations (${t.limitations.length})`}>
          {t.limitations.map((l: string, i: number) => (
            <p key={i} style={{ fontSize: 11, margin: "3px 0", opacity: 0.8 }}>• {l}</p>
          ))}
        </DetailsDisclosure>
      ) : null}
    </div>
  );
}

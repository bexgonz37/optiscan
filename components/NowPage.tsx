"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LoadingState, ErrorState } from "@/components/ui/Shell";
import { scanHeaders } from "@/hooks/useScanner";
import { isUiReviewMode, getUiReviewSession } from "@/lib/dashboard/ui-review";
import { buildNowReviewSnapshot, modeFromReviewSession, type NowSetupCard } from "@/lib/dashboard/demo-now-fixtures";
import { DECISION_LABEL, decisionTone, type DecisionState } from "@/lib/dashboard/setup-decision";
import { TermPanel, TermSpark, actionTone, fmtPct } from "@/components/terminal/TermViz";

type NowApi = {
  ok?: boolean;
  operatingMode?: string;
  operatingLabel?: string;
  operatingDetail?: string;
  optionsExecutableWindow?: boolean;
  heroTitle?: string;
  hero?: NowSetupCard & { whyFirst?: string; label?: string };
  nextThree?: NowSetupCard[];
  groups?: Record<DecisionState, NowSetupCard[]>;
  counts?: Record<DecisionState, number>;
  openPositions?: any[];
  overnight?: { tradingDay?: string; count?: number } | null;
  error?: string;
};

function money(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
}

function stateClass(state: DecisionState): string {
  const t = decisionTone(state);
  if (t === "ok") return "ok";
  if (t === "warn") return "warn";
  if (t === "bad") return "bad";
  if (t === "info") return "info";
  return "muted";
}

function SetupCard({
  card,
  featured,
}: {
  card: NowSetupCard & { label?: string; quoteLabel?: string };
  featured?: boolean;
}) {
  return (
    <Link href={card.href || "/callouts"} className={`now-setup-card${featured ? " featured" : ""}`}>
      <div className="now-setup-top">
        <span className="now-rank">#{card.rank}</span>
        <span className="cc-term-opp-sym">{card.symbol}</span>
        <span className="now-side">{String(card.side).toUpperCase()}</span>
        <span className={`cc-term-pill ${stateClass(card.state)}`}>
          {card.label ?? DECISION_LABEL[card.state]}
        </span>
        <span className="now-conf">{card.confidence ?? "—"}</span>
      </div>
      <div className="now-setup-grid">
        <div><span className="muted">Trigger</span><div>{card.trigger}</div></div>
        <div><span className="muted">Entry</span><div>{card.entryZone != null ? money(card.entryZone) : "—"}</div></div>
        <div><span className="muted">Structure</span><div>{card.preferredStructure}</div></div>
        <div><span className="muted">T1 / Stop</span><div>{money(card.t1)} / {money(card.stop)}</div></div>
      </div>
      <p className="now-reason">{card.reason}</p>
      <p className="muted">Risk: {card.mainRisk}</p>
      {card.confirmationNeeded ? (
        <p className="now-confirm">Needs: {card.confirmationNeeded}</p>
      ) : null}
      {card.verifyContractAfterOpen ? (
        <p className="now-verify">VERIFY CONTRACT AFTER OPTIONS OPEN</p>
      ) : null}
      <div className="now-setup-meta">
        <span>{card.freshness}</span>
        <span>n={card.quantSampleSize ?? "—"}</span>
        {card.contract ? <span className="cc-term-mono">{card.contract}</span> : null}
      </div>
    </Link>
  );
}

function GroupSection({
  state,
  cards,
  defaultOpen,
}: {
  state: DecisionState;
  cards: NowSetupCard[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="now-group">
      <button type="button" className="now-group-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`cc-term-pill ${stateClass(state)}`}>{DECISION_LABEL[state]}</span>
        <span className="now-group-count">{cards.length}</span>
        <span className="muted">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        cards.length === 0 ? (
          <p className="cc-term-empty">None</p>
        ) : (
          <div className="now-group-list">
            {cards.map((c) => (
              <SetupCard key={c.key} card={c} />
            ))}
          </div>
        )
      ) : null}
    </section>
  );
}

export function NowPage() {
  const [snap, setSnap] = useState<NowApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const review = typeof window !== "undefined" && isUiReviewMode();

  const load = useCallback(async () => {
    if (isUiReviewMode()) {
      const mode = modeFromReviewSession(getUiReviewSession());
      const demo = buildNowReviewSnapshot(mode);
      const groups: Record<DecisionState, NowSetupCard[]> = {
        TRADE_NOW: [],
        ALMOST_READY: [],
        TOMORROW: [],
        AVOID: [],
      };
      for (const s of demo.setups) groups[s.state].push(s);
      setSnap({
        ok: true,
        operatingMode: demo.operatingMode,
        operatingLabel: demo.operatingLabel,
        operatingDetail: demo.operatingDetail,
        optionsExecutableWindow: demo.operatingMode === "REGULAR_SESSION_LIVE",
        heroTitle: demo.heroTitle,
        hero: demo.setups[0],
        nextThree: demo.setups.slice(1, 4),
        groups,
        counts: {
          TRADE_NOW: groups.TRADE_NOW.length,
          ALMOST_READY: groups.ALMOST_READY.length,
          TOMORROW: groups.TOMORROW.length,
          AVOID: groups.AVOID.length,
        },
        openPositions: demo.openPositions,
      });
      setError(null);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/now", { cache: "no-store", headers: scanHeaders() });
      if (res.status === 401) {
        setError("This dashboard needs your private OptiScan access token.");
        setLoading(false);
        return;
      }
      const body = (await res.json()) as NowApi;
      setSnap(body);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "Could not load NOW");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  const showTradeNow = Boolean(snap?.optionsExecutableWindow);
  const avoidDefaultOpen = false;

  const positions = useMemo(() => snap?.openPositions ?? [], [snap]);

  if (loading && !snap) {
    return (
      <div className="ui-page cc-term now-page">
        <LoadingState rows={5} />
      </div>
    );
  }

  if (error && !snap) {
    return (
      <div className="ui-page cc-term now-page">
        <ErrorState detail={error} onRetry={load} />
      </div>
    );
  }

  if (!snap) return null;

  if (snap.operatingMode === "SYSTEM_OFFLINE") {
    return (
      <div className="ui-page cc-term now-page">
        <div className="now-mode-banner bad">
          <strong>{snap.operatingLabel}</strong>
          <span>{snap.operatingDetail}</span>
        </div>
        <ErrorState detail="System unavailable — monitor, database, or app offline." onRetry={load} />
      </div>
    );
  }

  const hero = snap.hero;
  const groups = snap.groups ?? {
    TRADE_NOW: [],
    ALMOST_READY: [],
    TOMORROW: [],
    AVOID: [],
  };

  return (
    <div className={`ui-page cc-term now-page${review ? " now-review" : ""}`}>
      <div className={`now-mode-banner ${snap.optionsExecutableWindow ? "ok" : "info"}`}>
        <strong>{snap.operatingLabel}</strong>
        <span>{snap.operatingDetail}</span>
      </div>

      {hero ? (
        <section className="now-hero">
          <div className="now-hero-label">{snap.heroTitle}</div>
          <SetupCard card={hero} featured />
          {hero.whyFirst ? <p className="now-why-first">{hero.whyFirst}</p> : null}
        </section>
      ) : (
        <p className="cc-term-empty">No setups ranked for this session yet.</p>
      )}

      {(snap.nextThree?.length ?? 0) > 0 ? (
        <section className="now-next-three">
          <div className="now-section-label">Next three</div>
          <div className="now-next-grid">
            {snap.nextThree!.map((c) => (
              <SetupCard key={`n-${c.key}`} card={c} />
            ))}
          </div>
        </section>
      ) : null}

      {showTradeNow ? (
        <GroupSection state="TRADE_NOW" cards={groups.TRADE_NOW ?? []} defaultOpen />
      ) : null}
      <GroupSection state="ALMOST_READY" cards={groups.ALMOST_READY ?? []} defaultOpen />
      <GroupSection state="TOMORROW" cards={groups.TOMORROW ?? []} defaultOpen />
      <GroupSection state="AVOID" cards={groups.AVOID ?? []} defaultOpen={avoidDefaultOpen} />

      <TermPanel title="Open positions" badge={<span className="cc-term-pill muted">{positions.length}</span>} action={<Link href="/paper" className="cc-term-link">Paper →</Link>}>
        {positions.length === 0 ? (
          <p className="cc-term-empty">No open delivered positions</p>
        ) : (
          <div className="cc-term-opp-list">
            {positions.map((p: any) => (
              <div key={p.alertId ?? p.symbol} className="cc-term-opp">
                <div className="cc-term-opp-top">
                  <span className="cc-term-opp-sym">{p.symbol}</span>
                  <span className={`cc-term-pill ${actionTone("WATCH")}`}>{p.status ?? "OPEN"}</span>
                  <TermSpark values={[0, Number(p.returnPct ?? p.latestMarkReturnPct) || 0]} width={48} height={14} />
                </div>
                <div className="cc-term-opp-meta">
                  <span>{String(p.side ?? "—").toUpperCase()}</span>
                  <span className="cc-term-mono">{p.optionSymbol ?? "—"}</span>
                  <span>{p.ageLabel ?? "—"}</span>
                </div>
                <div className="cc-term-opp-metrics">
                  <span className={Number(p.returnPct ?? p.latestMarkReturnPct) >= 0 ? "ok" : "bad"}>
                    {fmtPct(p.returnPct ?? p.latestMarkReturnPct)}
                  </span>
                  <span>MFE {fmtPct(p.mfePct)}</span>
                  <span>MAE {fmtPct(p.maePct)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </TermPanel>

      <p className="cc-term-footnote">
        Decision states are research guidance — not buy instructions.{" "}
        <Link href="/callouts" className="cc-term-link">Live Options detail</Link>
        {" · "}
        <Link href="/pipeline-health" className="cc-term-link">Diagnostics</Link>
      </p>
    </div>
  );
}

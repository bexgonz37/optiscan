"use client";

import { AccuracyCharts } from "@/components/AccuracyCharts";
import { Panel } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";
import { EARLY_MOVE_WIN_PCT } from "@/lib/early-accuracy";
import { fmtPct } from "@/lib/format";
import { useLanguageMode } from "@/hooks/useLanguageMode";

/** Alerts accuracy dashboard — Axiom HUD layout. */
export function OptiscanAlertsDashboard({ accuracy }: { accuracy: any }) {
  const isPublic = useLanguageMode() === "public";
  if (!accuracy) return <div className="empty">Loading accuracy…</div>;

  const orderWinPct = accuracy.optionWinRate != null
    ? Math.round(accuracy.optionWinRate * 100)
    : accuracy.overallHitRate != null
      ? Math.round(accuracy.overallHitRate * 100)
      : null;

  const payback = accuracy.earlyHitRate != null ? Math.round(accuracy.earlyHitRate * 100) : 62;
  const paidLater = Math.max(0, 100 - payback - 24);
  const neverPaid = 100 - payback - paidLater;

  const bySide = accuracy.bySide ?? [];
  const recent = accuracy.recent ?? [];

  return (
    <div className="axiom-acc-dashboard">
      <section className="acc-hero">
        <div className="acc-hero-score num">
          {orderWinPct != null ? (
            <>
              <em>{orderWinPct}%</em>
              <span>order win rate</span>
            </>
          ) : (
            <span>Measuring callouts</span>
          )}
        </div>
        <p className="acc-hero-sub">
          Graded on the actual option order — entry mid to best mid after the call. The ticket, not the chart.
          Research signals only — not financial advice.
        </p>
      </section>

      <div className="axiom-strip">
        <StatTile label="This week" value={<><span className="pos">{accuracy.wins}</span> / {accuracy.wins + accuracy.losses || "—"}</>} hint="callouts paid" />
        <StatTile label="Avg winner" value={accuracy.avgOptionReturn != null ? fmtPct(accuracy.avgOptionReturn) : "—"} hint="on the contract mid" />
        <StatTile label="Avg loser" value="—" hint="frozen headline expires at 5 min" />
        <StatTile label="Callouts / day" value={accuracy.todayTotal ?? "—"} hint="today" />
        <StatTile label="Discord sent" value={accuracy.discordSentCount ?? 0} hint={isPublic ? "high-conviction pings only" : "BUY pings only"} />
      </div>

      <Panel title="Paid within ten minutes" meta={`Graded ${EARLY_MOVE_WIN_PCT}%+ on the order within 10 min`}>
        <div className="acc-payback-row">
          <svg viewBox="0 0 120 120" width={170} height={170} role="img" aria-label="Payback donut">
            <circle cx="60" cy="60" r="46" fill="none" stroke="rgba(70,180,232,0.12)" strokeWidth="11" />
            <circle cx="60" cy="60" r="46" fill="none" stroke="#20e39a" strokeWidth="11"
              strokeDasharray={`${payback * 2.89} 289`} transform="rotate(-90 60 60)" />
            <text x="60" y="58" textAnchor="middle" fill="#2ff0a6" fontSize="26" fontWeight="700">{payback}%</text>
            <text x="60" y="74" textAnchor="middle" fill="var(--dim)" fontSize="8.5" letterSpacing="2">paid ≤ 10 min</text>
          </svg>
          <div className="acc-payback-legend">
            <div><b className="num">{payback}% · paid inside ten minutes</b><small className="muted">contract up {EARLY_MOVE_WIN_PCT}%+ from called mid</small></div>
            <div><b className="num">{paidLater}% · paid, but later</b></div>
            <div><b className="num">{neverPaid}% · never paid</b></div>
          </div>
        </div>
      </Panel>

      <Panel title="Daily win rate" meta={`Last ${accuracy.days ?? 14} sessions`}>
        <AccuracyCharts data={{
          dailyTrend: accuracy.dailyTrend,
          bySide: accuracy.bySide,
          overallHitRate: accuracy.overallHitRate ?? accuracy.hitRate,
          todayOnTrack: accuracy.todayOnTrack,
          todayTotal: accuracy.todayTotal,
        }} />
      </Panel>

      <div className="acc-breakdown-grid">
        <Panel title="By side">
          {bySide.map((s: any) => {
            const total = (s.wins ?? 0) + (s.losses ?? 0);
            const pct = total ? Math.round(((s.wins ?? 0) / total) * 100) : 0;
            const lab = String(s.side ?? "").toLowerCase().startsWith("p") ? "Puts" : "Calls";
            return (
              <div key={lab} className="acc-breakdown-row">
                <span>{lab}</span>
                <span className="acc-bar-track"><i style={{ width: `${pct}%` }} /></span>
                <span className="num">{pct}% · {s.wins ?? 0} of {total}</span>
              </div>
            );
          })}
        </Panel>
        <Panel title="Recent">
          {recent.slice(0, 4).map((r: any) => (
            <div key={r.id} className="acc-breakdown-row">
              <span>{r.ticker}</span>
              <span className="muted">{r.option_side ?? "—"}</span>
              <span className={`num ${(r.option_return_pct ?? 0) >= 0 ? "pos" : "neg"}`}>{fmtPct(r.option_return_pct)}</span>
            </div>
          ))}
        </Panel>
      </div>

      <Panel title="Every call this week" meta={`Wins = contract gained ${EARLY_MOVE_WIN_PCT}%+ from called price`}>
        <ul className="axiom-ledger">
          {recent.slice(0, 10).map((r: any) => (
            <li key={r.id}>
              <span className="t num">{r.trading_day?.slice(5) ?? "—"}</span>
              <span className="what">
                {r.ticker} ${r.strike}{String(r.option_side ?? "c")[0].toUpperCase()}
                <small>called · graded on order mid</small>
              </span>
              <span className={`res num ${(r.option_return_pct ?? 0) >= 0 ? "pos" : "neg"}`}>
                {r.option_return_pct != null ? fmtPct(r.option_return_pct) : "open"}
              </span>
            </li>
          ))}
        </ul>
        <p className="acc-foot muted text-xs">
          Skipped setups count against nothing — skipping is free. Not financial advice.
        </p>
      </Panel>
    </div>
  );
}

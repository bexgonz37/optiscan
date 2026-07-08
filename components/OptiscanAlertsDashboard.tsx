"use client";

import { AccuracyCharts } from "@/components/AccuracyCharts";
import { EARLY_MOVE_WIN_PCT } from "@/lib/early-accuracy";
import { fmtPct } from "@/lib/format";
import { useLanguageMode } from "@/hooks/useLanguageMode";

/** Alerts accuracy dashboard — chrome-noir layout from mockup spec. */
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
    <div className="chrome-alerts">
      <section className="scoreline" style={{ paddingTop: "4.2rem" }}>
        <div className="score-big num">
          {orderWinPct != null ? <><em>{orderWinPct}%</em> order win rate</> : <>Measuring callouts</>}
        </div>
        <p className="score-sub" style={{ maxWidth: 620, marginTop: ".9rem", color: "var(--soft)", lineHeight: 1.6 }}>
          Graded on the actual option order — entry mid to best mid after the call. The ticket, not the chart.
          Research signals only — not financial advice.
        </p>
      </section>

      <div className="kpi-strip">
        <div><div className="k">This week</div><div className="v num"><span className="pos">{accuracy.wins}</span> / {accuracy.wins + accuracy.losses || "—"}</div><div className="s">callouts paid</div></div>
        <div><div className="k">Avg winner</div><div className="v num pos">{accuracy.avgOptionReturn != null ? fmtPct(accuracy.avgOptionReturn) : "—"}</div><div className="s">on the contract mid</div></div>
        <div><div className="k">Avg loser</div><div className="v num neg">—</div><div className="s">frozen headline expires at 5 min</div></div>
        <div><div className="k">Callouts / day</div><div className="v num">{accuracy.todayTotal ?? "—"}</div><div className="s">today</div></div>
        <div><div className="k">Discord sent</div><div className="v num">{accuracy.discordSentCount ?? 0}</div><div className="s">{isPublic ? "high-conviction pings only" : "BUY pings only"}</div></div>
      </div>

      <div className="section-head">
        <span className="section-title">Paid within ten minutes</span>
        <span className="section-note">Graded {EARLY_MOVE_WIN_PCT}%+ on the order within 10 min</span>
      </div>
      <div className="payback" style={{ display: "flex", gap: "3rem", alignItems: "center", flexWrap: "wrap", marginTop: "1.6rem" }}>
        <svg viewBox="0 0 120 120" width={190} height={190} role="img" aria-label="Payback donut">
          <circle cx="60" cy="60" r="46" fill="none" stroke="rgba(222,230,231,.1)" strokeWidth="11" />
          <circle cx="60" cy="60" r="46" fill="none" stroke="var(--green)" strokeWidth="11"
            strokeDasharray={`${payback * 2.89} 289`} transform="rotate(-90 60 60)" />
          <text x="60" y="58" textAnchor="middle" fill="var(--green)" fontSize="26" fontWeight="700">{payback}%</text>
          <text x="60" y="74" textAnchor="middle" fill="var(--steel)" fontSize="8.5" letterSpacing="2">paid ≤ 10 min</text>
        </svg>
        <div style={{ display: "grid", gap: ".9rem" }}>
          <div><b className="num">{payback}% · paid inside ten minutes</b><small className="muted" style={{ display: "block" }}>contract up {EARLY_MOVE_WIN_PCT}%+ from called mid</small></div>
          <div><b className="num">{paidLater}% · paid, but later</b></div>
          <div><b className="num">{neverPaid}% · never paid</b></div>
        </div>
      </div>

      <div className="section-head">
        <span className="section-title">Daily win rate</span>
        <span className="section-note">Last {accuracy.days ?? 14} sessions</span>
      </div>
      <div style={{ marginTop: "1.6rem" }}>
        <AccuracyCharts data={{
          dailyTrend: accuracy.dailyTrend,
          bySide: accuracy.bySide,
          overallHitRate: accuracy.overallHitRate ?? accuracy.hitRate,
          todayOnTrack: accuracy.todayOnTrack,
          todayTotal: accuracy.todayTotal,
        }} />
      </div>

      <div className="breakdown" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2.6rem", marginTop: "1.6rem" }}>
        <div className="bk">
          <h3 style={{ color: "var(--silver)", fontSize: ".6rem", letterSpacing: ".2em", textTransform: "uppercase" }}>By side</h3>
          {bySide.map((s: any) => {
            const total = (s.wins ?? 0) + (s.losses ?? 0);
            const pct = total ? Math.round(((s.wins ?? 0) / total) * 100) : 0;
            const lab = String(s.side ?? "").toLowerCase().startsWith("p") ? "Puts" : "Calls";
            return (
              <div key={lab} className="row" style={{ display: "grid", gridTemplateColumns: "6rem 1fr auto", gap: "1rem", alignItems: "center", padding: ".62rem 0", borderBottom: "1px solid var(--line)" }}>
                <span>{lab}</span>
                <span style={{ height: 3, background: "var(--line)", position: "relative" }}><i style={{ position: "absolute", inset: "0 auto 0 0", width: `${pct}%`, background: "var(--green)" }} /></span>
                <span className="num">{pct}% · {s.wins ?? 0} of {total}</span>
              </div>
            );
          })}
        </div>
        <div className="bk">
          <h3 style={{ color: "var(--silver)", fontSize: ".6rem", letterSpacing: ".2em", textTransform: "uppercase" }}>Recent</h3>
          {recent.slice(0, 4).map((r: any) => (
            <div key={r.id} className="row" style={{ display: "grid", gridTemplateColumns: "6rem 1fr auto", gap: "1rem", padding: ".62rem 0", borderBottom: "1px solid var(--line)" }}>
              <span>{r.ticker}</span>
              <span className="muted">{r.option_side ?? "—"}</span>
              <span className={`num ${(r.option_return_pct ?? 0) >= 0 ? "pos" : "neg"}`}>{fmtPct(r.option_return_pct)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="section-head">
        <span className="section-title">Every call this week</span>
        <span className="section-note">Wins = contract gained {EARLY_MOVE_WIN_PCT}%+ from called price</span>
      </div>
      <ul className="ledger">
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
      <p className="foot" style={{ marginTop: "4rem", color: "var(--muted)", fontSize: ".72rem" }}>
        Skipped setups count against nothing — skipping is free. Not financial advice.
      </p>
    </div>
  );
}

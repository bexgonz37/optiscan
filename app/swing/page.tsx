"use client";

/**
 * /swing — 1–4 week options scanner (RESEARCH PREVIEW).
 */

import { Suspense, useCallback, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { InfoTip } from "@/components/InfoTip";
import { CardTip } from "@/components/CardTip";
import { Panel } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";

function SwingPageInner() {
  const [data, setData] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = useCallback(async (force: boolean) => {
    setRunning(true);
    setNote(null);
    try {
      const res = await fetch(`/api/scan/swing${force ? "?force=1" : ""}`, { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      setData(d);
      if (!d.ok) setNote(d.note ?? "scan deferred");
    } catch (e: any) {
      setNote(e?.message ?? "scan failed");
    } finally {
      setRunning(false);
    }
  }, []);

  const paperIt = useCallback(async (c: any) => {
    if (!c.bestContract?.optionSymbol) { setNote("no fillable contract on this candidate"); return; }
    const res = await fetch("/api/paper/trades", {
      method: "POST",
      headers: { "content-type": "application/json", ...scanHeaders() },
      body: JSON.stringify({
        ticker: c.ticker,
        optionSymbol: c.bestContract.optionSymbol,
        optionType: c.direction,
        strike: c.bestContract.strike,
        expiration: c.bestContract.expiration,
        dte: c.bestContract.dte,
        entryLimit: c.bestContract.ask ?? c.bestContract.mid,
        thesis: `Swing scanner ${c.score}/100: ${Object.values(c.factors).map((f: any) => f.why).join(" · ")}`,
      }),
    });
    const d = await res.json();
    setNote(d.ok ? `Paper trade #${d.id} created from ${c.ticker}.` : `Risk engine refused: ${d.risk?.failures?.join("; ")}`);
  }, []);

  const candidates: any[] = data?.candidates ?? [];
  const bullish = candidates.filter((c) => c.direction === "call").length;
  const bearish = candidates.filter((c) => c.direction === "put").length;
  const fillable = candidates.filter((c) => c.bestContract).length;
  const topScore = candidates[0]?.score ?? null;

  return (
    <div className="page axiom-utility">
      <main className="main-col axiom-live">
        <CardTip metric="swingScore" className="utility-hero">
          <section className="panel main utility-intro">
            <h2 className="section-title"><InfoTip metric="swingScore">Swing scanner (1–4 weeks)</InfoTip></h2>
            <div className="alert-warn text-sm">
              Research preview — formulas documented in docs/SWING-SCANNER.md but NOT calibrated against tracked outcomes.
              Paper-trade candidates; verify earnings before any real position.
            </div>
            <div className="btn-row mt-2">
              <button className="pill btn btn-primary" disabled={running} onClick={() => run(false)}>
                {running ? "Scanning…" : "Run swing scan"}
              </button>
              <button className="pill btn" disabled={running} onClick={() => run(true)}>Force refresh</button>
              {data?.callsUsed != null ? <span className="muted text-xs">{data.callsUsed} metered calls · cached 15 min</span> : null}
            </div>
            {note ? <div className="text-sm mt-2">{note}</div> : null}
          </section>
        </CardTip>

        {candidates.length ? (
          <div className="axiom-strip swing-strip">
            <StatTile label="Candidates" value={candidates.length} hint="passed all gates" metric="swingScore" />
            <StatTile label="Top score" value={topScore ?? "—"} hint="best this run" metric="swingScore" />
            <StatTile label="Bullish / bearish" value={`${bullish} / ${bearish}`} hint="call vs put setups" metric="swingCandidate" />
            <StatTile label="Fillable" value={fillable} hint="contracts with tight spread" metric="spread" />
          </div>
        ) : null}

        {candidates.length ? (
          <Panel title="Swing candidates" meta={`${candidates.length} ranked · hover any card for help`} tip="swingCandidate">
            <div className="swing-grid">
              {candidates.map((c: any) => (
                <CardTip key={c.ticker} metric="swingCandidate" className="swing-card">
                  <article className={`swing-card-inner${c.direction === "put" ? " bear" : ""}`}>
                    <header className="swing-card-head">
                      <span className="swing-score num">{c.score}</span>
                      <div>
                        <div className="swing-symbol">{c.ticker}</div>
                        <div className="swing-dir">{c.direction === "call" ? "Bullish swing" : "Bearish swing"}</div>
                      </div>
                      {c.bestContract ? (
                        <button type="button" className="pill btn btn-xs btn-primary" onClick={() => paperIt(c)}>Paper</button>
                      ) : null}
                    </header>
                    {c.bestContract ? (
                      <div className="swing-contract num">
                        ${c.bestContract.strike} {c.direction.toUpperCase()} · {c.bestContract.expiration} ({c.bestContract.dte} DTE)
                        <small>spread {c.bestContract.spreadPct?.toFixed(1)}% · Δ {Math.abs(c.bestContract.delta ?? 0).toFixed(2)}</small>
                      </div>
                    ) : (
                      <div className="muted text-xs">No fillable 1–4 week contract — shares watch only</div>
                    )}
                    <ul className="swing-factors">
                      {Object.entries(c.factors).map(([k, f]: [string, any]) => (
                        <li key={k}>
                          <span className="factor-k">{k}</span>
                          <span className="factor-v num">{Math.round(f.score)}</span>
                          <span className="factor-why muted">{f.why}</span>
                        </li>
                      ))}
                    </ul>
                    {c.flags?.length ? <div className="swing-flags">⚠ {c.flags.join(" · ")}</div> : null}
                  </article>
                </CardTip>
              ))}
            </div>
          </Panel>
        ) : data?.ok ? (
          <Panel title="Swing candidates" meta="No passes this run" tip="swingCandidate">
            <div className="sigwhy muted text-sm">No candidates passed the gates this run — try again after the next session open or force refresh.</div>
          </Panel>
        ) : (
          <Panel title="Swing candidates" meta="Run a scan to populate" tip="swingCandidate">
            <div className="sigwhy muted text-sm">Hit <b>Run swing scan</b> above. Results cache 15 minutes to protect API quota.</div>
          </Panel>
        )}
      </main>
    </div>
  );
}

export default function SwingPage() {
  return (
    <Suspense fallback={null}>
      <SwingPageInner />
    </Suspense>
  );
}

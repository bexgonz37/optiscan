"use client";

/**
 * /swing — 1–4 week options scanner (RESEARCH PREVIEW).
 * Documented formulas: docs/SWING-SCANNER.md. Uncalibrated until a month of
 * paper-traded outcomes exists — the banner says so on purpose.
 */

import { Suspense, useCallback, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { scanHeaders } from "@/hooks/useScanner";
import { InfoTip } from "@/components/InfoTip";

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

  return (
    <div className="page">
      <AppNav />
      <main className="main-col">
        <section className="panel main">
          <h2 className="section-title"><InfoTip metric="swingScore">Swing scanner (1–4 weeks)</InfoTip></h2>
          <div className="alert-warn text-sm">
            Research preview — formulas are documented (docs/SWING-SCANNER.md) but NOT yet calibrated against tracked
            outcomes. Paper-trade candidates; do not trade this blind. Earnings dates are not checked — verify before
            any position.
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

        {data?.candidates?.length ? (
          <section className="panel main">
            <ul className="ledger">
              {data.candidates.map((c: any) => (
                <li key={c.ticker}>
                  <span className={`t num ${c.direction === "call" ? "up" : "dn"}`}>{c.score}</span>
                  <span className="what">
                    <b>{c.ticker}</b> — {c.direction === "call" ? "bullish" : "bearish"} swing candidate
                    {c.bestContract ? (
                      <small>
                        ${c.bestContract.strike} {c.direction.toUpperCase()} {c.bestContract.expiration} ({c.bestContract.dte} DTE)
                        · spread {c.bestContract.spreadPct?.toFixed(1)}% · Δ {Math.abs(c.bestContract.delta ?? 0).toFixed(2)}
                      </small>
                    ) : <small>no fillable 1–4 week contract — shares watch only</small>}
                    <small className="muted">
                      {Object.entries(c.factors).map(([k, f]: [string, any]) => `${k} ${Math.round(f.score)} (${f.why})`).join(" · ")}
                    </small>
                    {c.flags?.length ? <small className="muted">⚠ {c.flags.join(" · ")}</small> : null}
                  </span>
                  <span className="res">
                    {c.bestContract ? <button className="pill btn btn-xs" onClick={() => paperIt(c)}>Paper trade</button> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : data?.ok ? (
          <section className="panel main"><div className="muted text-sm">No candidates passed the gates this run.</div></section>
        ) : null}
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

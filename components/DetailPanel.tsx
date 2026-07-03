"use client";

import { useEffect, useState } from "react";
import type { SymbolDetail } from "@/lib/types";
import { TickerIcon, Stat } from "@/components/ui";
import { PayoffChart } from "@/components/PayoffChart";
import { useToast } from "@/components/Toasts";
import { economics } from "@/lib/economics";
import {
  changeColor,
  fmtExpiry,
  fmtInt,
  fmtIv,
  fmtNum,
  fmtPct,
  fmtPremium,
  fmtPrice,
} from "@/lib/format";

const dirColor: Record<string, string> = {
  bullish: "var(--green)",
  bearish: "var(--red)",
  neutral: "var(--amber)",
};

export function DetailPanel({
  symbol,
  open,
  onClose,
}: {
  symbol: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<SymbolDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { push } = useToast();

  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/api/scan/${encodeURIComponent(symbol)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => !cancelled && setError(e?.message ?? "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const mom = data?.momentum ?? null;
  const contract = mom?.contract ?? null;
  const econ = economics(contract, mom?.underlyingPrice ?? data?.quote?.price ?? null);

  function copyTicket() {
    if (!contract || !symbol) return;
    const line = `BUY 1 ${symbol} ${fmtNum(contract.strike, 0)}${String(contract.side).toUpperCase().slice(0, 1)} ${contract.expiration} @ ${fmtPremium(contract.entry)} (mid)`;
    navigator.clipboard?.writeText(line).then(
      () => push("Copied contract", line, "ok"),
      () => push("Copy failed", "Clipboard unavailable in this browser.", "err"),
    );
  }

  return (
    <>
      <div className={`scrim ${open ? "open" : ""}`} onClick={onClose} />
      <div className={`panel detail ${open ? "open" : ""}`}>
        {!symbol ? (
          <div className="detail-empty">Select a signal to see the contract, payoff, and greeks.</div>
        ) : (
          <>
            <div className="dhead">
              <div className="row1">
                <TickerIcon symbol={symbol} size={40} />
                <div>
                  <div className="nm">{symbol}</div>
                  <div className="co">US equity options</div>
                </div>
                <div className="dprice">
                  <div className="p">{fmtPrice(mom?.underlyingPrice ?? data?.quote?.price ?? null)}</div>
                  <div className="c" style={{ color: changeColor(mom?.movePct ?? data?.quote?.changePercent ?? null) }}>
                    {fmtPct(mom?.movePct ?? data?.quote?.changePercent ?? null)}
                  </div>
                </div>
                <button
                  className="close pill btn"
                  onClick={onClose}
                  style={{ marginLeft: 10, padding: "6px 10px" }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            {loading && <div className="detail-empty">Loading chain…</div>}
            {error && (
              <div className="dsection">
                <div className="warn">⚠ {error}</div>
              </div>
            )}

            {contract && (
              <>
                <div className="dsection">
                  <h4>
                    Recommended setup
                    <span style={{ marginLeft: "auto", color: "var(--dim)", fontWeight: 600 }}>
                      signal {Math.round(mom?.score ?? 0)}
                    </span>
                  </h4>
                  <div className="setup-card">
                    <div className="st">
                      <span style={{ color: dirColor[mom?.bias ?? "neutral"] }}>●</span>
                      Long {String(contract.side).toUpperCase()}
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--dim)" }}>{contract.dte} DTE</span>
                    </div>
                    <div className="legs">
                      <div>
                        <span className="buy">BUY</span> {symbol} {fmtNum(contract.strike, 0)}{" "}
                        {String(contract.side).toUpperCase()} {fmtExpiry(contract.expiration)}
                        <span style={{ float: "right", color: "var(--dim)" }}>{fmtPremium(contract.entry)}</span>
                      </div>
                    </div>
                    {mom?.reasons?.length ? (
                      <div className="reasons">
                        {mom.reasons.slice(0, 6).map((r, i) => (
                          <span className="reason-chip" key={i}>
                            {r}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {mom?.warnings?.length ? <div className="warn">⚠ {mom.warnings.join(" · ")}</div> : null}
                  </div>
                </div>

                <div className="dsection">
                  <h4>Payoff at expiration</h4>
                  <PayoffChart contract={contract} underlyingPrice={mom?.underlyingPrice ?? null} />
                </div>

                <div className="dsection">
                  <h4>Trade economics</h4>
                  <div className="statgrid">
                    <Stat label="Debit / contract" value={econ.debitPerContract != null ? `$${fmtInt(econ.debitPerContract)}` : "—"} />
                    <Stat label="Max loss" value={econ.maxLoss != null ? `$${fmtInt(econ.maxLoss)}` : "—"} accent="var(--red)" />
                    <Stat label="Max profit" value={econ.maxProfit == null ? "Unbounded" : `$${fmtInt(econ.maxProfit)}`} accent="var(--green)" />
                    <Stat label="Breakeven" value={fmtPrice(econ.breakeven)} />
                    <Stat label="To breakeven" value={fmtPct(econ.toBreakevenPct)} />
                    <Stat label="Spread" value={contract.spreadPct != null ? `${contract.spreadPct}%` : "—"} />
                  </div>
                </div>

                <div className="dsection">
                  <h4>Greeks &amp; liquidity</h4>
                  <div className="greeks">
                    <div className="greek">
                      <div className="g">Delta</div>
                      <div className="gv">{fmtNum(contract.delta, 2)}</div>
                    </div>
                    <div className="greek">
                      <div className="g">Gamma</div>
                      <div className="gv">{fmtNum(contract.gamma, 3)}</div>
                    </div>
                    <div className="greek">
                      <div className="g">Theta</div>
                      <div className="gv" style={{ color: (contract.theta ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                        {fmtNum(contract.theta, 3)}
                      </div>
                    </div>
                    <div className="greek">
                      <div className="g">Vega</div>
                      <div className="gv">{fmtNum(contract.vega, 3)}</div>
                    </div>
                    <div className="greek">
                      <div className="g">IV</div>
                      <div className="gv">{fmtIv(contract.iv)}</div>
                    </div>
                  </div>
                  <div className="statgrid" style={{ marginTop: 10 }}>
                    <Stat label="Open interest" value={fmtInt(contract.openInterest)} />
                    <Stat label="Volume" value={fmtInt(contract.volume)} />
                  </div>
                </div>

                <div className="cta">
                  <button className="btn-p" onClick={copyTicket}>
                    Copy contract
                  </button>
                  <button className="btn-s" onClick={() => push("Signal noted", `${symbol} ${String(contract.side).toUpperCase()} added to your watch — alerts will ping on STRONG.`, "info")}>
                    Watch
                  </button>
                </div>
              </>
            )}

            {data?.unusual?.length ? (
              <div className="dsection">
                <h4>Unusual activity</h4>
                <div className="legs" style={{ color: "var(--muted)" }}>
                  {data.unusual.map((u) => (
                    <div key={u.optionSymbol ?? `${u.side}${u.strike}${u.expiration}`}>
                      <span className={u.side === "call" ? "buy" : "sell"}>{String(u.side).toUpperCase()}</span>{" "}
                      {fmtNum(u.strike, 0)} {fmtExpiry(u.expiration)}
                      <span style={{ float: "right", color: "var(--dim)" }}>
                        vol {fmtInt(u.volume)} · {u.newPositioning ? "NEW" : `${fmtNum(u.volOiRatio, 1)}x`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {!loading && !error && !contract && !data?.unusual?.length && (
              <div className="detail-empty">No qualifying options signal for {symbol} right now.</div>
            )}

            <div className="disc">
              Signals only — OptiScan never places orders. Verify quotes in your broker before trading. Data via
              Polygon/Massive (delayed on free tiers). Not financial advice.
            </div>
          </>
        )}
      </div>
    </>
  );
}

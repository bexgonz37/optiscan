/** UI-only contract line — ticker, side, spread (not signal math). */

export function formatOptionsContract(a: {
  ticker?: string | null;
  strike?: number | null;
  option_side?: string | null;
  dte?: number | null;
  expiration?: string | null;
  entry_spread_pct?: number | null;
  entry_mid?: number | null;
}): string | null {
  if (!a.strike || !a.option_side) return null;
  const side = String(a.option_side).toUpperCase().startsWith("P") ? "PUT" : "CALL";
  const exp = a.dte != null ? `${a.dte}DTE` : a.expiration ?? "";
  const spread =
    a.entry_spread_pct != null && Number.isFinite(Number(a.entry_spread_pct))
      ? ` · spr ${Number(a.entry_spread_pct).toFixed(1)}%`
      : "";
  const mid =
    a.entry_mid != null && Number(a.entry_mid) > 0 ? ` · mid $${Number(a.entry_mid).toFixed(2)}` : "";
  return `${a.ticker ?? "?"} $${a.strike} ${side}${exp ? ` · ${exp}` : ""}${mid}${spread}`.trim();
}

export function formatCalloutHeadline(a: {
  capture_action?: string | null;
  option_side?: string | null;
  asset_class?: string | null;
  trade_bias?: string | null;
  direction?: string | null;
  private_label?: string | null;
}): string {
  if (a.asset_class === "stock") {
    const short = a.trade_bias === "stock_short_candidate" || a.direction === "bearish";
    if (String(a.capture_action ?? "").toUpperCase() === "TRADE") {
      return short ? "BUY SHORT · shares" : "BUY LONG · shares";
    }
    return short ? "WATCH SHORT · shares" : "WATCH LONG · shares";
  }
  const side = String(a.option_side ?? "").toUpperCase().startsWith("P") ? "PUT" : "CALL";
  if (String(a.capture_action ?? "").toUpperCase() === "TRADE") return `BUY ${side}`;
  return `WATCH ${side}`;
}

export function isFillableOptionsSetup(a: {
  asset_class?: string | null;
  capture_action?: string | null;
  entry_spread_pct?: number | null;
  signal_score?: number | null;
}, maxSpread = 5): boolean {
  if (a.asset_class === "stock") return false;
  if (String(a.capture_action ?? "").toUpperCase() === "TRADE") return true;
  const spread = a.entry_spread_pct;
  return spread != null && spread <= maxSpread && (a.signal_score ?? 0) >= 82;
}

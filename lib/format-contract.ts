/** UI-only contract lines — ticker, side, expiration, and strike (not signal math). */

export interface ParsedOccContract {
  symbol: string;
  expiration: string;
  expirationLabel: string;
  side: "call" | "put";
  strike: number;
}

export function parseOccContract(optionSymbol: string | null | undefined): ParsedOccContract | null {
  const raw = String(optionSymbol ?? "").trim().replace(/\s+/g, "");
  const match = /^(?:O:)?([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/i.exec(raw);
  if (!match) return null;
  const year = 2000 + Number(match[2]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const strike = Number(match[6]) / 1000;
  if (
    !Number.isFinite(strike)
    || strike <= 0
    || month < 1
    || month > 12
    || day < 1
    || day > 31
  ) return null;
  return {
    symbol: match[1]!.toUpperCase(),
    expiration: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    expirationLabel: `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`,
    side: match[5]!.toUpperCase() === "P" ? "put" : "call",
    strike,
  };
}

function strikeLabel(strike: number): string {
  return Number(strike.toFixed(3)).toString();
}

export function formatOccContract(optionSymbol: string | null | undefined): string | null {
  const parsed = parseOccContract(optionSymbol);
  if (!parsed) return null;
  const side = parsed.side === "put" ? "Put" : "Call";
  return `${parsed.symbol} ${parsed.expirationLabel} $${strikeLabel(parsed.strike)} ${side}`;
}

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
  short_rate_at_alert?: number | null;
  volume_surge_at_alert?: number | null;
  move_status?: string | null;
}, maxSpread = 5): boolean {
  if (a.asset_class === "stock") return false;
  if (String(a.capture_action ?? "").toUpperCase() === "TRADE") return true;
  const spread = a.entry_spread_pct;
  const score = a.signal_score ?? 0;
  if (spread != null && spread <= maxSpread && score >= 82) return true;
  // META-shaped fast movers with tight spread — actionable even at WAIT tier
  const speed = Math.abs(Number(a.short_rate_at_alert ?? 0));
  const surge = Number(a.volume_surge_at_alert ?? 0);
  const moveOk = !a.move_status || !["exhausted", "extended_risky"].includes(a.move_status);
  return spread != null && spread <= maxSpread && speed >= 0.22 && surge >= 2.2 && score >= 80 && moveOk;
}

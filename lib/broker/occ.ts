/**
 * OCC option symbol parsing for brokerage V2 position display (B4).
 * Supports Polygon-style `O:SPY250124C00590000` and bare OCC roots.
 */

export interface ParsedOccSymbol {
  occSymbol: string;
  underlying: string | null;
  right: "call" | "put" | null;
  strike: number | null;
  expiration: string | null; // YYYY-MM-DD
  dte: number | null;
}

const OCC_RE =
  /^(?:O:)?([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/i;

export function parseOccSymbol(symbol: string, asOfMs: number = Date.now()): ParsedOccSymbol {
  const raw = String(symbol ?? "").trim();
  const m = OCC_RE.exec(raw.replace(/\s+/g, ""));
  if (!m) {
    return {
      occSymbol: raw,
      underlying: null,
      right: null,
      strike: null,
      expiration: null,
      dte: null,
    };
  }
  const underlying = m[1].toUpperCase();
  const yy = Number(m[2]);
  const mm = Number(m[3]);
  const dd = Number(m[4]);
  const right = m[5].toUpperCase() === "C" ? "call" : "put";
  const strike = Number(m[6]) / 1000;
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  const expiration = `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const expMs = Date.UTC(year, mm - 1, dd, 20, 0, 0); // ~4pm ET approximation
  const dte = Math.max(0, Math.ceil((expMs - asOfMs) / 86_400_000));
  return {
    occSymbol: raw.startsWith("O:") ? raw : `O:${underlying}${m[2]}${m[3]}${m[4]}${m[5].toUpperCase()}${m[6]}`,
    underlying,
    right,
    strike: Number.isFinite(strike) ? strike : null,
    expiration,
    dte,
  };
}

export function underlyingFromSymbol(symbol: string): string | null {
  return parseOccSymbol(symbol).underlying;
}

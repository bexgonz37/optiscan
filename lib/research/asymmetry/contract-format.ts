/**
 * contract-format.ts — turn an exact OCC into something a trader reads. PURE.
 *
 * The radar identifies contracts by exact OCC because that is the only
 * unambiguous key, but `O:AAPL260803P00300000` is a machine identifier. Putting
 * it in the body of an alert makes the message look like debug output and
 * buries the four things that actually matter: symbol, expiry, strike, side.
 *
 * The OCC is not discarded — it moves to a compact footer so a mark can still
 * be verified against it.
 *
 * PARSING IS STRICT AND NEVER GUESSES. A symbol that does not match the OCC
 * layout returns null rather than a half-parsed contract, because a wrong
 * strike or expiry in an alert is worse than no alert.
 */

/** O:AAPL260803P00300000 -> underlying AAPL, 2026-08-03, PUT, strike 300 */
const OCC_RE = /^O:([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export interface ParsedContract {
  underlying: string;
  /** ISO date, unambiguous for storage and comparison. */
  expirationIso: string;
  /** MM/DD, how a trader says it. */
  expirationShort: string;
  strike: number;
  side: "Call" | "Put";
  /** "AAPL 08/03 $300 Put" */
  display: string;
}

/** Parse an exact OCC. Returns null when it is not exactly an OCC. */
export function parseOccSymbol(occ: string | null | undefined): ParsedContract | null {
  const m = OCC_RE.exec(String(occ ?? "").trim().toUpperCase());
  if (!m) return null;
  const [, underlying, yy, mm, dd, cp, strikeRaw] = m;
  const year = 2000 + Number(yy);
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // OCC strikes are in thousandths of a dollar.
  const strike = Number(strikeRaw) / 1000;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const side = cp === "P" ? "Put" : "Call";
  return {
    underlying,
    expirationIso: `${year}-${mm}-${dd}`,
    expirationShort: `${mm}/${dd}`,
    strike,
    side,
    display: `${underlying} ${mm}/${dd} ${formatStrike(strike)} ${side}`,
  };
}

/** $300, $302.50 — trailing zeros only when the strike genuinely has cents. */
export function formatStrike(strike: number): string {
  return Number.isInteger(strike) ? `$${strike}` : `$${strike.toFixed(2).replace(/0$/, "")}`;
}

/**
 * The contract line for the alert body. Falls back to the raw OCC ONLY when it
 * cannot be parsed — an unreadable identifier is better than a wrong one.
 */
export function contractDisplay(occ: string | null | undefined, fallbackSymbol?: string | null): string {
  const parsed = parseOccSymbol(occ);
  if (parsed) return parsed.display;
  const raw = String(occ ?? "").trim();
  if (raw) return raw;
  return fallbackSymbol ? `${fallbackSymbol} (contract unavailable)` : "contract unavailable";
}

/**
 * The entry line. NEVER invents a range.
 *
 * Entry in this lane is the ask — that is what you pay. A range is shown only
 * when a real bid and ask bracket it; a single known ask prints as one price;
 * nothing known says so plainly instead of printing a placeholder number.
 */
export function entryDisplay(bid: number | null | undefined, ask: number | null | undefined): string {
  const a = num(ask);
  const b = num(bid);
  if (a == null) return "awaiting valid quote";
  if (b == null || b <= 0 || b >= a) return money(a);
  return `${money(b)}–${money(a)}`;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const money = (n: number): string => `$${n.toFixed(2)}`;

/** Compact footer identity. The OCC stays available, just out of the way. */
export function contractFooter(occ: string | null | undefined): string {
  const raw = String(occ ?? "").trim();
  return raw ? `\`${raw}\`` : "`contract unavailable`";
}

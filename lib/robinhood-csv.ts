/**
 * Parse Robinhood Activity / Transaction History CSV exports into journal rows.
 */

export interface RobinhoodJournalRow {
  ticker: string;
  side: "call" | "put" | "shares";
  contract: string | null;
  quantity: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  openedAt: string | null;
  closedAt: string | null;
  pnl: number | null;
  notes: string;
  dedupKey: string;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function findCol(headers: string[], ...names: string[]): number {
  const norm = headers.map(normHeader);
  for (const n of names) {
    const i = norm.indexOf(n);
    if (i >= 0) return i;
  }
  for (const n of names) {
    const i = norm.findIndex((h) => h.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

function parseMoney(s: string): number | null {
  const n = Number(String(s ?? "").replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function parseQty(s: string): number | null {
  const n = Number(String(s ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function parseOptionDescription(desc: string): {
  ticker: string | null;
  side: "call" | "put" | null;
  strike: number | null;
  expiration: string | null;
} {
  const d = String(desc ?? "").trim();
  const m = d.match(/^([A-Z]{1,5})\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(Call|Put)\s+\$?([\d.]+)/i);
  if (!m) return { ticker: null, side: null, strike: null, expiration: null };
  return {
    ticker: m[1].toUpperCase(),
    expiration: m[2],
    side: m[3].toLowerCase() === "put" ? "put" : "call",
    strike: parseMoney(m[4]),
  };
}

function isoFromRobinhoodDate(s: string): string | null {
  const raw = String(s ?? "").trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}

export function parseRobinhoodCsv(text: string): { rows: RobinhoodJournalRow[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], errors: ["CSV is empty or has no data rows"] };

  const headers = parseCsvLine(lines[0]);
  const dateCol = findCol(headers, "activity_date", "date", "process_date");
  const instrumentCol = findCol(headers, "instrument", "symbol", "ticker");
  const descCol = findCol(headers, "description", "name");
  const transCol = findCol(headers, "trans_code", "transaction_type", "type");
  const qtyCol = findCol(headers, "quantity", "qty");
  const priceCol = findCol(headers, "price", "average_price");
  const amountCol = findCol(headers, "amount", "proceeds");

  if (dateCol < 0) errors.push("Could not find a date column — expected Activity Date or Date");

  const parsed: RobinhoodJournalRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const dateRaw = dateCol >= 0 ? cols[dateCol] : "";
    const openedAt = isoFromRobinhoodDate(dateRaw);
    const instrument = instrumentCol >= 0 ? String(cols[instrumentCol] ?? "").trim().toUpperCase() : "";
    const description = descCol >= 0 ? String(cols[descCol] ?? "").trim() : "";
    const trans = transCol >= 0 ? String(cols[transCol] ?? "").trim().toUpperCase() : "";
    const qty = qtyCol >= 0 ? parseQty(cols[qtyCol]) : null;
    const price = priceCol >= 0 ? parseMoney(cols[priceCol]) : null;
    const amount = amountCol >= 0 ? parseMoney(cols[amountCol]) : null;

    const opt = parseOptionDescription(description);
    const isOption = Boolean(opt.ticker && opt.side);
    const ticker = isOption ? opt.ticker! : instrument.replace(/\s+.*/, "");
    if (!ticker || ticker.length > 6) continue;

    const isBuy = trans.includes("BTO") || trans.includes("BUY") || trans === "B";
    const isSell = trans.includes("STC") || trans.includes("SELL") || trans === "S";
    if (!isBuy && !isSell && !description.toLowerCase().includes("call") && !description.toLowerCase().includes("put")) {
      continue;
    }

    const side = isOption ? opt.side! : "shares";
    const contract = isOption
      ? `${ticker} ${opt.expiration ?? ""} ${String(opt.side).toUpperCase()} ${opt.strike ?? ""}`.trim()
      : null;

    const dedupKey = `${ticker}|${contract ?? "stock"}|${openedAt ?? dateRaw}|${qty ?? ""}|${trans}`;
    parsed.push({
      ticker,
      side,
      contract,
      quantity: qty,
      entryPrice: isBuy ? price : null,
      exitPrice: isSell ? price : null,
      openedAt: isBuy ? openedAt : null,
      closedAt: isSell ? openedAt : null,
      pnl: amount,
      notes: `Robinhood import · ${description || trans}`.slice(0, 500),
      dedupKey,
    });
  }

  if (!parsed.length && !errors.length) {
    errors.push("No option or stock trades found — export Activity/Transaction History from Robinhood");
  }

  return { rows: parsed, errors };
}

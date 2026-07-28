/**
 * SEC EDGAR submissions helper — dilution / material-event context only.
 * Never gates signals. Rate-limit aware; requires descriptive User-Agent.
 */
export type EdgarFilingType = "8-K" | "424B5" | "S-1" | "S-3" | "OTHER";

export interface EdgarFiling {
  form: string;
  filingType: EdgarFilingType;
  filingDate: string;
  accessionNumber: string;
  primaryDocument: string | null;
  filingUrl: string | null;
  dilutionRisk: boolean;
}

export interface EdgarLookupResult {
  ok: boolean;
  cik: string | null;
  filings: EdgarFiling[];
  dilutionRisk: boolean;
  reason?: string;
}

const DILUTION_FORMS = new Set(["424B5", "S-1", "S-3", "S-3ASR", "424B3", "424B4"]);

function classifyForm(form: string): EdgarFilingType {
  const f = form.toUpperCase();
  if (f.startsWith("8-K")) return "8-K";
  if (f.includes("424B5")) return "424B5";
  if (f === "S-1" || f.startsWith("S-1/")) return "S-1";
  if (f.startsWith("S-3")) return "S-3";
  return "OTHER";
}

function isDilution(form: string): boolean {
  const f = form.toUpperCase().replace(/[\s/]/g, "");
  for (const d of DILUTION_FORMS) {
    if (f.includes(d.replace(/[\s/]/g, ""))) return true;
  }
  return false;
}

export function padCik(cik: string | number): string {
  const digits = String(cik).replace(/\D/g, "");
  return digits.padStart(10, "0");
}

export function edgarUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.EDGAR_USER_AGENT?.trim() ||
    "OptiScan Research Bot contact@optiscan.local"
  );
}

/**
 * Parse SEC submissions JSON into recent filings of interest.
 * Pure over already-fetched JSON (testable without network).
 */
export function parseEdgarSubmissions(
  json: any,
  opts?: { maxFilings?: number; sinceDays?: number; nowMs?: number },
): EdgarFiling[] {
  const recent = json?.filings?.recent;
  if (!recent?.form || !Array.isArray(recent.form)) return [];
  const max = opts?.maxFilings ?? 20;
  const sinceDays = opts?.sinceDays ?? 30;
  const nowMs = opts?.nowMs ?? Date.now();
  const cutoff = nowMs - sinceDays * 86400_000;
  const out: EdgarFiling[] = [];
  const n = recent.form.length;
  for (let i = 0; i < n && out.length < max; i++) {
    const form = String(recent.form[i] ?? "");
    const filingDate = String(recent.filingDate?.[i] ?? "");
    const accession = String(recent.accessionNumber?.[i] ?? "").replace(/-/g, "");
    const primary = recent.primaryDocument?.[i] != null ? String(recent.primaryDocument[i]) : null;
    const ts = Date.parse(filingDate);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const filingType = classifyForm(form);
    if (filingType === "OTHER" && !isDilution(form)) continue;
    const cik = padCik(json?.cik ?? json?.CIK ?? "");
    const filingUrl =
      cik && accession && primary
        ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${primary}`
        : null;
    out.push({
      form,
      filingType: isDilution(form) && filingType === "OTHER" ? "424B5" : filingType,
      filingDate,
      accessionNumber: String(recent.accessionNumber?.[i] ?? ""),
      primaryDocument: primary,
      filingUrl,
      dilutionRisk: isDilution(form),
    });
  }
  return out;
}

/** Fetch recent filings for a CIK (network). Soft-fails on 403/429. */
export async function fetchEdgarFilingsForCik(
  cik: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<EdgarLookupResult> {
  const padded = padCik(cik);
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": edgarUserAgent(env),
        Accept: "application/json",
      },
    });
    if (res.status === 403) return { ok: false, cik: padded, filings: [], dilutionRisk: false, reason: "edgar_403_user_agent" };
    if (res.status === 429) return { ok: false, cik: padded, filings: [], dilutionRisk: false, reason: "edgar_429_rate_limit" };
    if (!res.ok) return { ok: false, cik: padded, filings: [], dilutionRisk: false, reason: `edgar_http_${res.status}` };
    const json = await res.json();
    const filings = parseEdgarSubmissions(json);
    return {
      ok: true,
      cik: padded,
      filings,
      dilutionRisk: filings.some((f) => f.dilutionRisk),
    };
  } catch (e: any) {
    return { ok: false, cik: padded, filings: [], dilutionRisk: false, reason: String(e?.message ?? e).slice(0, 120) };
  }
}

/** Merge dilution flag into risk_flags CSV without removing existing flags. */
export function mergeDilutionRiskFlag(existing: string | null | undefined, dilution: boolean): string | null {
  if (!dilution) return existing ?? null;
  const parts = String(existing ?? "")
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.includes("dilution_risk")) parts.push("dilution_risk");
  return parts.join(",");
}

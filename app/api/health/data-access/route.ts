import { NextResponse } from "next/server";
import { getPolygonKey } from "@/lib/polygon-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health/data-access — probe which Polygon/Massive endpoint classes the
 * current key is entitled to. Fires one tiny request per class so a 403
 * NOT_AUTHORIZED (plan too low) is distinguishable from a 401 (bad key) or a
 * working 200. Never throws and never returns the key itself.
 */

const BASE = process.env.POLYGON_API_URL || "https://api.polygon.io";
const TIMEOUT_MS = 8000;

interface Probe {
  name: string;
  label: string;
  path: string;
  critical: boolean;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const PROBES: Probe[] = [
  {
    name: "realtime_stocks",
    label: "Real-time stock quotes (live scanner)",
    path: "/v2/snapshot/locale/us/markets/stocks/tickers?tickers=SPY",
    critical: true,
  },
  {
    name: "aggregates",
    label: "Candles / charts",
    path: `/v2/aggs/ticker/SPY/range/5/minute/${isoDaysAgo(3)}/${today()}?limit=5`,
    critical: false,
  },
  {
    name: "options",
    label: "Options chains (0DTE contracts)",
    path: "/v3/snapshot/options/SPY?limit=1",
    critical: true,
  },
  {
    name: "news",
    label: "News (catalyst tags)",
    path: "/v2/reference/news?ticker=SPY&limit=1",
    critical: false,
  },
];

async function probe(p: Probe, key: string) {
  const sep = p.path.includes("?") ? "&" : "?";
  const url = `${BASE}${p.path}${sep}apiKey=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let message = "";
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      try {
        const j = JSON.parse(body);
        message = j?.message || j?.error || body.slice(0, 160);
      } catch {
        message = body.slice(0, 160);
      }
    }
    return {
      name: p.name,
      label: p.label,
      critical: p.critical,
      status: res.status,
      allowed: res.ok,
      message: res.ok ? "OK" : message || `HTTP ${res.status}`,
    };
  } catch (err: any) {
    return {
      name: p.name,
      label: p.label,
      critical: p.critical,
      status: 0,
      allowed: false,
      message: err?.name === "TimeoutError" ? "timed out" : err?.message ?? "request failed",
    };
  }
}

export async function GET() {
  const key = getPolygonKey();
  if (!key) {
    return NextResponse.json({
      ok: false,
      keyPresent: false,
      probes: [],
      summary: "No API key set. Add POLYGON_API_KEY (or MASSIVE_API_KEY) to .env.local and restart.",
      time: new Date().toISOString(),
    });
  }

  const probes = await Promise.all(PROBES.map((p) => probe(p, key)));
  const blockedCritical = probes.filter((p) => p.critical && !p.allowed);
  const allOk = probes.every((p) => p.allowed);

  let summary: string;
  if (allOk) {
    summary = "All data classes are available on your plan.";
  } else if (blockedCritical.length) {
    summary = `Your plan is missing: ${blockedCritical.map((p) => p.label).join(", ")}. The live scanner needs these.`;
  } else {
    summary = "Core data works; some optional endpoints are limited.";
  }

  return NextResponse.json({
    ok: true,
    keyPresent: true,
    allOk,
    blockedCritical: blockedCritical.map((p) => p.name),
    probes,
    summary,
    upgradeUrl: "https://polygon.io/pricing",
    time: new Date().toISOString(),
  });
}

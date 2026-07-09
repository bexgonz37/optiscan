import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/alerts — filterable alert list (research log, not trade advice).
 * Filters: ticker, date, catalyst, minSignal, maxRisk, minLiquidity,
 * falsePositive, tradeTaken, status, minId (popup polling), limit, offset. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const { listAlerts } = await import("@/lib/alert-store");
    const q = new URL(req.url).searchParams;
    if (q.get("diagnostics") === "1") {
      const { alertDiagnostics } = await import("@/lib/alert-diagnostics");
      return NextResponse.json({ ok: true, diagnostics: alertDiagnostics() });
    }
    const bool = (v: string | null) => (v == null || v === "" ? undefined : v === "1" || v === "true");
    const num = (v: string | null) => (v == null || v === "" ? undefined : Number(v));
    const alerts = listAlerts({
      ticker: q.get("ticker") || undefined,
      date: q.get("date") || undefined,
      catalystType: q.get("catalyst") || undefined,
      minSignal: num(q.get("minSignal")),
      maxRisk: num(q.get("maxRisk")),
      minLiquidity: num(q.get("minLiquidity")),
      falsePositive: bool(q.get("falsePositive")),
      tradeTaken: bool(q.get("tradeTaken")),
      status: q.get("status") || undefined,
      assetClass: (q.get("asset") === "stock" || q.get("asset") === "options" ? q.get("asset") : undefined) as "stock" | "options" | undefined,
      minId: num(q.get("minId")),
      limit: num(q.get("limit")),
      offset: num(q.get("offset")),
    });
    return NextResponse.json({ ok: true, alerts });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "alerts unavailable", alerts: [] }, { status: 500 });
  }
}

/** POST /api/alerts — create a MANUAL alert (something I spotted myself and
 * want tracked exactly like scanner alerts). Body: { ticker, direction? }.
 * Quote, catalyst, and scores are computed server-side from real data. */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const body = await req.json();
    const ticker = String(body?.ticker ?? "").toUpperCase().trim();
    if (!ticker) return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });

    const [{ fetchQuote, fetchNews }, { classifyCatalyst }, scoring, langs, { buildExplanation }, store, dbmod] = await Promise.all([
      import("@/lib/polygon-provider"), import("@/lib/catalysts"), import("@/lib/alert-scoring"),
      import("@/lib/language-modes"), import("@/lib/explain"), import("@/lib/alert-store"), import("@/lib/db"),
    ]);

    const nowMs = Date.now();
    const day = dbmod.tradingDay(nowMs);
    if (store.alertExists(ticker, "manual", null, day)) {
      return NextResponse.json({ ok: false, error: "manual alert for this ticker already exists today" }, { status: 409 });
    }

    const qRes: any = await fetchQuote(ticker);
    const quote = qRes?.quote ?? null;
    const movePct = Number(body?.movePct ?? quote?.changePercent ?? 0);
    const direction = ["bullish", "bearish", "neutral"].includes(body?.direction)
      ? body.direction : movePct > 0 ? "bullish" : movePct < 0 ? "bearish" : "neutral";

    const news: any = await fetchNews(ticker, { limit: 10, days: 3 });
    const cat = classifyCatalyst(news?.available ? news.items : [], {});

    const liq = scoring.optionsLiquidityScore({}); // no specific contract on manual alerts
    const risk = scoring.riskScore({
      catalystType: cat.type, catalystQuality: cat.quality, movePct,
      shareVolume: quote?.volume ?? null, minsToClose: dbmod.minutesToClose(nowMs),
    });
    const setup = scoring.setupScore({
      relVol: null, movePct, catalystType: cat.type, catalystQuality: cat.quality,
      liquidityScore: liq.score, riskScore: risk.score,
    });
    const rl = langs.riskLabel(risk.score);
    const explainInput = {
      ticker, direction, movePct, relVol: null, catalystType: cat.type,
      catalystQuality: cat.quality, catalystSummary: cat.summary,
      liquidityScore: liq.score, riskScore: risk.score, setupScore: setup.score,
    };
    const id = store.insertAlert({
      ticker, source: "manual", alertType: "manual", direction,
      optionSymbol: null, optionSide: null, strike: null, expiration: null, dte: null,
      alertTime: new Date(nowMs).toISOString(), tradingDay: day,
      priceAtAlert: quote?.price ?? null, percentMoveAtAlert: movePct,
      volume: quote?.volume ?? null, relativeVolume: null,
      catalystType: cat.type, catalystQuality: cat.quality, catalystSummary: cat.summary, catalystSource: cat.source,
      signalScore: setup.score, riskScore: risk.score, optionsLiquidityScore: liq.score, scannerScore: null,
      scoreBreakdownJson: JSON.stringify({ ...setup.breakdown, reasons: setup.reasons }),
      aiExplanation: buildExplanation(explainInput, "private").text,
      publicExplanation: buildExplanation(explainInput, "public").text,
      privateLabel: langs.privateLabel(setup.score, { riskLabel: rl }),
      publicLabel: langs.publicLabel(setup.score, { riskLabel: rl }),
      snapshot: null, catalystRecords: cat.records,
    });
    if (id == null) return NextResponse.json({ ok: false, error: "duplicate" }, { status: 409 });
    return NextResponse.json({ ok: true, id }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "manual alert failed" }, { status: 500 });
  }
}

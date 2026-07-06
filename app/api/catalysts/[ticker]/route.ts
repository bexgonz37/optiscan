import { NextResponse } from "next/server";
import { fetchNews } from "@/lib/polygon-provider";
import { classifyCatalyst } from "@/lib/catalysts";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/catalysts/:ticker — recent headlines + classification. */
export async function GET(req: Request, { params }: { params: Promise<{ ticker: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  const { ticker } = await params;
  try {
    const news: any = await fetchNews(ticker, { limit: 10, days: 3 });
    if (news?.available === false) {
      return NextResponse.json({ ok: false, error: news.note ?? "news unavailable", items: [] }, { status: 502 });
    }
    const classification = classifyCatalyst(news.items, {});
    return NextResponse.json({ ok: true, ticker: String(ticker).toUpperCase(), classification, items: news.items });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "catalyst fetch failed" }, { status: 500 });
  }
}

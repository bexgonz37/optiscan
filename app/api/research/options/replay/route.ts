import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Options Historical Replay Lab (Phase 1) — operator tool, token-gated.
 *  POST { symbols?: string[], from: "YYYY-MM-DD", to: "YYYY-MM-DD" } runs a BOUNDED deterministic
 *  replay of the production detection over historical stock bars (range capped by
 *  OPTIONS_REPLAY_MAX_DAYS). GET returns the latest runs' summaries (read-only). */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const runs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_replay_runs'").get()
    ? (db.prepare("SELECT id, symbols, from_day, to_day, status, candidates, summary_json, created_at_ms FROM options_replay_runs ORDER BY id DESC LIMIT 10").all() as any[])
        .map((r) => ({ ...r, summary: r.summary_json ? JSON.parse(r.summary_json) : null, summary_json: undefined }))
    : [];
  return NextResponse.json({ ok: true, enabled: process.env.OPTIONS_REPLAY_ENABLED === "1", runs });
}

export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const from = String(body.from ?? ""), to = String(body.to ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ ok: false, error: "from/to must be YYYY-MM-DD" }, { status: 400 });
  }
  const { optionsTier1 } = await import("@/lib/research/options/discovery");
  const symbols: string[] = Array.isArray(body.symbols) && body.symbols.length ? body.symbols.map((s: string) => String(s).toUpperCase()) : optionsTier1(process.env);
  const { runOptionsReplay } = await import("@/lib/research/options/replay");
  const { getDb } = await import("@/lib/db");
  const result = await runOptionsReplay({ symbols: symbols.slice(0, 20), from, to }, {
    getDb,
    getBars: async (symbol, fromIso, toIso) => {
      const { fetchCandles } = await import("@/lib/polygon-provider");
      const res: any = await fetchCandles(symbol, { from: fromIso, to: toIso, resolution: "1", timespan: "minute", limit: 50_000 });
      const raw = res?.available ? (res.bars ?? []) : [];
      return raw.map((b: any) => ({ t: Number(b.t ?? b.timestamp), o: Number(b.o ?? b.open), h: Number(b.h ?? b.high), l: Number(b.l ?? b.low), c: Number(b.c ?? b.close), v: Number(b.v ?? b.volume ?? 0) })).filter((b: any) => Number.isFinite(b.t) && Number.isFinite(b.c));
    },
  }, process.env);
  return NextResponse.json(result);
}

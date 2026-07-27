import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/research/options/zero-dte-research — Aggressive 0DTE Research account snapshot (simulated). */
export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildZeroDteResearchSnapshot, zeroDteResearchRuntimeState, zeroDteResearchConfig } = require("@/lib/research/options/zero-dte-research");
    const db = getDb();
    const snapshot = buildZeroDteResearchSnapshot(db, process.env);
    return NextResponse.json({
      ok: true,
      config: {
        enabled: zeroDteResearchConfig(process.env).enabled,
        startingBalanceUsd: zeroDteResearchConfig(process.env).startingBalanceUsd,
        qualityBar: zeroDteResearchConfig(process.env).qualityBar,
        maxOpenTrades: zeroDteResearchConfig(process.env).maxOpenTrades,
        maxTradesPerDay: zeroDteResearchConfig(process.env).maxTradesPerDay,
      },
      runtime: zeroDteResearchRuntimeState(),
      snapshot,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}

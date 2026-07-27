import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Auth-gated Quant Lab snapshot — realized outcomes by lane (never blended). */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildQuantLabSnapshot } = require("@/lib/research/options/quant-lab");
    const snapshot = buildQuantLabSnapshot(getDb(), process.env);
    return NextResponse.json({ ok: true, snapshot }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

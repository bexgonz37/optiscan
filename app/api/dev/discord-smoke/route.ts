import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dev/discord-smoke — protected Discord smoke test (live runtime wiring).
 * Auth-gated. Dry-run by default (returns TEST/DRY-RUN payloads, sends nothing).
 * `?send=1` performs a real tracked send but ONLY when DISCORD_SMOKE_TEST=1.
 *
 * Never creates paper trades, fingerprints, outcomes, or model-training rows.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();
  const send = new URL(req.url).searchParams.get("send") === "1";
  const { runDiscordSmokeTest } = await import("@/lib/callouts/smoke");
  const result = await runDiscordSmokeTest({ send });
  return NextResponse.json({
    ...result,
    note: "TEST / DRY RUN Discord formatting check. Real send requires DISCORD_SMOKE_TEST=1 and ?send=1. No paper/outcome/model side effects.",
  });
}

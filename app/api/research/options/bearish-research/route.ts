import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  try {
    const [{ getDb }, { bearishResearchPaperConfig, buildBearishResearchPaperSnapshot }] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/research/options/bearish-research-paper"),
    ]);
    const config = bearishResearchPaperConfig(process.env);
    return NextResponse.json({
      ok: true,
      config,
      snapshot: buildBearishResearchPaperSnapshot(getDb() as any, process.env),
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 });
  }
}

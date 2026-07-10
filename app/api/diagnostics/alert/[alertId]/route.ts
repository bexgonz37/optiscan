import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseJson(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** GET /api/diagnostics/alert/:alertId - why an alert existed and whether it was fresh. */
export async function GET(req: Request, { params }: { params: Promise<{ alertId: string }> }) {
  if (!checkApiToken(req)) return unauthorized();
  const { alertId } = await params;
  const id = Number(alertId);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "invalid alert id" }, { status: 400 });
  }

  try {
    const { getAlertDetail } = await import("@/lib/alert-store");
    const { getSymbolFreshness } = await import("@/lib/data-freshness");
    const detail: any = getAlertDetail(id);
    if (!detail?.alert) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    const latestBreakdown = detail.breakdowns?.[detail.breakdowns.length - 1]?.breakdown_json
      ?? detail.alert.score_breakdown_json
      ?? null;
    const breakdown = parseJson(latestBreakdown);
    const ticker = String(detail.alert.ticker ?? "").toUpperCase();
    const symbolHealth = ticker ? getSymbolFreshness(ticker) : [];

    return NextResponse.json({
      ok: true,
      alert: detail.alert,
      timing: {
        moveClassification: detail.alert.move_classification ?? breakdown?.timing?.classification ?? null,
        moveStatus: detail.alert.move_status ?? breakdown?.timing?.statusLabel ?? null,
        signalDetectedAt: detail.alert.signal_detected_at ?? null,
        lastConfirmedAt: detail.alert.last_confirmed_at ?? null,
        moveBeganAt: detail.alert.move_began_at ?? null,
        dataTimestamp: detail.alert.data_timestamp ?? null,
        expiresAt: detail.alert.expires_at ?? null,
        invalidationReason: detail.alert.invalidation_reason ?? breakdown?.timing?.reasons?.join?.(" ") ?? null,
        evidence: breakdown?.timing ?? null,
      },
      scoreBreakdown: breakdown,
      performance: detail.performance ?? [],
      snapshots: detail.snapshots ?? [],
      catalysts: detail.catalysts ?? [],
      notifications: detail.notifications ?? [],
      discordDeliveries: detail.discordDeliveries ?? [],
      feedback: detail.feedback ?? [],
      symbolHealth,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "diagnostics unavailable" }, { status: 500 });
  }
}

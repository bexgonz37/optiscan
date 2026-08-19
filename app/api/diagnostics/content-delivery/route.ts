import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics/content-delivery — whether the content-draft recovery
 * sweep is actually draining the backlog.
 *
 * `/api/content-drafts` caps at 200 rows ordered `created_at_ms DESC`, and
 * recovery drains oldest-first, so recovered rows land exactly where that
 * endpoint cannot see them. Reading it and finding 200 undelivered drafts proved
 * nothing about recovery — it measured the page window. This endpoint counts the
 * whole table with SQL aggregates, and reports the scheduler's own last scan
 * result beside it, so "the sweep ran and delivered nothing" is distinguishable
 * from "the sweep never ran".
 *
 * Reads PERSISTED rows and in-process scheduler state only. Makes no provider
 * call, sends no message, and holds no delivery authority.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { buildContentDeliveryCensus } = await import("@/lib/content/content-delivery-census");
    const { contentEventsEnabled, contentWebhookConfigured } = await import("@/lib/content/content-drafts-runtime");
    const { recapDeliveryDiagnosis } = await import("@/lib/notifications/recap-health");
    const { buildLaneSeparationReport } = await import("@/lib/notifications/lane-separation");
    const { getDb } = await import("@/lib/db");
    const { schedulerState } = await import("@/lib/scheduler");

    const census = buildContentDeliveryCensus(getDb() as never);
    const sched = schedulerState();

    return NextResponse.json({
      ok: true,
      census,
      gates: {
        contentEventsEnabled: contentEventsEnabled(process.env),
        contentWebhookConfigured: contentWebhookConfigured(process.env),
        recapDelivery: recapDeliveryDiagnosis(process.env),
        // `contentWebhookConfigured` is true the moment DISCORD_WEBHOOK_CONTENT holds a
        // non-empty string. It cannot tell a dedicated content channel from a second copy
        // of the recap webhook -- which is the condition that put 1209 drafts into the
        // owner's recap channel while every diagnostic read CONFIGURED. This compares the
        // values and reports only whether two lanes resolve to the same destination; no
        // URL, fragment or hash is returned.
        laneSeparation: buildLaneSeparationReport(process.env),
      },
      // Null here means the job has not completed since this process started —
      // which is itself the answer when the backlog is not moving.
      lastScan: sched.lastContentDrafts ?? null,
      lastRunAtMs: sched.lastRun?.contentDrafts ?? null,
      runs: sched.runs?.contentDrafts ?? null,
      note: "Owner-only drafts. Never auto-posted to X/Twitter. This endpoint is read-only.",
    });
  } catch (e) {
    return jsonFromRouteError(e);
  }
}

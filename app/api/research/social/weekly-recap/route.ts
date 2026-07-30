import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/research/social/weekly-recap — private owner content generation.
 *
 * Generates a deterministic weekly recap plus editable drafts for the owner to copy
 * and post BY HAND. It does not post to Twitter/X, does not send to the subscriber
 * Options Alerts channel, does not touch the Recap scheduler or webhook, and writes
 * no production state. There is deliberately no POST handler and no send action.
 *
 * Query: week=YYYY-MM-DD (Monday) | start=&end= for a manual range,
 *        verifiedOnly=1, includeOpen=1, includeWatchlist=0, style=A|B|C|D, ai=1
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const url = new URL(req.url);
    const nowMs = Date.now();

    const { completedWeeklyWindow, windowForRange, buildWeeklySocialRecap } =
      await import("@/lib/research/social/weekly-recap");
    const { renderAllDrafts, renderDraft, DRAFT_STYLES, DRAFT_STYLE_LABELS, validateDraftAgainstRecap } =
      await import("@/lib/research/social/weekly-recap-drafts");
    const { loadRecapRows } = await import("@/lib/research/social/weekly-recap-sources");
    const { getDb } = await import("@/lib/db");

    const isoDay = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const start = isoDay(url.searchParams.get("start"));
    const end = isoDay(url.searchParams.get("end"));
    const week = isoDay(url.searchParams.get("week"));
    const window = start && end
      ? windowForRange(start, end)
      : week
        ? windowForRange(week, new Date(Date.parse(`${week}T12:00:00.000Z`) + 4 * 86_400_000).toISOString().slice(0, 10))
        : completedWeeklyWindow(nowMs);

    const verifiedSubscriberOnly = url.searchParams.get("verifiedOnly") === "1";
    const includeOpenTrades = url.searchParams.get("includeOpen") === "1";
    const includeWatchlist = url.searchParams.get("includeWatchlist") !== "0";

    const db = getDb();
    const loaded = loadRecapRows(
      db,
      window.startMs,
      window.endMs,
      { verifiedSubscriberOnly, includeWatchlist },
      process.env,
    );
    const recap = buildWeeklySocialRecap(loaded.rows, {
      window,
      nowMs,
      verifiedSubscriberOnly,
      includeOpenTrades,
      includeWatchlist,
    });

    const styleParam = String(url.searchParams.get("style") ?? "").toUpperCase();
    const singleStyle = DRAFT_STYLES.find((s) => s === styleParam || s.startsWith(`${styleParam}_`));
    const drafts = singleStyle ? [renderDraft(recap, singleStyle)] : renderAllDrafts(recap);

    // Deterministic drafts are validated too, so a template regression cannot ship
    // an unsupported figure to the owner unnoticed.
    const draftPayload = drafts.map((d) => ({
      ...d,
      validation: validateDraftAgainstRecap(d.text, recap),
    }));

    let aiRewrite: unknown = null;
    if (url.searchParams.get("ai") === "1" && drafts[0]) {
      const { rewriteRecapDraft } = await import("@/lib/research/social/weekly-recap-ai");
      aiRewrite = await rewriteRecapDraft({ recap, draft: drafts[0] });
    }

    return NextResponse.json({
      ok: true,
      recap,
      drafts: draftPayload,
      styles: DRAFT_STYLES.map((s) => ({ id: s, label: DRAFT_STYLE_LABELS[s] })),
      laneCounts: loaded.laneCounts,
      aiRewrite,
      safety: {
        autoPostEnabled: false,
        subscriberDeliveryEnabled: false,
        recapSchedulerTouched: false,
        aiCalculatesNumbers: false,
        destination: "private owner review only — copy and post manually",
      },
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

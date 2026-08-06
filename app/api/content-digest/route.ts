import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-route-auth";
import { ensureServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Historical learning digests — owner-only.
 *
 * GET  /api/content-digest            list generated digests (+ latest detail)
 * GET  /api/content-digest?preview=1  build the NEXT digest without persisting
 * POST /api/content-digest            generate now; `{"deliver":true}` also posts
 *
 * The digest is the in-app consumer for drafts held under
 * `HELD_FOR_HISTORICAL_DIGEST`. It is available here immediately and always,
 * which is the point: the owner should never need a Discord message to reach
 * historical learning, and Discord delivery stays opt-in.
 *
 * Never auto-posts to X/Twitter. Token-gated.
 */
export async function GET(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const {
      readHeldDraftRows, priorDigestOutcomeIds, casesWithDeliveredReportCard, buildDigestDiagnostics,
    } = await import("@/lib/content/historical-digest-runtime");
    const { buildHistoricalDigest, renderHistoricalDigest } = await import("@/lib/content/historical-digest");
    const db = getDb() as any;
    const url = new URL(req.url);
    const nowMs = Date.now();

    if (url.searchParams.get("preview")) {
      const rows = readHeldDraftRows(db, { includeArchive: false });
      const digest = buildHistoricalDigest({
        rows,
        nowMs,
        priorDigestOutcomeIds: priorDigestOutcomeIds(db),
        casesWithDeliveredReportCard: casesWithDeliveredReportCard(db),
        env: process.env,
      });
      return NextResponse.json({
        ok: true,
        preview: true,
        digest,
        renderedText: renderHistoricalDigest(digest, { appUrl: process.env.OPTISCAN_APP_URL ?? null }),
        note: "Preview only. Nothing was persisted and nothing was sent.",
      });
    }

    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 25) || 25, 100));
    const digests = (() => {
      try {
        return db.prepare(
          `SELECT id, generated_at_ms, delivered_at_ms, discord_message_id, delivery_status,
                  delivery_reason, trigger_source, evidence_version, covered_from_ms, covered_to_ms,
                  included_count, excluded_count, duplicates_collapsed, messages_prevented, stats_json
             FROM content_digests ORDER BY generated_at_ms DESC LIMIT ?`,
        ).all(limit) as Record<string, unknown>[];
      } catch { return []; }
    })();

    const id = String(url.searchParams.get("id") ?? "").trim();
    const members = (() => {
      const target = id || (digests[0]?.id == null ? "" : String(digests[0].id));
      if (!target) return [];
      try {
        return db.prepare(
          "SELECT * FROM content_digest_members WHERE digest_id=? ORDER BY included DESC, outcome_id ASC",
        ).all(target) as Record<string, unknown>[];
      } catch { return []; }
    })();

    return NextResponse.json({
      ok: true,
      diagnostics: buildDigestDiagnostics(db, process.env, nowMs),
      digests,
      members,
      note: "Owner-only historical learning digests. Never auto-posted to X/Twitter.",
    });
  } catch (e) {
    return jsonFromRouteError(e);
  }
}

/**
 * POST — generate a digest now, optionally delivering it to the recap channel.
 *
 * Delivery is an explicit owner act (`deliver: true`), independent of the
 * scheduled path's `CONTENT_DIGEST_DISCORD_ENABLED` gate: a manual trigger IS
 * the owner selecting the schedule. Generation alone never posts.
 */
export async function POST(req: Request) {
  const denied = requireApiToken(req);
  if (denied) return denied;
  ensureServerBoot();
  try {
    const body = await req.json().catch(() => ({}));
    const deliver = Boolean((body as { deliver?: unknown })?.deliver);
    const { getDb } = await import("@/lib/db");
    const { generateHistoricalDigest, deliverHistoricalDigest } =
      await import("@/lib/content/historical-digest-runtime");
    const db = getDb() as any;

    const gen = generateHistoricalDigest(db, { trigger: "MANUAL", env: process.env });
    if (!gen.ok || !gen.digest || !gen.renderedText) {
      // "Nothing to digest" is a truthful answer, not a failure. It is reported
      // with its reason so it can never be read as an empty or broken feature.
      return NextResponse.json({
        ok: true,
        generated: false,
        reason: gen.reason,
        digest: gen.digest ?? null,
        note: "No held outcome needed a digest. Nothing was persisted and nothing was sent.",
      });
    }
    if (!deliver) {
      return NextResponse.json({
        ok: true,
        generated: true,
        delivered: false,
        digest: gen.digest,
        renderedText: gen.renderedText,
        persisted: gen.persisted,
        note: "Digest generated and stored in the app. Nothing was sent to Discord.",
      });
    }
    const del = await deliverHistoricalDigest(db, gen.digest, gen.renderedText);
    return NextResponse.json({
      ok: del.ok,
      generated: true,
      delivered: del.ok,
      digest: gen.digest,
      messageId: del.messageId,
      draftsConsumed: del.draftsConsumed,
      error: del.error,
      note: "Owner-triggered delivery to the private recap channel only. Never auto-posted to X/Twitter.",
    });
  } catch (e) {
    return jsonFromRouteError(e);
  }
}

import { NextResponse } from "next/server";
import { deployInfo } from "@/lib/build-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/healthz — deployment LIVENESS probe (Railway).
 *
 * Returns 200 whenever the web server process is up and serving HTTP. This is what a platform deploy
 * healthcheck actually needs to confirm — that the container is alive — NOT whether a data volume has
 * finished mounting. Gating the deploy on DB-openability caused restart loops when Railway's persistent
 * volume at /app/data mounted a moment after the server started or was momentarily not writable; the
 * process was healthy, but a 503 made the platform kill and retry it forever.
 *
 * DB readiness is reported HONESTLY in the body (`db: true|false`, with `dbError` when it can't open)
 * and in full detail at /api/runtime/status — it just no longer fails the liveness probe. The only way
 * this returns non-200 is if the route handler itself cannot run (the process is genuinely down).
 *
 * It never waits on background boot, never exposes secrets, and never fails for normal states (market
 * closed, model inactive, Discord not configured, Polygon rate-limited, nothing actionable).
 *
 * Autonomous-boot note: instrumentation.register() now starts the background runtime at process boot
 * (it imports server-boot by a literal specifier webpack can trace into the standalone build). This
 * probe remains the SAFETY NET: if that path ever regresses, the Railway liveness check still brings
 * the runtime up on its first poll. Historically that safety net was doing all the work, because the
 * instrumentation import was untraceable and the module never reached the image.
 *
 * DEFERRED via setImmediate so boot runs AFTER this response is sent and can never slow or fail the
 * probe. Idempotent through lib/boot-guard's process-level claim (not a module-scoped flag — webpack
 * inlines server-boot into more than one chunk), so repeated probes can never start a second scanner,
 * scheduler, paper engine or grader. tests/boot-guard-idempotency.test.mjs pins that.
 */
export async function GET() {
  let dbOk = false;
  let dbError: string | null = null;
  let schemaOk = false;
  let schemaMissing: string[] = [];
  let dbDirectory: string | null = null;
  let lifecycle: { enabled: boolean; schemaReady: boolean; active: boolean } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb, inspectSchemaReadiness, resolveDbLocation } = require("@/lib/db");
    dbDirectory = resolveDbLocation().directory;
    const db = getDb();
    dbOk = db.prepare("SELECT 1 AS one").get()?.one === 1;
    const schema = inspectSchemaReadiness(db);
    schemaOk = schema.ok;
    schemaMissing = schema.missing;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const live = require("@/lib/opportunity-case/live");
      const enabled = Boolean(live.opportunityLifecycleEnabled());
      const schemaReady = Boolean(live.opportunityLifecycleSchemaReady(db));
      lifecycle = { enabled, schemaReady, active: enabled && schemaReady };
    } catch {
      lifecycle = { enabled: false, schemaReady: false, active: false };
    }
  } catch (e: any) {
    dbOk = false;
    dbError = String(e?.message ?? e).slice(0, 200); // safe: sqlite error text, never a secret
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      dbDirectory = require("@/lib/db-schema-readiness").resolveDbLocation().directory;
    } catch { /* ignore */ }
  }

  // Kickstart the autonomous runtime off the probe path (deferred; never blocks the response).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ensureServerBoot } = require("@/lib/server-boot");
    setImmediate(() => { try { ensureServerBoot(); } catch { /* boot is best-effort */ } });
  } catch { /* server-boot unavailable — liveness still reports 200 */ }

  const { commit, commitShort, branch } = deployInfo();
  // ALWAYS 200 for liveness: reaching this line means the server is up and serving. DB status is
  // informational in the body, not a deploy gate.
  const body = {
    ok: true,
    db: dbOk,
    dbError,
    dbDirectory,
    schemaOk,
    schemaMissing,
    lifecycle,
    service: "optiscan",
    commit,
    commitShort,
    branch,
    nowMs: Date.now(),
  };
  return NextResponse.json(body, { status: 200 });
}

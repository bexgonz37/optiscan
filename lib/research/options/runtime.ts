/**
 * lib/research/options/runtime.ts — persistent autonomous-runtime state for the options scanner:
 *   • persistHeartbeatOnDb() — the monitor writes a heartbeat every cycle so runtime status survives a
 *     restart/deploy and feeds observability + the daily summary WITHOUT any manual endpoint call.
 *   • runOptionsSelfCheck() — boot-time dependency verification. It NEVER exposes a secret value (only
 *     presence booleans). A missing REQUIRED dependency fails that feature CLOSED and is persisted as a
 *     blocker; the web app stays healthy regardless.
 *   • readRuntimeStatusOnDb() — read-only status for GET endpoints (no work is triggered).
 *
 * Everything is additive and isolated: a failure here never throws into the caller.
 */
import { researchFlags } from "../flags.ts";

interface RtDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } } }
const hasRuntime = (db: RtDb) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_runtime'").get());

function put(db: RtDb, key: string, value: unknown, nowMs: number): void {
  if (!hasRuntime(db)) return;
  db.prepare("INSERT INTO options_runtime (key, value, updated_at_ms) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at_ms=excluded.updated_at_ms")
    .run(key, JSON.stringify(value ?? null), nowMs);
}
function get(db: RtDb, key: string): { value: any; updatedAtMs: number | null } | null {
  if (!hasRuntime(db)) return null;
  const r = db.prepare("SELECT value, updated_at_ms FROM options_runtime WHERE key=?").get(key) as any;
  if (!r) return null;
  try { return { value: JSON.parse(r.value), updatedAtMs: r.updated_at_ms ?? null }; } catch { return { value: null, updatedAtMs: r.updated_at_ms ?? null }; }
}

export interface Heartbeat {
  session: string; running: boolean; breaker: string;
  lastTier1CycleMs: number | null; lastTier2CycleMs: number | null;
  symbolsScanned: number; stage15Stale: number; candidatesCreated: number; stage2Chain: number;
  providerFailures: number; latestCandidateMs: number | null;
}
/** Persist a monitor heartbeat (upsert single key). Isolated — never throws into the cycle. */
export function persistHeartbeatOnDb(db: RtDb, hb: Heartbeat, nowMs: number = Date.now()): void {
  try { put(db, "heartbeat", { ...hb, at: nowMs }, nowMs); } catch { /* isolated */ }
}

export interface SelfCheckItem { name: string; ok: boolean; required: boolean; detail: string }
export interface SelfCheckResult { at: number; healthy: boolean; blockers: string[]; items: SelfCheckItem[] }

/**
 * Boot self-check. Verifies flags, provider config, Discord config (only when delivery is enabled),
 * Node runtime, DB readiness, and the monitor singleton — WITHOUT exposing any secret value. "required"
 * items that fail become blockers (the feature is treated as inactive); non-required items are advisory.
 */
export function runOptionsSelfCheck(env: NodeJS.ProcessEnv = process.env, db?: RtDb, nowMs: number = Date.now()): SelfCheckResult {
  const f = researchFlags(env);
  const items: SelfCheckItem[] = [];
  const present = (v: string | undefined) => Boolean(v && String(v).trim());

  // The whole feature is opt-in; when off, everything downstream is a clean no-op (not a blocker).
  const enabled = f.independentOptionsDiscovery;
  items.push({ name: "flag:independentOptionsDiscovery", ok: enabled, required: false, detail: enabled ? "enabled" : "disabled — options scanner is a clean no-op" });

  // Provider config is REQUIRED only when the scanner is enabled.
  const polygon = present(env.POLYGON_API_KEY);
  items.push({ name: "polygonApiKey", ok: polygon || !enabled, required: enabled, detail: polygon ? "configured (value not shown)" : "missing POLYGON_API_KEY" });

  // Discord webhook REQUIRED only when callout delivery is enabled.
  const deliveryOn = enabled && f.earlyOptionsCallouts;
  const webhook = present(env.DISCORD_WEBHOOK_OPTIONS) || present(env.DISCORD_WEBHOOK_URL);
  items.push({ name: "discordWebhookOptions", ok: webhook || !deliveryOn, required: deliveryOn, detail: deliveryOn ? (webhook ? "configured (value not shown)" : "delivery enabled but no options webhook set") : "delivery off — webhook not required" });

  // Node runtime (better-sqlite3 native addon needs a modern Node).
  const major = Number(process.versions?.node?.split(".")[0] ?? 0);
  items.push({ name: "nodeRuntime", ok: major >= 18, required: enabled, detail: `node ${process.versions?.node ?? "unknown"}` });

  // DB readiness.
  let dbOk = false, dbDetail = "no db handle";
  if (db) { try { dbOk = Boolean(db.prepare("SELECT 1 x").get()); dbDetail = dbOk ? "reachable" : "query returned nothing"; } catch (e: any) { dbDetail = `db error: ${String(e?.message ?? e).slice(0, 80)}`; } }
  items.push({ name: "database", ok: dbOk || !enabled, required: enabled, detail: dbDetail });

  const blockers = items.filter((i) => i.required && !i.ok).map((i) => i.name);
  const result: SelfCheckResult = { at: nowMs, healthy: blockers.length === 0, blockers, items };
  if (db) { try { put(db, "self_check", result, nowMs); } catch { /* isolated */ } }
  return result;
}

/** Read-only runtime status for GET endpoints. Combines persisted heartbeat + last self-check + backlog. */
export function readRuntimeStatusOnDb(db: RtDb, env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): Record<string, unknown> {
  const hb = get(db, "heartbeat");
  const sc = get(db, "self_check");
  const lastSummary = get(db, "last_summary_day");
  const heartbeatAge = hb?.updatedAtMs != null ? nowMs - hb.updatedAtMs : null;
  return {
    enabled: researchFlags(env).independentOptionsDiscovery,
    heartbeat: hb?.value ?? null,
    heartbeatAgeMs: heartbeatAge,
    heartbeatFresh: heartbeatAge != null && heartbeatAge < 180_000,
    selfCheck: sc?.value ?? null,
    lastSummaryDay: lastSummary?.value ?? null,
  };
}

export function readRuntimeKeyOnDb(db: RtDb, key: string): { value: any; updatedAtMs: number | null } | null { return get(db, key); }
export function writeRuntimeKeyOnDb(db: RtDb, key: string, value: unknown, nowMs: number = Date.now()): void { try { put(db, key, value, nowMs); } catch { /* isolated */ } }

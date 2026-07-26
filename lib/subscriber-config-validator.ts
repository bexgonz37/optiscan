/**
 * subscriber-config-validator.ts — fail-closed startup validation for subscriber Discord ownership.
 */
import {
  independentOwnsSubscriberOptionsDiscord,
  subscriberDiscordOwnershipSummary,
  subscriberOptionsDiscordOwner,
} from "./subscriber-discord-owner.ts";
import { inspectSchemaReadiness } from "./db-schema-readiness.ts";

export interface SubscriberConfigValidation {
  ok: boolean;
  fatal: string[];
  warnings: string[];
  ownership: ReturnType<typeof subscriberDiscordOwnershipSummary>;
  schemaOk?: boolean;
  schemaMissing?: string[];
}

export function validateSubscriberConfig(env: NodeJS.ProcessEnv = process.env): SubscriberConfigValidation {
  const ownership = subscriberDiscordOwnershipSummary(env);
  const owner = subscriberOptionsDiscordOwner(env);
  const fatal: string[] = [];
  const warnings: string[] = [];

  if (owner === "independent") {
    if (env.AGENT_CALLOUT_DISCORD === "1") {
      fatal.push("AGENT_CALLOUT_DISCORD=1 conflicts with SUBSCRIBER_OPTIONS_DISCORD_OWNER=independent");
    }
    if (env.INDEPENDENT_OPTIONS_DISCOVERY_ENABLED !== "1") {
      fatal.push("independent owner requires INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1");
    }
    if (env.EARLY_OPTIONS_CALLOUTS_ENABLED !== "1") {
      fatal.push("independent owner requires EARLY_OPTIONS_CALLOUTS_ENABLED=1");
    }
    if (env.OPTIONS_PORTFOLIO_DELIVERY_ENABLED !== "1") {
      fatal.push("independent owner requires OPTIONS_PORTFOLIO_DELIVERY_ENABLED=1");
    }
    if (env.AGENT_CALLOUT_DISCORD === "1" && env.EARLY_OPTIONS_CALLOUTS_ENABLED === "1") {
      fatal.push("both supervisor and independent Discord send paths enabled");
    }
    if (!env.DISCORD_WEBHOOK_OPTIONS && !env.DISCORD_WEBHOOK_URL) {
      warnings.push("DISCORD_WEBHOOK_OPTIONS not set — delivery will fail closed");
    }
  }

  if (owner === "supervisor" && env.AGENT_CALLOUT_DISCORD !== "1") {
    warnings.push("supervisor owner but AGENT_CALLOUT_DISCORD!=1 — no options Discord auto-send");
  }

  if (owner === "legacy" && env.CALLOUT_CANONICAL_PATH === "supervisor") {
    warnings.push("legacy owner with CALLOUT_CANONICAL_PATH=supervisor — verify intended routing");
  }

  return { ok: fatal.length === 0, fatal, warnings, ownership };
}

export function subscriberConfigStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUBSCRIBER_CONFIG_STRICT !== "0";
}

export function validateSubscriberConfigWithSchema(
  db: { prepare: (sql: string) => { get?: (...a: unknown[]) => unknown; all?: (...a: unknown[]) => unknown[]; run?: (...a: unknown[]) => unknown } } | null,
  env: NodeJS.ProcessEnv = process.env,
): SubscriberConfigValidation {
  const base = validateSubscriberConfig(env);
  if (!db || !independentOwnsSubscriberOptionsDiscord(env)) return base;
  try {
    const schema = inspectSchemaReadiness(db as any, env);
    const missing: string[] = [
      ...schema.missingShadowSoakTables,
      ...schema.missingInstrumentationColumns.map((c) => `${c.table}.${c.column}`),
    ];
    if (subscriberConfigStrict(env) && !schema.ok) {
      return {
        ...base,
        ok: false,
        fatal: [...base.fatal, `instrumentation schema incomplete: ${missing.slice(0, 8).join(", ")}`],
        schemaOk: false,
        schemaMissing: missing,
      };
    }
    return { ...base, schemaOk: schema.ok, schemaMissing: missing };
  } catch {
    return base;
  }
}

/** Persist boot validation to options_diagnostics when db available. */
export function persistSubscriberConfigValidation(db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get?: (...a: unknown[]) => unknown } }, result: SubscriberConfigValidation, nowMs: number): void {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_diagnostics'").get?.()) return;
    db.prepare(
      `INSERT INTO options_diagnostics (cycle_at_ms, session, tickers_considered, chains_ok, chains_failed, canonical, emitted, delivered, note, created_at_ms)
       VALUES (?,?,0,0,0,0,0,0,?,?)`,
    ).run(
      nowMs,
      "boot",
      JSON.stringify({ kind: "subscriber_config_validation", ok: result.ok, fatal: result.fatal, warnings: result.warnings, ownership: result.ownership, schemaOk: result.schemaOk, schemaMissing: result.schemaMissing }),
      nowMs,
    );
  } catch { /* isolated */ }
}

export function shouldBlockIndependentDelivery(result: SubscriberConfigValidation, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!subscriberConfigStrict(env)) return false;
  if (!independentOwnsSubscriberOptionsDiscord(env)) return false;
  return !result.ok;
}

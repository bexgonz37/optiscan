/**
 * Subscriber store — Stripe customer ↔ Discord user ↔ role sync state.
 */
export type SubscriberStatus = "inactive" | "trialing" | "active" | "past_due" | "canceled" | "refunded";

interface SubDb {
  prepare(sql: string): {
    get: (...args: any[]) => any;
    all: (...args: any[]) => any[];
    run: (...args: any[]) => { changes: number; lastInsertRowid?: number | bigint };
  };
}

export type BillingDb = SubDb;

function hasTable(db: SubDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

export interface SubscriberRow {
  id: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  discordUserId: string | null;
  email: string | null;
  status: SubscriberStatus;
  planId: string | null;
  currentPeriodEndMs: number | null;
  graceUntilMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

function mapRow(r: Record<string, unknown>): SubscriberRow {
  return {
    id: Number(r.id),
    stripeCustomerId: r.stripe_customer_id != null ? String(r.stripe_customer_id) : null,
    stripeSubscriptionId: r.stripe_subscription_id != null ? String(r.stripe_subscription_id) : null,
    discordUserId: r.discord_user_id != null ? String(r.discord_user_id) : null,
    email: r.email != null ? String(r.email) : null,
    status: String(r.status ?? "inactive") as SubscriberStatus,
    planId: r.plan_id != null ? String(r.plan_id) : null,
    currentPeriodEndMs: r.current_period_end_ms != null ? Number(r.current_period_end_ms) : null,
    graceUntilMs: r.grace_until_ms != null ? Number(r.grace_until_ms) : null,
    createdAtMs: Number(r.created_at_ms),
    updatedAtMs: Number(r.updated_at_ms),
  };
}

export function upsertSubscriberOnDb(
  db: SubDb,
  row: {
    stripeCustomerId: string;
    stripeSubscriptionId?: string | null;
    email?: string | null;
    status: SubscriberStatus;
    planId?: string | null;
    currentPeriodEndMs?: number | null;
    graceUntilMs?: number | null;
    discordUserId?: string | null;
  },
  nowMs = Date.now(),
): SubscriberRow | null {
  if (!hasTable(db, "subscribers")) return null;
  const existing = db
    .prepare(`SELECT id FROM subscribers WHERE stripe_customer_id=?`)
    .get(row.stripeCustomerId) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE subscribers SET stripe_subscription_id=COALESCE(?, stripe_subscription_id),
       email=COALESCE(?, email), status=?, plan_id=COALESCE(?, plan_id),
       current_period_end_ms=COALESCE(?, current_period_end_ms), grace_until_ms=?,
       discord_user_id=COALESCE(?, discord_user_id), updated_at_ms=? WHERE id=?`,
    ).run(
      row.stripeSubscriptionId ?? null,
      row.email ?? null,
      row.status,
      row.planId ?? null,
      row.currentPeriodEndMs ?? null,
      row.graceUntilMs ?? null,
      row.discordUserId ?? null,
      nowMs,
      existing.id,
    );
    return mapRow(db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(existing.id) as Record<string, unknown>);
  }
  const r = db
    .prepare(
      `INSERT INTO subscribers
        (stripe_customer_id, stripe_subscription_id, discord_user_id, email, status, plan_id,
         current_period_end_ms, grace_until_ms, created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.stripeCustomerId,
      row.stripeSubscriptionId ?? null,
      row.discordUserId ?? null,
      row.email ?? null,
      row.status,
      row.planId ?? "discord_monthly",
      row.currentPeriodEndMs ?? null,
      row.graceUntilMs ?? null,
      nowMs,
      nowMs,
    );
  return mapRow(db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(Number(r.lastInsertRowid)) as Record<string, unknown>);
}

export function linkDiscordUserOnDb(db: SubDb, stripeCustomerId: string, discordUserId: string, nowMs = Date.now()): boolean {
  if (!hasTable(db, "subscribers")) return false;
  const r = db
    .prepare(`UPDATE subscribers SET discord_user_id=?, updated_at_ms=? WHERE stripe_customer_id=?`)
    .run(discordUserId, nowMs, stripeCustomerId);
  return Number(r.changes) > 0;
}

export function listSubscribersOnDb(db: SubDb, limit = 50): SubscriberRow[] {
  if (!hasTable(db, "subscribers")) return [];
  return (db.prepare(`SELECT * FROM subscribers ORDER BY updated_at_ms DESC LIMIT ?`).all(limit) as Record<string, unknown>[]).map(mapRow);
}

export function recordSubscriptionEventOnDb(
  db: SubDb,
  stripeEventId: string,
  eventType: string,
  payloadJson: string,
  processedOk: boolean,
  error: string | null,
  nowMs = Date.now(),
): boolean {
  if (!hasTable(db, "subscription_events")) return false;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO subscription_events
        (stripe_event_id, event_type, payload_json, processed_ok, error, created_at_ms)
       VALUES (?,?,?,?,?,?)`,
    ).run(stripeEventId, eventType, payloadJson, processedOk ? 1 : 0, error, nowMs);
    return true;
  } catch {
    return false;
  }
}

export function logDiscordRoleSyncOnDb(
  db: SubDb,
  discordUserId: string,
  action: string,
  ok: boolean,
  reason: string | null,
  nowMs = Date.now(),
): void {
  if (!hasTable(db, "discord_role_sync_log")) return;
  try {
    db.prepare(
      `INSERT INTO discord_role_sync_log (discord_user_id, action, ok, reason, created_at_ms) VALUES (?,?,?,?,?)`,
    ).run(discordUserId, action, ok ? 1 : 0, reason, nowMs);
  } catch { /* best effort */ }
}

export function subscriberOpsSummary(db: SubDb): {
  total: number;
  active: number;
  pastDue: number;
  canceled: number;
  unlinkedDiscord: number;
  recentRoleSyncErrors: number;
} {
  if (!hasTable(db, "subscribers")) {
    return { total: 0, active: 0, pastDue: 0, canceled: 0, unlinkedDiscord: 0, recentRoleSyncErrors: 0 };
  }
  const total = Number((db.prepare(`SELECT COUNT(*) n FROM subscribers`).get() as { n: number })?.n ?? 0);
  const active = Number((db.prepare(`SELECT COUNT(*) n FROM subscribers WHERE status IN ('active','trialing')`).get() as { n: number })?.n ?? 0);
  const pastDue = Number((db.prepare(`SELECT COUNT(*) n FROM subscribers WHERE status='past_due'`).get() as { n: number })?.n ?? 0);
  const canceled = Number((db.prepare(`SELECT COUNT(*) n FROM subscribers WHERE status='canceled'`).get() as { n: number })?.n ?? 0);
  const unlinkedDiscord = Number(
    (db.prepare(`SELECT COUNT(*) n FROM subscribers WHERE status IN ('active','trialing','past_due') AND (discord_user_id IS NULL OR discord_user_id='')`).get() as { n: number })?.n ?? 0,
  );
  const since = Date.now() - 24 * 3600_000;
  const recentRoleSyncErrors = hasTable(db, "discord_role_sync_log")
    ? Number(
        (db.prepare(`SELECT COUNT(*) n FROM discord_role_sync_log WHERE ok=0 AND created_at_ms>=?`).get(since) as { n: number })?.n ?? 0,
      )
    : 0;
  return { total, active, pastDue, canceled, unlinkedDiscord, recentRoleSyncErrors };
}

import { createHash } from "node:crypto";

type GuardDb = {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown;
    run: (...args: unknown[]) => { changes: number };
  };
  transaction?: <T extends (...args: any[]) => any>(fn: T) => T;
};

export type RecapClaimResult = {
  allowed: boolean;
  idempotencyKey: string;
  reason: "claimed" | "disabled" | "duplicate" | "rate_limited" | "in_flight" | "retry_backoff" | "retry_exhausted";
};

const WINDOW_MS = 10 * 60_000;
const MAX_POSTS = 2;
const MAX_ATTEMPTS = 3;

export function recapDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DISCORD_RECAP_ENABLED !== "0";
}

export function recapPayloadKey(payload: unknown, payloadType = "recap"): string {
  const digest = createHash("sha256").update(JSON.stringify(payload ?? {})).digest("hex").slice(0, 32);
  return `recap:${payloadType}:${digest}`;
}

function ensureSchema(db: GuardDb): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS recap_delivery_claims (
      idempotency_key TEXT PRIMARY KEY,
      payload_type TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      next_retry_at_ms INTEGER,
      suppression_reason TEXT,
      discord_message_id TEXT
    )`,
  ).run();
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_recap_delivery_claims_window ON recap_delivery_claims(created_at_ms, status)",
  ).run();
}

export function claimRecapDelivery(
  db: GuardDb,
  input: {
    payload: unknown;
    payloadType?: string;
    idempotencyKey?: string | null;
    nowMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): RecapClaimResult {
  const nowMs = input.nowMs ?? Date.now();
  const payloadType = input.payloadType ?? "recap";
  const idempotencyKey = input.idempotencyKey ?? recapPayloadKey(input.payload, payloadType);
  ensureSchema(db);

  const claim = () => {
    const existing = db.prepare(
      "SELECT status, attempt_count, next_retry_at_ms FROM recap_delivery_claims WHERE idempotency_key=?",
    ).get(idempotencyKey) as { status?: string; attempt_count?: number; next_retry_at_ms?: number | null } | undefined;

    if (!recapDeliveryEnabled(input.env)) {
      if (existing) {
        db.prepare(
          "UPDATE recap_delivery_claims SET attempt_count=attempt_count+1, updated_at_ms=?, suppression_reason='disabled' WHERE idempotency_key=?",
        ).run(nowMs, idempotencyKey);
      } else {
        db.prepare(
          `INSERT INTO recap_delivery_claims
            (idempotency_key,payload_type,status,attempt_count,created_at_ms,updated_at_ms,suppression_reason)
           VALUES (?,?,'SUPPRESSED',1,?,?,'disabled')`,
        ).run(idempotencyKey, payloadType, nowMs, nowMs);
      }
      return { allowed: false, idempotencyKey, reason: "disabled" as const };
    }

    if (existing) {
      if (existing.status === "SENT" || existing.status === "SUPPRESSED") {
        db.prepare(
          "UPDATE recap_delivery_claims SET attempt_count=attempt_count+1, updated_at_ms=?, suppression_reason='duplicate' WHERE idempotency_key=?",
        ).run(nowMs, idempotencyKey);
        return { allowed: false, idempotencyKey, reason: "duplicate" as const };
      }
      if (existing.status === "CLAIMED") {
        return { allowed: false, idempotencyKey, reason: "in_flight" as const };
      }
      const attempts = Number(existing.attempt_count ?? 1);
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare(
          "UPDATE recap_delivery_claims SET status='SUPPRESSED', updated_at_ms=?, suppression_reason='retry_exhausted' WHERE idempotency_key=?",
        ).run(nowMs, idempotencyKey);
        return { allowed: false, idempotencyKey, reason: "retry_exhausted" as const };
      }
      if (Number(existing.next_retry_at_ms ?? 0) > nowMs) {
        return { allowed: false, idempotencyKey, reason: "retry_backoff" as const };
      }
    }

    const recent = db.prepare(
      `SELECT COUNT(*) AS n FROM recap_delivery_claims
       WHERE created_at_ms>=? AND status IN ('CLAIMED','SENT')`,
    ).get(nowMs - WINDOW_MS) as { n?: number } | undefined;
    if (Number(recent?.n ?? 0) >= MAX_POSTS) {
      if (existing) {
        db.prepare(
          "UPDATE recap_delivery_claims SET status='SUPPRESSED', updated_at_ms=?, suppression_reason='rate_limited' WHERE idempotency_key=?",
        ).run(nowMs, idempotencyKey);
      } else {
        db.prepare(
          `INSERT INTO recap_delivery_claims
            (idempotency_key,payload_type,status,attempt_count,created_at_ms,updated_at_ms,suppression_reason)
           VALUES (?,?,'SUPPRESSED',1,?,?,'rate_limited')`,
        ).run(idempotencyKey, payloadType, nowMs, nowMs);
      }
      return { allowed: false, idempotencyKey, reason: "rate_limited" as const };
    }

    if (existing) {
      db.prepare(
        `UPDATE recap_delivery_claims
         SET status='CLAIMED', attempt_count=attempt_count+1, updated_at_ms=?,
             next_retry_at_ms=NULL, suppression_reason=NULL
         WHERE idempotency_key=?`,
      ).run(nowMs, idempotencyKey);
    } else {
      db.prepare(
        `INSERT INTO recap_delivery_claims
          (idempotency_key,payload_type,status,attempt_count,created_at_ms,updated_at_ms)
         VALUES (?,?,'CLAIMED',1,?,?)`,
      ).run(idempotencyKey, payloadType, nowMs, nowMs);
    }
    return { allowed: true, idempotencyKey, reason: "claimed" as const };
  };

  return db.transaction ? db.transaction(claim)() : claim();
}

export function completeRecapDelivery(
  db: GuardDb,
  idempotencyKey: string,
  input: { ok: boolean; messageId?: string | null; nowMs?: number; error?: string | null },
): void {
  const nowMs = input.nowMs ?? Date.now();
  if (input.ok) {
    db.prepare(
      `UPDATE recap_delivery_claims
       SET status='SENT', updated_at_ms=?, next_retry_at_ms=NULL,
           suppression_reason=NULL, discord_message_id=?
       WHERE idempotency_key=?`,
    ).run(nowMs, input.messageId ?? null, idempotencyKey);
    return;
  }
  const row = db.prepare(
    "SELECT attempt_count FROM recap_delivery_claims WHERE idempotency_key=?",
  ).get(idempotencyKey) as { attempt_count?: number } | undefined;
  const attempts = Number(row?.attempt_count ?? 1);
  const exhausted = attempts >= MAX_ATTEMPTS;
  const backoffMs = Math.min(5 * 60_000, 30_000 * (2 ** Math.max(0, attempts - 1)));
  db.prepare(
    `UPDATE recap_delivery_claims
     SET status=?, updated_at_ms=?, next_retry_at_ms=?, suppression_reason=?
     WHERE idempotency_key=?`,
  ).run(
    exhausted ? "SUPPRESSED" : "FAILED",
    nowMs,
    exhausted ? null : nowMs + backoffMs,
    exhausted ? "retry_exhausted" : String(input.error ?? "delivery_failed").slice(0, 180),
    idempotencyKey,
  );
}

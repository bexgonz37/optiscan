/**
 * callouts/smoke.ts — the manual Discord smoke test (live runtime wiring).
 * Next-server module. Disabled by default; a real send requires DISCORD_SMOKE_TEST=1.
 *
 * It renders the TEST/DRY-RUN fixture callouts (formatting/routing check) and,
 * only on an explicit send, delivers them through the SAME tracked ledger as real
 * callouts (idempotency-guarded, so repeated runs in the same hour dedup). It
 * NEVER creates a paper trade, fingerprint, outcome, or model-training row.
 */
import { buildSmokeCallouts, type SmokeCallout } from "@/lib/callouts/smoke-fixtures";
import { deliverCalloutDiscord } from "@/lib/notifications";

export function smokeTestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DISCORD_SMOKE_TEST === "1";
}

function toWebhookPayload(p: SmokeCallout["payload"]): Record<string, unknown> {
  return p.embed ? { content: p.content, embeds: [p.embed] } : { content: p.content };
}

function hourBucket(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 13);
}

export interface SmokeResult {
  ok: boolean;
  sent: boolean;
  dryRun?: boolean;
  reason?: string;
  scenarios?: { name: string; webhook: string; payload?: SmokeCallout["payload"] }[];
  results?: { name: string; webhook: string; sent: boolean; skipped?: boolean; status: string; reason?: string }[];
}

export async function runDiscordSmokeTest(opts: { send?: boolean; nowMs?: number } = {}): Promise<SmokeResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const send = opts.send === true;
  const items = buildSmokeCallouts();

  if (send && !smokeTestEnabled()) {
    return {
      ok: false, sent: false,
      reason: "DISCORD_SMOKE_TEST is not enabled (set DISCORD_SMOKE_TEST=1 to permit a real send).",
      scenarios: items.map((i) => ({ name: i.name, webhook: i.webhook })),
    };
  }
  if (!send) {
    return { ok: true, sent: false, dryRun: true, scenarios: items.map((i) => ({ name: i.name, webhook: i.webhook, payload: i.payload })) };
  }

  const results: NonNullable<SmokeResult["results"]> = [];
  for (const it of items) {
    const res = await deliverCalloutDiscord({
      webhook: it.webhook,
      payload: toWebhookPayload(it.payload),
      idempotencyKey: `smoke:${it.name}:${hourBucket(nowMs)}`,
    });
    results.push({ name: it.name, webhook: it.webhook, sent: res.sent, skipped: res.skipped, status: res.status, reason: res.reason });
  }
  return { ok: true, sent: true, results };
}

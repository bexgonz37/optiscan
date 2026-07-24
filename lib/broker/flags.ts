/**
 * Brokerage v2 feature gate (B0/B1). Defaults OFF — zero impact on live scanner,
 * Discord delivery, deterministic gates, or AI authority until explicitly enabled.
 */

export function paperBrokerV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPER_BROKER_V2_ENABLED === "1";
}

export function requirePaperBrokerV2(env: NodeJS.ProcessEnv = process.env): void {
  if (!paperBrokerV2Enabled(env)) {
    throw new Error("PAPER_BROKER_V2_ENABLED=0 — brokerage v2 writes are disabled");
  }
}

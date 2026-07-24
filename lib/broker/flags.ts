/**
 * Brokerage V2 feature gates (B0–B6).
 * All default OFF — zero impact on scanner, Discord, gates, thresholds, AI.
 */
export const CUTOVER_POLICY_VERSION = 1;

export function paperBrokerV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPER_BROKER_V2_ENABLED === "1";
}

export function paperBrokerV2ShadowReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPER_BROKER_V2_SHADOW_READ_ENABLED === "1";
}

/** Approved V2 read cutover. Must remain OFF in B6 production. */
export function paperBrokerV2ReadsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPER_BROKER_V2_READS_ENABLED === "1";
}

export function requirePaperBrokerV2(env: NodeJS.ProcessEnv = process.env): void {
  if (!paperBrokerV2Enabled(env)) {
    throw new Error("PAPER_BROKER_V2_ENABLED=0 — brokerage v2 writes are disabled");
  }
}

export interface FlagValidationResult {
  ok: boolean;
  errors: string[];
  flags: {
    dualWrite: boolean;
    shadowRead: boolean;
    v2Reads: boolean;
  };
}

/**
 * Startup / config guard — reject unsafe flag combinations.
 * Does not throw by default; callers may throw on !ok.
 */
export function validateBrokerV2FlagCombination(
  env: NodeJS.ProcessEnv = process.env,
): FlagValidationResult {
  const dualWrite = paperBrokerV2Enabled(env);
  const shadowRead = paperBrokerV2ShadowReadEnabled(env);
  const v2Reads = paperBrokerV2ReadsEnabled(env);
  const errors: string[] = [];

  if (v2Reads && !dualWrite) {
    errors.push(
      "PAPER_BROKER_V2_READS_ENABLED=1 requires PAPER_BROKER_V2_ENABLED=1 (cannot serve V2 reads without dual-write path)",
    );
  }
  if (v2Reads && shadowRead) {
    errors.push(
      "PAPER_BROKER_V2_READS_ENABLED=1 and PAPER_BROKER_V2_SHADOW_READ_ENABLED=1 cannot both be set (no dual-authoritative mode)",
    );
  }

  return { ok: errors.length === 0, errors, flags: { dualWrite, shadowRead, v2Reads } };
}

export function assertBrokerV2FlagsSafe(env: NodeJS.ProcessEnv = process.env): void {
  const v = validateBrokerV2FlagCombination(env);
  if (!v.ok) {
    throw new Error(`Invalid Brokerage V2 flag combination: ${v.errors.join("; ")}`);
  }
}

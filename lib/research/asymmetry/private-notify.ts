/**
 * private-notify.ts — the owner-private High-Asymmetry surfacing path.
 *
 * PURE except for one injected sender. No React, no DB, no scheduler.
 *
 * This module exists to let the radar privately surface early candidates to the
 * OWNER only. It is built to be safe to merge while switched off, so every
 * boundary below is enforced in code rather than by convention:
 *
 *  1. OFF BY DEFAULT. Both HIGH_ASYMMETRY_PRIVATE_ENABLED=1 and a non-empty
 *     HIGH_ASYMMETRY_PRIVATE_WEBHOOK are required. Missing either is an inert
 *     no-op that performs no work and returns a reason.
 *  2. NO SUBSCRIBER FALLBACK. The webhook is read from ONE dedicated variable.
 *     There is no `?? DISCORD_WEBHOOK_*` anywhere, and a configured value that
 *     matches any known subscriber/watchlist/recap/alert webhook is REFUSED —
 *     so a copy-paste mistake cannot route research into a subscriber channel.
 *  3. NO SEND AUTHORITY. This path cannot create an alert, select a contract,
 *     freeze an entry, or write paper state. It only formats a message.
 *  4. ONLY EARLY STATES. PREMIUM_CHASE, LIQUIDITY_FAILURE, INVALIDATED, and
 *     INSUFFICIENT_EVIDENCE are never surfaced — a chased candidate is exactly
 *     what the radar exists to avoid presenting as early.
 *  5. NOISE CONTROLLED. One case per fingerprint, state-change only, and a
 *     per-symbol-per-session ceiling.
 */
import type { AsymmetryResearchState } from "./states.ts";
import { contractDisplay, entryDisplay, contractFooter } from "./contract-format.ts";

/** The only states worth an owner's attention. Everything else stays silent. */
export const PRIVATE_NOTIFIABLE_STATES: readonly AsymmetryResearchState[] = Object.freeze([
  "EARLY_ASYMMETRY",
  "CONFIRMING",
  "HIGH_ASYMMETRY",
  "TRIGGERED",
]);

/** Explicitly never surfaced, even if a caller asks. */
export const PRIVATE_SUPPRESSED_STATES: readonly AsymmetryResearchState[] = Object.freeze([
  "PREMIUM_CHASE",
  "LIQUIDITY_FAILURE",
  "INVALIDATED",
  "INSUFFICIENT_EVIDENCE",
]);

/**
 * Environment variables whose values must NEVER be used by this path. If the
 * private webhook equals any of these, the send is refused: that would put
 * research output in front of subscribers.
 */
export const FORBIDDEN_WEBHOOK_ENV = Object.freeze([
  "DISCORD_WEBHOOK_URL",
  "DISCORD_WEBHOOK_OPTIONS",
  "DISCORD_WEBHOOK_STOCKS",
  "DISCORD_WEBHOOK_WATCHLIST",
  "DISCORD_WEBHOOK_RECAP",
]);

export const PRIVATE_ENABLED_ENV = "HIGH_ASYMMETRY_PRIVATE_ENABLED";
export const PRIVATE_WEBHOOK_ENV = "HIGH_ASYMMETRY_PRIVATE_WEBHOOK";
export const PRIVATE_MAX_SESSION_MESSAGES_ENV = "HIGH_ASYMMETRY_MAX_MESSAGES_PER_SESSION";

/** Default ceiling on owner messages per symbol per session. */
export const DEFAULT_MAX_MESSAGES_PER_SYMBOL_SESSION = 4;
/** Default ceiling on all owner-private High-Asymmetry messages per session. */
export const DEFAULT_MAX_MESSAGES_PER_SESSION = 40;

export type PrivateNotifyOutcome =
  | "DISABLED"
  | "NOT_CONFIGURED"
  | "REFUSED_SUBSCRIBER_WEBHOOK"
  | "SUPPRESSED_STATE"
  | "SUPPRESSED_UNCHANGED"
  | "SUPPRESSED_RATE_LIMIT"
  | "SENT"
  | "SEND_FAILED";

export interface PrivateCandidate {
  /** Stable identity: one active case per fingerprint per session. */
  fingerprint: string;
  sessionDate: string;
  symbol: string;
  direction: "CALL" | "PUT";
  /** Exact OCC. Required — a candidate we cannot identify is not surfaced. */
  optionSymbol: string;
  state: AsymmetryResearchState;
  observedAtMs: number;
  /** Why this is early, in one plain sentence. */
  whyEarly: string;
  /** Premium expansion from the earliest valid executable quote, percent. */
  premiumChasePct: number | null;
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  openInterest: number | null;
  contractVolume: number | null;
  trigger: string | null;
  invalidation: string | null;
  /** Evidence known to be absent. Reported, never silently defaulted. */
  missingEvidence: string[];
  setupFamilyLabel: string | null;
  /** Underlying price at detection. Optional — reported absent, never faked. */
  underlyingPrice?: number | null;
  /** The deterministic paper state. Never implies a trade that did not open. */
  paperStatus?: "OPENED" | "WAITING_FOR_ENTRY" | "BLOCKED" | "DISABLED" | null;
}

export interface PrivateNotifyResult {
  outcome: PrivateNotifyOutcome;
  reason: string | null;
  /** The message that WOULD be sent. Present even when inert, for preview. */
  content: string | null;
  fingerprint: string;
  state: AsymmetryResearchState;
  /** Always false. This path has no subscriber authority. */
  subscriberSendCreated: false;
}

/** Per-session, per-fingerprint memory. Injected so it is testable and bounded. */
export interface PrivateCaseMemory {
  /** Last state surfaced for a fingerprint, or undefined if never surfaced. */
  lastState: (fingerprint: string) => AsymmetryResearchState | undefined;
  /** Record that a state was surfaced. */
  record: (fingerprint: string, state: AsymmetryResearchState) => void;
  /** How many owner messages already sent for this symbol this session. */
  sentCountForSymbol: (sessionDate: string, symbol: string) => number;
  /** Increment that counter. */
  incrementSymbol: (sessionDate: string, symbol: string) => void;
  /** How many owner messages already sent for this whole session. */
  sentCountForSession: (sessionDate: string) => number;
  /** Increment the session-wide counter. */
  incrementSession: (sessionDate: string) => void;
}

/** A simple in-memory implementation. Bounded by session + fingerprint. */
export function createPrivateCaseMemory(): PrivateCaseMemory {
  const states = new Map<string, AsymmetryResearchState>();
  const counts = new Map<string, number>();
  const sessionCounts = new Map<string, number>();
  const key = (sessionDate: string, symbol: string) => `${sessionDate}|${symbol.toUpperCase()}`;
  return {
    lastState: (fp) => states.get(fp),
    record: (fp, state) => { states.set(fp, state); },
    sentCountForSymbol: (d, s) => counts.get(key(d, s)) ?? 0,
    incrementSymbol: (d, s) => { counts.set(key(d, s), (counts.get(key(d, s)) ?? 0) + 1); },
    sentCountForSession: (d) => sessionCounts.get(d) ?? 0,
    incrementSession: (d) => { sessionCounts.set(d, (sessionCounts.get(d) ?? 0) + 1); },
  };
}

export interface PrivateNotifyConfig {
  enabled: boolean;
  webhook: string | null;
  /** Non-null when the configured webhook collides with a subscriber one. */
  refusedReason: string | null;
}

/**
 * Resolve configuration from env. Reads ONE dedicated variable for the webhook
 * and never falls back to a subscriber webhook.
 */
export function resolvePrivateConfig(env: NodeJS.ProcessEnv = process.env): PrivateNotifyConfig {
  const enabled = env[PRIVATE_ENABLED_ENV] === "1";
  const raw = String(env[PRIVATE_WEBHOOK_ENV] ?? "").trim();
  const webhook = raw ? raw : null;
  let refusedReason: string | null = null;
  if (webhook) {
    for (const name of FORBIDDEN_WEBHOOK_ENV) {
      const other = String(env[name] ?? "").trim();
      if (other && other === webhook) {
        refusedReason = `private webhook is the same value as ${name}`;
        break;
      }
    }
  }
  return { enabled, webhook, refusedReason };
}

export function resolvePrivateSessionMessageLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[PRIVATE_MAX_SESSION_MESSAGES_ENV]);
  return Number.isFinite(n) ? Math.max(0, Math.min(500, Math.floor(n))) : DEFAULT_MAX_MESSAGES_PER_SESSION;
}

const money = (n: number | null) => (n == null ? "unavailable" : `$${n.toFixed(2)}`);
const pct = (n: number | null) => (n == null ? "unavailable" : `${n.toFixed(1)}%`);

/**
 * Build the owner message. Deterministic, and never claims a prediction.
 * Includes exact OCC deliberately: this is an owner-private research channel,
 * not subscriber copy, and the owner needs the contract to verify the mark.
 */
export function buildPrivateMessage(c: PrivateCandidate): string {
  const lines: string[] = [
    `**HIGH ASYMMETRY — ${c.direction}**`,
    "",
    `**${contractDisplay(c.optionSymbol, c.symbol)}**`,
    `Entry: ${entryDisplay(c.bid, c.ask)}`,
    `Underlying: ${c.underlyingPrice != null ? money(c.underlyingPrice) : "unavailable"}`,
    `State: ${c.state}`,
  ];

  // WHY — at most three bullets, each backed by a measured value. A reason we
  // cannot support is omitted rather than padded with filler.
  const why: string[] = [];
  if (String(c.whyEarly ?? "").trim()) why.push(String(c.whyEarly).trim());
  if (c.premiumChasePct != null) {
    why.push(c.premiumChasePct <= 10
      ? `Premium still near the earliest valid quote (+${c.premiumChasePct.toFixed(1)}%).`
      : `Premium already expanded +${c.premiumChasePct.toFixed(1)}% from the earliest valid quote.`);
  }
  if (c.setupFamilyLabel) why.push(`Setup: ${c.setupFamilyLabel}.`);
  if (why.length) {
    lines.push("", "Why:", ...why.slice(0, 3).map((w) => `- ${w}`));
  }

  lines.push("", "Confirmation:", `- ${c.trigger ?? "no published trigger level recorded"}`);
  lines.push("", "Invalidation:", `- ${c.invalidation ?? "no invalidation level recorded"}`);

  // RISK — one concrete warning, worst first. Never a generic disclaimer.
  lines.push("", "Risk:", `- ${riskLine(c)}`);

  lines.push("", `Paper: ${c.paperStatus ?? "DISABLED"}`);
  lines.push("", `Research only. Options are high risk. ${contractFooter(c.optionSymbol)}`);
  return lines.join("\n").slice(0, 1900);
}

/**
 * The single most material caveat, chosen in a fixed order so the worst problem
 * is the one shown. Only conditions actually measured can be reported.
 */
export function riskLine(c: PrivateCandidate): string {
  if (c.spreadPct != null && c.spreadPct > 20) {
    return `Wide spread ${c.spreadPct.toFixed(1)}% — the fill will be worse than it looks.`;
  }
  if (c.premiumChasePct != null && c.premiumChasePct >= 25) {
    return `Premium chase +${c.premiumChasePct.toFixed(1)}% — the early entry is already gone.`;
  }
  if (c.openInterest != null && c.openInterest < 100) {
    return `Thin open interest (${c.openInterest}) — exiting may be difficult.`;
  }
  if (c.contractVolume != null && c.contractVolume < 50) {
    return `Low contract volume (${c.contractVolume}) — liquidity is unproven today.`;
  }
  if (c.missingEvidence.length) {
    return `Incomplete evidence: ${c.missingEvidence.slice(0, 3).join(", ")}.`;
  }
  if (c.spreadPct != null) return `Spread ${c.spreadPct.toFixed(1)}% at detection; verify before entry.`;
  return "Quote quality not fully verified — confirm the contract before acting.";
}

export interface PrivateSendDeps {
  /** Injected sender. Receives the resolved private webhook ONLY. */
  send?: (webhook: string, content: string) => Promise<{ ok: boolean; reason?: string }>;
  memory: PrivateCaseMemory;
  env?: NodeJS.ProcessEnv;
  maxPerSymbolSession?: number;
  maxPerSession?: number;
}

/**
 * Surface one candidate to the owner-private channel, subject to every gate.
 * Never throws: a failure is returned as a result so a tracking or delivery
 * fault can never propagate into the scanner or the live delivery path.
 */
export async function notifyPrivateAsymmetry(
  candidate: PrivateCandidate,
  deps: PrivateSendDeps,
): Promise<PrivateNotifyResult> {
  const base = {
    fingerprint: candidate.fingerprint,
    state: candidate.state,
    subscriberSendCreated: false as const,
  };
  try {
    // Gate 1 — state. Chased/failed/invalid candidates are never surfaced.
    if (!PRIVATE_NOTIFIABLE_STATES.includes(candidate.state)) {
      return { ...base, outcome: "SUPPRESSED_STATE", reason: `${candidate.state} is not surfaced`, content: null };
    }

    const cfg = resolvePrivateConfig(deps.env ?? process.env);

    // Gate 2 — flag. Off means no work at all.
    if (!cfg.enabled) {
      return { ...base, outcome: "DISABLED", reason: `${PRIVATE_ENABLED_ENV} is not set`, content: null };
    }
    // Gate 3 — dedicated webhook, with no subscriber fallback.
    if (!cfg.webhook) {
      return { ...base, outcome: "NOT_CONFIGURED", reason: `${PRIVATE_WEBHOOK_ENV} is not set`, content: null };
    }
    if (cfg.refusedReason) {
      return { ...base, outcome: "REFUSED_SUBSCRIBER_WEBHOOK", reason: cfg.refusedReason, content: null };
    }

    // Gate 4 — state change only. An unchanged repeat is silence.
    const previous = deps.memory.lastState(candidate.fingerprint);
    if (previous === candidate.state) {
      return { ...base, outcome: "SUPPRESSED_UNCHANGED", reason: `already surfaced as ${candidate.state}`, content: null };
    }

    // Gate 5 — per-symbol session ceiling.
    const ceiling = deps.maxPerSymbolSession ?? DEFAULT_MAX_MESSAGES_PER_SYMBOL_SESSION;
    if (deps.memory.sentCountForSymbol(candidate.sessionDate, candidate.symbol) >= ceiling) {
      return { ...base, outcome: "SUPPRESSED_RATE_LIMIT", reason: `symbol ceiling ${ceiling} reached`, content: null };
    }
    const sessionCeiling = deps.maxPerSession ?? resolvePrivateSessionMessageLimit(deps.env ?? process.env);
    if (deps.memory.sentCountForSession(candidate.sessionDate) >= sessionCeiling) {
      return { ...base, outcome: "SUPPRESSED_RATE_LIMIT", reason: `session ceiling ${sessionCeiling} reached`, content: null };
    }

    const content = buildPrivateMessage(candidate);
    if (!deps.send) {
      return { ...base, outcome: "NOT_CONFIGURED", reason: "no sender injected", content };
    }
    const res = await deps.send(cfg.webhook, content);
    if (!res.ok) {
      return { ...base, outcome: "SEND_FAILED", reason: res.reason ?? "send failed", content };
    }
    deps.memory.record(candidate.fingerprint, candidate.state);
    deps.memory.incrementSymbol(candidate.sessionDate, candidate.symbol);
    deps.memory.incrementSession(candidate.sessionDate);
    return { ...base, outcome: "SENT", reason: null, content };
  } catch (err: any) {
    return { ...base, outcome: "SEND_FAILED", reason: String(err?.message ?? err), content: null };
  }
}

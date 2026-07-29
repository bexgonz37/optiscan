import { isActiveLifecycleStatus } from "./identity.ts";
import {
  buildOpportunityThesisIdentity,
  opportunityThesisFingerprint,
  type OpportunityThesisIdentity,
  type OpportunityThesisIdentityInput,
} from "./thesis-identity.ts";
import {
  loadOpportunityCaseOnDb,
  persistOpportunityCaseOnDb,
} from "./store.ts";
import type {
  ContractCandidateObservation,
  ContractUpdate,
  OpportunityCase,
} from "./schema.ts";
import type { LiveDb } from "./live.ts";

export type ThesisOpeningSource = "canonical" | "owner_actionable";

export interface ActiveThesis {
  thesisFingerprint: string;
  opportunityCaseId: string;
  lifecycleStatus: string;
  openingSource: ThesisOpeningSource;
  discordMessageId: string | null;
}

export interface ContractCandidateInput {
  opportunityCaseId: string;
  thesisFingerprint: string;
  opportunityFingerprint: string;
  optionSymbol: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
  strategyKey: string;
  observedAtMs: number;
  bid?: number | null;
  ask?: number | null;
  spreadPct?: number | null;
  delta?: number | null;
  openInterest?: number | null;
  volume?: number | null;
  reason?: string | null;
  originalContractRemainsValid?: boolean | null;
}

function hasTable(db: LiveDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function daysBetween(a: string, b: string): number | null {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round((right - left) / 86_400_000);
}

function contractChangeReason(
  prior: {
    expiration: string;
    strike: number;
    spreadPct?: number | null;
    volume?: number | null;
    openInterest?: number | null;
  },
  input: ContractCandidateInput,
): string {
  const reasons: string[] = [];
  if (
    input.spreadPct != null
    && prior.spreadPct != null
    && input.spreadPct < prior.spreadPct
  ) {
    reasons.push("tighter_spread");
  }
  if (
    input.volume != null
    && prior.volume != null
    && input.volume > prior.volume
  ) {
    reasons.push("higher_volume");
  }
  if (
    input.openInterest != null
    && prior.openInterest != null
    && input.openInterest > prior.openInterest
  ) {
    reasons.push("higher_open_interest");
  }
  if (input.expiration !== prior.expiration) reasons.push("expiration_reselected");
  if (input.strike !== prior.strike) reasons.push("strike_reselected");
  return reasons.length
    ? `preferred_contract_reselected:${reasons.join(",")}`
    : "preferred_contract_reselected";
}

export function opportunityThesisSchemaReady(db: LiveDb): boolean {
  return hasTable(db, "opportunity_thesis_active_index")
    && hasTable(db, "opportunity_contract_candidates")
    && hasTable(db, "opportunity_cases");
}

export function findActiveThesisOnDb(
  db: LiveDb,
  thesisFingerprint: string,
): ActiveThesis | null {
  if (!hasTable(db, "opportunity_thesis_active_index")) return null;
  try {
    const row = db.prepare(
      `SELECT opportunity_case_id, lifecycle_status, opening_source, discord_message_id
       FROM opportunity_thesis_active_index
       WHERE thesis_fingerprint=?`,
    ).get(thesisFingerprint) as {
      opportunity_case_id?: string;
      lifecycle_status?: string;
      opening_source?: ThesisOpeningSource;
      discord_message_id?: string | null;
    } | undefined;
    if (row?.opportunity_case_id && isActiveLifecycleStatus(row.lifecycle_status)) {
      return {
        thesisFingerprint,
        opportunityCaseId: String(row.opportunity_case_id),
        lifecycleStatus: String(row.lifecycle_status),
        openingSource: row.opening_source === "owner_actionable" ? "owner_actionable" : "canonical",
        discordMessageId: row.discord_message_id == null ? null : String(row.discord_message_id),
      };
    }
  } catch {
    return null;
  }

  try {
    const recovered = db.prepare(
      `SELECT opportunity_id, lifecycle_status, opening_source, discord_message_id,
              underlying_symbol, direction, session_date,
              COALESCE(opening_delivered_at_ms, created_at_ms) opened_at_ms
       FROM opportunity_cases
       WHERE thesis_fingerprint=?
         AND lifecycle_status IN ('CREATED','CONFIRMED','RUNNING','EXTENDED')
         AND discord_message_id IS NOT NULL
         AND discord_message_id<>''
       ORDER BY COALESCE(opening_delivered_at_ms, created_at_ms) ASC
       LIMIT 1`,
    ).get(thesisFingerprint) as any;
    if (!recovered?.opportunity_id) return null;
    const openingSource: ThesisOpeningSource = recovered.opening_source === "owner_actionable"
      ? "owner_actionable"
      : "canonical";
    db.prepare(
      `INSERT OR IGNORE INTO opportunity_thesis_active_index
        (thesis_fingerprint, opportunity_case_id, symbol, direction, option_type, session_date,
         lifecycle_status, opening_source, discord_message_id, opened_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      thesisFingerprint,
      recovered.opportunity_id,
      recovered.underlying_symbol,
      String(recovered.direction).toUpperCase(),
      String(recovered.direction).toLowerCase() === "bearish" ? "PUT" : "CALL",
      recovered.session_date,
      recovered.lifecycle_status,
      openingSource,
      recovered.discord_message_id,
      recovered.opened_at_ms,
      Date.now(),
    );
    return {
      thesisFingerprint,
      opportunityCaseId: String(recovered.opportunity_id),
      lifecycleStatus: String(recovered.lifecycle_status),
      openingSource,
      discordMessageId: String(recovered.discord_message_id),
    };
  } catch {
    return null;
  }
}

export function claimThesisIndexOnDb(
  db: LiveDb,
  input: OpportunityThesisIdentityInput & {
    opportunityCaseId: string;
    openingSource: ThesisOpeningSource;
  },
): {
  claimed: boolean;
  identity: OpportunityThesisIdentity;
  thesisFingerprint: string;
  active: ActiveThesis | null;
  reason: string;
} {
  const identity = buildOpportunityThesisIdentity(input);
  const thesisFingerprint = opportunityThesisFingerprint(identity);
  const active = findActiveThesisOnDb(db, thesisFingerprint);
  if (active) {
    return { claimed: false, identity, thesisFingerprint, active, reason: "MATCHING_ACTIVE_THESIS" };
  }
  if (!opportunityThesisSchemaReady(db)) {
    return { claimed: false, identity, thesisFingerprint, active: null, reason: "THESIS_SCHEMA_UNAVAILABLE" };
  }
  try {
    const result = db.prepare(
      `INSERT INTO opportunity_thesis_active_index
        (thesis_fingerprint, opportunity_case_id, symbol, direction, option_type, session_date,
         lifecycle_status, opening_source, opened_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      thesisFingerprint,
      input.opportunityCaseId,
      identity.symbol,
      identity.direction,
      identity.optionType,
      identity.sessionDate,
      "CREATED",
      input.openingSource,
      input.nowMs,
      input.nowMs,
    );
    if (Number(result.changes ?? 0) <= 0) {
      const again = findActiveThesisOnDb(db, thesisFingerprint);
      return { claimed: false, identity, thesisFingerprint, active: again, reason: "MATCHING_ACTIVE_THESIS" };
    }
    return { claimed: true, identity, thesisFingerprint, active: null, reason: "thesis_created" };
  } catch {
    const again = findActiveThesisOnDb(db, thesisFingerprint);
    return {
      claimed: false,
      identity,
      thesisFingerprint,
      active: again,
      reason: again ? "MATCHING_ACTIVE_THESIS" : "THESIS_CLAIM_WRITE_FAILED",
    };
  }
}

export function releaseThesisClaimOnDb(
  db: LiveDb,
  opportunityCaseId: string,
): void {
  if (!hasTable(db, "opportunity_thesis_active_index")) return;
  db.prepare(
    "DELETE FROM opportunity_thesis_active_index WHERE opportunity_case_id=?",
  ).run(opportunityCaseId);
}

export function syncThesisLifecycleOnDb(
  db: LiveDb,
  opportunityCaseId: string,
  lifecycleStatus: string,
  nowMs: number,
): void {
  if (!hasTable(db, "opportunity_thesis_active_index")) return;
  if (!isActiveLifecycleStatus(lifecycleStatus)) {
    releaseThesisClaimOnDb(db, opportunityCaseId);
    return;
  }
  db.prepare(
    `UPDATE opportunity_thesis_active_index
     SET lifecycle_status=?, updated_at_ms=?
     WHERE opportunity_case_id=?`,
  ).run(lifecycleStatus, nowMs, opportunityCaseId);
}

export function markThesisOpeningDiscordOnDb(
  db: LiveDb,
  input: {
    opportunityCaseId: string;
    thesisFingerprint: string;
    openingSource: ThesisOpeningSource;
    discordMessageId: string | null;
    nowMs: number;
  },
): void {
  db.prepare(
    `UPDATE opportunity_thesis_active_index
     SET opening_source=?, discord_message_id=?, updated_at_ms=?
     WHERE thesis_fingerprint=? AND opportunity_case_id=?`,
  ).run(
    input.openingSource,
    input.discordMessageId,
    input.nowMs,
    input.thesisFingerprint,
    input.opportunityCaseId,
  );
  try {
    db.prepare(
      `UPDATE opportunity_cases
       SET thesis_fingerprint=?, opening_source=?, discord_message_id=?,
           opening_delivered_at_ms=COALESCE(opening_delivered_at_ms, ?), updated_at_ms=?
       WHERE opportunity_id=?`,
    ).run(
      input.thesisFingerprint,
      input.openingSource,
      input.discordMessageId,
      input.nowMs,
      input.nowMs,
      input.opportunityCaseId,
    );
  } catch {
    // Column migration may lag on a first boot; the active index remains authoritative.
  }
}

export function recordContractCandidateOnDb(
  db: LiveDb,
  input: ContractCandidateInput,
): { recorded: boolean; contractChanged: boolean } {
  if (!hasTable(db, "opportunity_contract_candidates")) {
    return { recorded: false, contractChanged: false };
  }
  let opportunityCase: OpportunityCase | null = null;
  try {
    opportunityCase = loadOpportunityCaseOnDb(db as any, input.opportunityCaseId);
  } catch {
    opportunityCase = null;
  }
  const prior = opportunityCase?.contractCandidates?.at(-1)
    ?? (opportunityCase?.selectedContract
      ? {
          optionSymbol: opportunityCase.selectedContract.optionSymbol,
          strike: opportunityCase.selectedContract.strike,
          expiration: opportunityCase.selectedContract.expiration,
          spreadPct: opportunityCase.selectedContract.spreadPct,
          delta: opportunityCase.selectedContract.delta,
          openInterest: opportunityCase.selectedContract.openInterest,
          volume: opportunityCase.selectedContract.volume,
        }
      : null);
  const contractChanged = Boolean(prior?.optionSymbol && prior.optionSymbol !== input.optionSymbol);
  const requestedReason = input.reason?.trim();
  const reason = contractChanged && prior
    ? (
        !requestedReason || requestedReason === "preferred_contract_reselected"
          ? contractChangeReason(prior, input)
          : requestedReason
      )
    : requestedReason || (prior ? "repeat_contract_observation" : "initial_contract");
  const expirationDifferenceDays = prior
    ? daysBetween(prior.expiration, input.expiration)
    : null;
  const strikeDifference = prior ? input.strike - prior.strike : null;

  let recorded = false;
  try {
    const result = db.prepare(
      `INSERT OR IGNORE INTO opportunity_contract_candidates
        (thesis_fingerprint, opportunity_case_id, opportunity_fingerprint, option_symbol,
         previous_option_symbol, side, strike, expiration, strategy_key, observed_at_ms,
         bid, ask, spread_pct, delta, open_interest, volume, reason,
         expiration_difference_days, strike_difference, previous_liquidity_json,
         new_liquidity_json, previous_spread_pct, previous_delta,
         original_contract_remains_valid, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.thesisFingerprint,
      input.opportunityCaseId,
      input.opportunityFingerprint,
      input.optionSymbol,
      prior?.optionSymbol ?? null,
      input.side,
      input.strike,
      input.expiration,
      input.strategyKey,
      input.observedAtMs,
      input.bid ?? null,
      input.ask ?? null,
      input.spreadPct ?? null,
      input.delta ?? null,
      input.openInterest ?? null,
      input.volume ?? null,
      reason,
      expirationDifferenceDays,
      strikeDifference,
      JSON.stringify({
        volume: prior?.volume ?? null,
        openInterest: prior?.openInterest ?? null,
      }),
      JSON.stringify({
        volume: input.volume ?? null,
        openInterest: input.openInterest ?? null,
      }),
      prior?.spreadPct ?? null,
      prior?.delta ?? null,
      input.originalContractRemainsValid == null
        ? null
        : input.originalContractRemainsValid
          ? 1
          : 0,
      input.observedAtMs,
    );
    recorded = Number(result.changes ?? 0) > 0;
  } catch {
    return { recorded: false, contractChanged };
  }

  if (recorded && opportunityCase) {
    const candidate: ContractCandidateObservation = {
      opportunityFingerprint: input.opportunityFingerprint,
      optionSymbol: input.optionSymbol,
      side: input.side,
      strike: input.strike,
      expiration: input.expiration,
      strategyKey: input.strategyKey,
      observedAtMs: input.observedAtMs,
      bid: input.bid ?? null,
      ask: input.ask ?? null,
      spreadPct: input.spreadPct ?? null,
      delta: input.delta ?? null,
      openInterest: input.openInterest ?? null,
      volume: input.volume ?? null,
      reason,
    };
    opportunityCase.contractCandidates = [...(opportunityCase.contractCandidates ?? []), candidate];
    if (contractChanged && prior) {
      const update: ContractUpdate = {
        previousOptionSymbol: prior.optionSymbol,
        newOptionSymbol: input.optionSymbol,
        reason,
        changedAtMs: input.observedAtMs,
        expirationDifferenceDays,
        strikeDifference,
        previousLiquidity: {
          volume: prior.volume ?? null,
          openInterest: prior.openInterest ?? null,
        },
        newLiquidity: {
          volume: input.volume ?? null,
          openInterest: input.openInterest ?? null,
        },
        previousSpreadPct: prior.spreadPct ?? null,
        newSpreadPct: input.spreadPct ?? null,
        previousDelta: prior.delta ?? null,
        newDelta: input.delta ?? null,
        originalContractRemainsValid: input.originalContractRemainsValid ?? null,
      };
      opportunityCase.contractUpdates = [...(opportunityCase.contractUpdates ?? []), update];
    }
    opportunityCase.updatedAtMs = input.observedAtMs;
    persistOpportunityCaseOnDb(db as any, opportunityCase);
  }
  return { recorded, contractChanged };
}

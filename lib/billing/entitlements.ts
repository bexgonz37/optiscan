/**
 * Billing + entitlements — INACTIVE until provider credentials configured.
 * Fail closed on unknown entitlement state.
 */
export type BillingStatus =
  | "inactive"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "paused"
  | "expired";

export type EntitlementFeature =
  | "real_time_alerts"
  | "zero_dte"
  | "longer_dated"
  | "full_dossier"
  | "probability_detail"
  | "replay_access"
  | "morning_brief"
  | "eod_review"
  | "api_access"
  | "alert_history";

export interface PlanDefinition {
  planId: string;
  label: string;
  entitlements: EntitlementFeature[];
}

export interface EntitlementCheckResult {
  allowed: boolean;
  reason: string;
  billingStatus: BillingStatus;
  planId: string | null;
  feature: EntitlementFeature;
}

const DEFAULT_PLANS: PlanDefinition[] = [
  { planId: "free", label: "Free", entitlements: ["alert_history"] },
  { planId: "standard", label: "Standard", entitlements: ["real_time_alerts", "zero_dte", "alert_history"] },
  { planId: "premium", label: "Premium", entitlements: ["real_time_alerts", "zero_dte", "longer_dated", "full_dossier", "probability_detail", "replay_access", "morning_brief", "eod_review", "api_access", "alert_history"] },
];

export function billingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BILLING_ENABLED === "1" && Boolean(String(env.STRIPE_SECRET_KEY ?? "").trim());
}

export function checkEntitlement(
  feature: EntitlementFeature,
  opts: { planId?: string | null; billingStatus?: BillingStatus; env?: NodeJS.ProcessEnv } = {},
): EntitlementCheckResult {
  const env = opts.env ?? process.env;
  const billingStatus = opts.billingStatus ?? "inactive";

  if (!billingEnabled(env)) {
    return {
      allowed: true,
      reason: "Billing INACTIVE — operator token gate only; all features allowed for owner",
      billingStatus: "inactive",
      planId: null,
      feature,
    };
  }

  if (billingStatus !== "active" && billingStatus !== "trialing") {
    return {
      allowed: false,
      reason: `Subscription ${billingStatus} — entitlement denied`,
      billingStatus,
      planId: opts.planId ?? null,
      feature,
    };
  }

  const plan = DEFAULT_PLANS.find((p) => p.planId === opts.planId) ?? DEFAULT_PLANS[0];
  const allowed = plan.entitlements.includes(feature);
  return {
    allowed,
    reason: allowed ? "Entitled" : `Plan ${plan.planId} does not include ${feature}`,
    billingStatus,
    planId: plan.planId,
    feature,
  };
}

export function listPlans(): PlanDefinition[] {
  return DEFAULT_PLANS;
}

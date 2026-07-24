/**
 * Data licensing and redistribution controls — explicit BLOCKED when rights unknown.
 */
export type LicensingStatus = "UNKNOWN" | "ALLOWED" | "DISALLOWED" | "INTERNAL_ONLY";

export interface DatasetLicense {
  providerId: string;
  dataset: string;
  internalUse: LicensingStatus;
  displayRights: LicensingStatus;
  redistributionRights: LicensingStatus;
  realTimeRights: LicensingStatus;
  alertingRights: LicensingStatus;
  attributionRequired: boolean;
  notes: string;
}

export const DATASET_LICENSES: DatasetLicense[] = [
  {
    providerId: "polygon",
    dataset: "stock_quotes",
    internalUse: "ALLOWED",
    displayRights: "UNKNOWN",
    redistributionRights: "UNKNOWN",
    realTimeRights: "UNKNOWN",
    alertingRights: "UNKNOWN",
    attributionRequired: true,
    notes: "Commercial redistribution requires vendor confirmation — see PHASE_F_FORWARD_VALIDATION.md",
  },
  {
    providerId: "polygon",
    dataset: "options_chain",
    internalUse: "ALLOWED",
    displayRights: "UNKNOWN",
    redistributionRights: "DISALLOWED",
    realTimeRights: "UNKNOWN",
    alertingRights: "UNKNOWN",
    attributionRequired: true,
    notes: "Subscriber-facing Discord alerts use derived summaries only; full chain redistribution BLOCKED pending legal review",
  },
];

export function canRedistributeToSubscribers(providerId: string, dataset: string): { allowed: boolean; reason: string } {
  const lic = DATASET_LICENSES.find((l) => l.providerId === providerId && l.dataset === dataset);
  if (!lic) return { allowed: false, reason: "No licensing record — fail closed" };
  if (lic.redistributionRights === "ALLOWED") return { allowed: true, reason: "Redistribution allowed" };
  if (lic.redistributionRights === "UNKNOWN") return { allowed: false, reason: "Redistribution rights UNKNOWN — feature BLOCKED until human/legal confirmation" };
  return { allowed: false, reason: `Redistribution ${lic.redistributionRights} for ${providerId}/${dataset}` };
}

export function isFeatureBlockedByLicensing(feature: string): boolean {
  if (feature === "subscriber_real_time_chain") {
    const r = canRedistributeToSubscribers("polygon", "options_chain");
    return !r.allowed;
  }
  return false;
}

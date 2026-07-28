export type AlertDossierBadge =
  | "VERIFIED DISCORD ALERT"
  | "OWNER ONLY"
  | "PAPER ONLY"
  | "RESEARCH ONLY"
  | "SHADOW"
  | "AUDIT ONLY"
  | "DELIVERY UNPROVEN";

export interface AlertDossierProofItem {
  label: string;
  status: "PASS" | "FAIL" | "MISSING";
  pass: boolean | null;
}

export interface AlertDossierClassificationInput {
  proof: AlertDossierProofItem[];
  paperTradeCount?: number;
  hasOwnerOnly?: boolean;
  researchOnly?: boolean;
  shadow?: boolean;
  auditOnly?: boolean;
}

export function classifyAlertDossier(input: AlertDossierClassificationInput) {
  const verifiedDelivered = input.proof.length > 0 && input.proof.every((p) => p.pass === true);
  const badge: AlertDossierBadge = verifiedDelivered ? "VERIFIED DISCORD ALERT"
    : input.hasOwnerOnly ? "OWNER ONLY"
    : Number(input.paperTradeCount ?? 0) > 0 ? "PAPER ONLY"
    : input.researchOnly ? "RESEARCH ONLY"
    : input.shadow ? "SHADOW"
    : input.auditOnly ? "AUDIT ONLY"
    : "DELIVERY UNPROVEN";

  return {
    badge,
    verifiedDelivered,
    finalStatus: verifiedDelivered ? "VERIFIED DELIVERED" : "NOT VERIFIED DELIVERED",
    lane: verifiedDelivered ? "delivered" : badge.toLowerCase().replace(/\s+/g, "_"),
    missing: input.proof.filter((p) => p.status === "MISSING").map((p) => p.label),
    failed: input.proof.filter((p) => p.status === "FAIL").map((p) => p.label),
  };
}

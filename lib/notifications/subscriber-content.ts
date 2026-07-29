export type DiscordAudience = "subscriber" | "owner_admin" | "unknown";

export function internalLinksAllowed(input: {
  audience?: DiscordAudience;
  includeInternalLink?: boolean;
} = {}): boolean {
  return input.audience === "owner_admin" && input.includeInternalLink === true;
}

const INTERNAL_REFERENCE =
  /(?:https?:\/\/\S*(?:railway\.app|\/(?:intelligence|alerts|pipeline-health|ai)(?:\/|\?|$))|(?:^|\s)\/(?:intelligence|alerts|pipeline-health|ai)(?:\/|\?|$)|\bopportunity\s*case\s*(?:id)?\s*[:#]|\balert\s*id\s*[:#]|\boc_[a-z0-9_-]+\b)/i;

export function stripInternalSubscriberReferences(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !INTERNAL_REFERENCE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function sanitizeDiscordPayloadForAudience(
  payload: Record<string, unknown>,
  input: { audience?: DiscordAudience; includeInternalLink?: boolean } = {},
): Record<string, unknown> {
  if (internalLinksAllowed(input)) return payload;
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return stripInternalSubscriberReferences(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, visit(item)]));
    }
    return value;
  };
  return visit(payload) as Record<string, unknown>;
}

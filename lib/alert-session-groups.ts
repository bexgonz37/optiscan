/** Group alerts by session for dividers in history / command center. */
export function alertSessionKey(alert: { asset_class?: string | null; session?: string | null }): string {
  if (alert.asset_class === "stock") return alert.session ?? "extended";
  return "regular";
}

export const SESSION_GROUP_ORDER = ["premarket", "regular", "afterhours", "extended"] as const;

export function groupAlertsBySession<T extends { asset_class?: string | null; session?: string | null }>(
  alerts: T[],
): { key: string; items: T[] }[] {
  const buckets = new Map<string, T[]>();
  for (const a of alerts) {
    const key = alertSessionKey(a);
    const list = buckets.get(key) ?? [];
    list.push(a);
    buckets.set(key, list);
  }
  const out: { key: string; items: T[] }[] = [];
  for (const key of SESSION_GROUP_ORDER) {
    const items = buckets.get(key);
    if (items?.length) out.push({ key, items });
  }
  for (const [key, items] of buckets) {
    if (!SESSION_GROUP_ORDER.includes(key as any)) out.push({ key, items });
  }
  return out;
}

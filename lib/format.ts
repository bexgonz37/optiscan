import type { Grade } from "@/lib/types";

export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

export function fmtPremium(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

export function fmtPct(n: number | null | undefined, withSign = true): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = withSign && n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function fmtRatio(n: number | null | undefined, newPositioning = false): string {
  if (newPositioning) return "NEW";
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}x`;
}

export function fmtExpiry(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtIv(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const pct = n <= 5 ? n * 100 : n;
  return `${Math.round(pct)}%`;
}

export const MARKET_TZ = "America/New_York";

/** Parse alert ISO timestamp to epoch ms, or null when invalid. */
export function alertTimeMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** US market clock — always labeled ET so CA/ET never get mixed up. */
export function fmtMarketTime(iso: string | null | undefined, opts?: { seconds?: boolean }): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const base = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: opts?.seconds ? "2-digit" : undefined,
    timeZone: MARKET_TZ,
  });
  return `${base} ET`;
}

export function isAlertFresh(iso: string | null | undefined, maxAgeMs: number, nowMs = Date.now()): boolean {
  const t = alertTimeMs(iso);
  if (t == null) return false;
  return nowMs - t <= maxAgeMs;
}

/** Human freshness for callouts: "3m ago · 12:08 PM ET" */
export function fmtMarketFreshness(iso: string | null | undefined, nowMs = Date.now()): string | null {
  const t = alertTimeMs(iso);
  if (t == null) return null;
  const ageMin = Math.max(0, Math.round((nowMs - t) / 60_000));
  const ago = ageMin < 1 ? "just now" : `${ageMin}m ago`;
  return `${ago} · ${fmtMarketTime(iso)}`;
}

export function fmtTime(iso: string | null | undefined): string {
  return fmtMarketTime(iso, { seconds: true });
}

export function gradeClasses(grade: Grade | string): string {
  switch (grade) {
    case "STRONG":
      return "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40";
    case "GOOD":
      return "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/40";
    case "WATCH":
      return "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/40";
    default:
      return "bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-600/40";
  }
}

export function sideClasses(side: string | null | undefined): string {
  if (side === "call") return "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40";
  if (side === "put") return "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/40";
  return "bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-600/40";
}

export function changeColor(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "text-zinc-400";
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-rose-400";
  return "text-zinc-400";
}

/** CSS class for signed percent cells (design-system pos/neg/muted). */
export function pctClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "muted";
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "muted";
}

export function isMarketHours(now = new Date()): boolean {
  // US regular session, roughly, in America/New_York.
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/**
 * Presentational mappers for the Command Center terminal UI.
 * No trading math — maps existing snapshot fields to trader-facing labels/tones.
 */

export type ChipState =
  | "LIVE"
  | "HEALTHY"
  | "CONNECTED"
  | "IDLE"
  | "DEGRADED"
  | "OFFLINE"
  | "DEMO"
  | "REVIEW"
  | "SEEDED"
  | "NOT TESTED";
export type ChipTone = "ok" | "warn" | "bad" | "info" | "muted";
export type OppStatus = "WATCHING" | "SENT" | "CONFIRMED" | "T1_HIT" | "WEAKENING" | "CLOSED";

export interface SystemChip {
  key: string;
  label: string;
  state: ChipState;
  tone: ChipTone;
}

export function mapSystemChips(input: {
  authFailed: boolean;
  independent: Record<string, unknown> | null | undefined;
  graderRunning?: boolean | null;
  graderLastCycleAgeMs?: number | null;
  commitShort?: string | null;
  refreshedIso?: string | null;
  /** When true, never show OFFLINE for local-dev absence — use IDLE/DEMO labels instead. */
  uiReview?: boolean;
}): SystemChip[] {
  if (input.authFailed) {
    return [
      { key: "system", label: "OPTISCAN", state: "OFFLINE", tone: "bad" },
      { key: "auth", label: "Auth", state: "OFFLINE", tone: "bad" },
    ];
  }
  const review = Boolean(input.uiReview);
  if (review) {
    return [
      { key: "system", label: "SYSTEM", state: "DEMO", tone: "info" },
      { key: "session", label: "SESSION", state: "REVIEW", tone: "info" },
      { key: "monitor", label: "MONITOR", state: "DEMO", tone: "info" },
      { key: "provider", label: "PROVIDER", state: "SEEDED", tone: "info" },
      { key: "discord", label: "DISCORD", state: "NOT TESTED", tone: "info" },
      { key: "grader", label: "GRADER", state: "DEMO", tone: "info" },
    ];
  }
  const ind = input.independent ?? {};
  const runMode = String(ind.runMode ?? "");
  const alive =
    Boolean(ind.monitorAlive) ||
    Boolean(ind.localAlive) ||
    runMode === "RUNNING_IN_WORKER" ||
    runMode === "RUNNING_IN_THIS_PROCESS";
  const session = String(ind.session ?? "").toUpperCase();
  const sessionLive = /REGULAR|OPEN|SESSION/i.test(session) && !/CLOSED|UNKNOWN/i.test(session);
  const polyOk = Boolean(ind.polygonConfigured);
  const polyHealthy = ind.polygonHealthy == null ? polyOk : Boolean(ind.polygonHealthy);
  const webhook = ind.webhookConfigured !== false;
  const kill = Boolean(ind.killSwitch);

  let graderState: ChipState = "HEALTHY";
  let graderTone: ChipTone = "ok";
  if (input.graderRunning === false) {
    graderState = review ? "IDLE" : "OFFLINE";
    graderTone = review ? "info" : "bad";
  } else if (input.graderLastCycleAgeMs != null && input.graderLastCycleAgeMs > 30 * 60_000) {
    graderState = "DEGRADED";
    graderTone = "warn";
  } else if (input.graderRunning == null && input.graderLastCycleAgeMs == null) {
    graderState = "IDLE";
    graderTone = "info";
  }

  const monitorOffline = !alive && ind.discoveryEnabled !== false;
  const optiscanState: ChipState =
    alive && !kill ? "LIVE" : kill ? "DEGRADED" : review ? "IDLE" : "OFFLINE";
  const optiscanTone: ChipTone = alive && !kill ? "ok" : kill ? "warn" : review ? "info" : "bad";

  const chips: SystemChip[] = [
    {
      key: "live",
      label: "OPTISCAN",
      state: review && !alive ? "IDLE" : optiscanState,
      tone: review && !alive ? "info" : optiscanTone,
    },
    {
      key: "session",
      label: "Session",
      state: sessionLive ? "LIVE" : session.includes("CLOSED") ? "IDLE" : session ? "CONNECTED" : "IDLE",
      tone: sessionLive ? "ok" : "info",
    },
    {
      key: "monitor",
      label: "Monitor",
      state: alive ? "HEALTHY" : ind.discoveryEnabled === false ? "IDLE" : review ? "IDLE" : "OFFLINE",
      tone: alive ? "ok" : review || ind.discoveryEnabled === false ? "info" : "bad",
    },
    {
      key: "polygon",
      label: "Polygon",
      state: polyOk && polyHealthy ? "CONNECTED" : polyOk ? "DEGRADED" : "OFFLINE",
      tone: polyOk && polyHealthy ? "ok" : polyOk ? "warn" : "bad",
    },
    {
      key: "discord",
      label: "Discord",
      state: webhook ? "CONNECTED" : "OFFLINE",
      tone: webhook ? "ok" : "bad",
    },
    {
      key: "grader",
      label: "Grader",
      state: graderState,
      tone: graderTone,
    },
  ];
  return chips;
}

export function mapOppStatus(row: {
  paperStatus?: string | null;
  t1Hit?: boolean;
  stopHit?: boolean;
  latestMarkReturnPct?: number | null;
  graderHealth?: string | null;
  discordMessageId?: string | null;
}): OppStatus {
  const st = String(row.paperStatus ?? "").toUpperCase();
  if (st === "EXITED") return "CLOSED";
  if (row.t1Hit && st === "ENTERED") return "T1_HIT";
  if (row.stopHit || (row.latestMarkReturnPct != null && row.latestMarkReturnPct <= -8)) return "WEAKENING";
  if (st === "ENTERED" && row.latestMarkReturnPct != null) return "CONFIRMED";
  if (row.discordMessageId || st === "ENTERED") return "SENT";
  return "WATCHING";
}

export function oppStatusTone(status: OppStatus): ChipTone {
  switch (status) {
    case "T1_HIT":
    case "CONFIRMED":
      return "ok";
    case "WEAKENING":
      return "warn";
    case "CLOSED":
      return "muted";
    case "SENT":
      return "info";
    default:
      return "muted";
  }
}

export function formatOppStatus(status: OppStatus): string {
  return status.replace("_", " ");
}

/** Aggregate paper sample stats from existing rows (read-only). */
export function aggregatePaperSample(rows: Array<Record<string, unknown>>): {
  bestMfePct: number | null;
  worstMaePct: number | null;
  t1HitRate: number | null;
  stopHitRate: number | null;
  unrealizedAvgPct: number | null;
  realizedAvgPct: number | null;
  openCount: number;
  closedCount: number;
  gradedForRates: number;
} {
  const open = rows.filter((r) => String(r.paperStatus ?? "") === "ENTERED");
  const closed = rows.filter((r) => String(r.paperStatus ?? "") === "EXITED");
  const mfes = rows.map((r) => Number(r.mfePct)).filter((n) => Number.isFinite(n));
  const maes = rows.map((r) => Number(r.maePct)).filter((n) => Number.isFinite(n));
  const withHits = rows.filter((r) => r.paperStatus != null);
  const t1n = withHits.filter((r) => Boolean(r.t1Hit)).length;
  const stopn = withHits.filter((r) => Boolean(r.stopHit)).length;
  const unreal = open.map((r) => Number(r.latestMarkReturnPct)).filter((n) => Number.isFinite(n));
  const real = closed.map((r) => Number(r.returnPct)).filter((n) => Number.isFinite(n));
  const avg = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4) : null);
  return {
    bestMfePct: mfes.length ? +Math.max(...mfes).toFixed(4) : null,
    worstMaePct: maes.length ? +Math.min(...maes).toFixed(4) : null,
    t1HitRate: withHits.length ? +(t1n / withHits.length).toFixed(4) : null,
    stopHitRate: withHits.length ? +(stopn / withHits.length).toFixed(4) : null,
    unrealizedAvgPct: avg(unreal),
    realizedAvgPct: avg(real),
    openCount: open.length,
    closedCount: closed.length,
    gradedForRates: withHits.length,
  };
}

/** Readiness progress 0–100 from known gates (presentational). */
export function readinessProgressPct(metrics: Record<string, unknown> | null | undefined, ready?: boolean): number {
  if (ready) return 100;
  const m = metrics ?? {};
  let score = 0;
  const steps: Array<boolean> = [
    Number(m.deliveredSent ?? 0) >= 1,
    Number(m.deliveredLinked ?? 0) >= 1,
    Number(m.gradedSample ?? 0) >= 1,
    Number(m.paperLinkRate ?? 0) >= 0.9,
    Number(m.profitFactor ?? 0) > 1 || Number(m.winRate ?? 0) > 0.5,
    Boolean(m.stripeReady),
    Boolean(m.discordRoleReady),
  ];
  for (const ok of steps) if (ok) score += 1;
  return Math.round((score / steps.length) * 100);
}

export function sampleSizeLabel(n: number | null | undefined, noun = "graded trades"): string | null {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const v = Number(n);
  if (v <= 0) return null;
  return `Based on ${v} ${noun}`;
}

export function isSmallSample(n: number | null | undefined, min = 10): boolean {
  return n == null || !Number.isFinite(Number(n)) || Number(n) < min;
}

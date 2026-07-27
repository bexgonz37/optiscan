/**
 * Owner-facing Command Center health + launch-sample paper summary builders.
 * Pure helpers so homepage never invents status from missing/unauthorized payloads.
 */
export type Tone = "ok" | "warn" | "bad" | "info";

export interface HealthLine {
  text: string;
  tone: Tone;
  source?: string;
}

export function overviewAuthFailed(ov: Record<string, unknown> | null | undefined): boolean {
  if (!ov) return true;
  if (typeof ov.error === "string" && /unauthor|token|forbidden/i.test(ov.error)) return true;
  if (ov.status === 401 || ov.code === 401) return true;
  // Canonical command-center snapshot uses `independent`, not overview's `independent_options`.
  if (ov.sourceEndpoint === "/api/command-center" || ov.independent != null) {
    return false;
  }
  if (ov.ok === false) return true;
  // Token-gated overview without independent_options almost always means auth failure or old schema.
  if (ov.independent_options == null && ov.provider == null && ov.scanner == null) return true;
  return false;
}

export function primaryWorkingNowLines(input: {
  independent: Record<string, unknown> | null | undefined;
  authFailed: boolean;
  discordFail: number;
  graderRunning?: boolean | null;
  graderLastCycleAgeMs?: number | null;
  contentEnabled?: boolean | null;
  contentWebhook?: boolean | null;
  latestAlertLabel?: string | null;
}): HealthLine[] {
  if (input.authFailed) {
    return [{ text: "Command Center could not load system overview (check scan token)", tone: "bad", source: "Local process" }];
  }
  const ind = input.independent ?? {};
  const lines: HealthLine[] = [];
  const runMode = String(ind.runMode ?? "");
  const alive = Boolean(ind.monitorAlive) || runMode === "RUNNING_IN_WORKER" || runMode === "RUNNING_IN_THIS_PROCESS";
  if (alive) {
    lines.push({
      text: String(ind.labels && (ind.labels as any).monitor
        ? (ind.labels as any).monitor
        : "Independent options monitor is running"),
      tone: "ok",
      source: String((ind.sources as any)?.monitor ?? "Database heartbeat"),
    });
  } else if (ind.discoveryEnabled === false) {
    lines.push({ text: "Independent options discovery is disabled", tone: "info", source: "Environment configuration" });
  } else {
    lines.push({ text: "Independent options monitor heartbeat is stale or unknown", tone: "warn", source: "Database heartbeat" });
  }

  const session = String(ind.session ?? "unknown");
  lines.push({
    text: session === "unknown" ? "Current market session: unknown" : `Current market session: ${session}`,
    tone: session === "unknown" ? "info" : "ok",
    source: String((ind.sources as any)?.session ?? "Session guard"),
  });

  const polyOk = Boolean(ind.polygonConfigured);
  lines.push({
    text: polyOk
      ? String((ind.labels as any)?.polygon ?? "Polygon/Massive provider configured and healthy")
      : "Polygon/Massive provider unavailable or key missing",
    tone: polyOk ? "ok" : "bad",
    source: String((ind.sources as any)?.polygon ?? "Environment configuration"),
  });

  if (ind.webhookConfigured === false) {
    lines.push({ text: "Options Discord webhook is not configured", tone: "bad", source: "Environment configuration" });
  } else if (input.discordFail > 0) {
    lines.push({ text: "Options Discord deliveries need review", tone: "warn", source: "Database heartbeat" });
  } else {
    lines.push({ text: "Options Discord delivery health: OK", tone: "ok", source: "Environment configuration" });
  }

  lines.push({
    text: input.latestAlertLabel ? `Latest options alert: ${input.latestAlertLabel}` : "Latest options alert: none in view",
    tone: "ok",
    source: "Database heartbeat",
  });

  if (input.graderRunning === false) {
    lines.push({ text: "Paper grader is stopped", tone: "warn", source: "Local process" });
  } else if (input.graderLastCycleAgeMs != null && input.graderLastCycleAgeMs > 30 * 60_000) {
    lines.push({ text: "Paper grader heartbeat is stale", tone: "warn", source: "Database heartbeat" });
  } else {
    lines.push({ text: "Paper grader health: OK", tone: "ok", source: "Database heartbeat" });
  }

  if (input.contentEnabled) {
    lines.push({
      text: input.contentWebhook === false
        ? "Content engine enabled but webhook missing"
        : "Content engine health: enabled",
      tone: input.contentWebhook === false ? "warn" : "ok",
      source: "Environment configuration",
    });
  } else {
    lines.push({ text: "Content engine: off / idle", tone: "info", source: "Environment configuration" });
  }

  return lines;
}

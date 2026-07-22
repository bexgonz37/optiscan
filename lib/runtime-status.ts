/**
 * runtime-status.ts — read-only aggregate of the live runtime for the health/
 * status surface (live runtime wiring). Next-server module.
 *
 * Assembles worker/lease ownership, scanner + supervisor cycle telemetry, Discord
 * delivery ledger counts, learning/drift state, model readiness (incl. outcomes
 * still needed for experimental/validated activation), and the improvement-agent
 * mode + pending proposals. It reads only aggregates and NEVER exposes secrets or
 * webhook URLs.
 */

function db(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  return getDb();
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export interface RuntimeStatus {
  nowMs: number;
  /** Deployed build identity — confirm the live commit vs origin/main. */
  deploy: { commit: string | null; commitShort: string | null; branch: string | null };
  worker: {
    scanner: { holderPid: number | null; fresh: boolean; hostname: string | null; heartbeatAt: string | null; running: boolean };
    scheduler: { holderPid: number | null; fresh: boolean; hostname: string | null; heartbeatAt: string | null; started: boolean; isOwner: boolean; note: string };
    thisPid: number;
  };
  scanner: { running: boolean; lastTickAt: number | null; ticks: number; triggers: number; alerts: number; errors: number; session: string | null };
  supervisor: Record<string, unknown>;
  callouts: { canonicalTracked: number; byStatus: Record<string, number>; lastEmitAtMs: number | null; canonicalPath: string; discordDeliveryEnabled: boolean };
  paper: {
    autoEntryEnabled: boolean; allowZeroDte: boolean; tradingEnabled: boolean;
    candidates: { total: number; created: number; rejected: number; eligiblePending: number; last24hCreated: number; last24hRejected: number };
    daily: Record<string, unknown>;
    recentRejections: { ticker: string; reason: string; atMs: number }[];
    summary: string;
  };
  discord: { deliveries: Record<string, number> };
  scheduler: Record<string, unknown>;
  learning: { lastCycleNote: string | null; nextEligibleLearningMs: number | null; driftState: string | null; lastDriftAtMs: number | null };
  outcomes: { total: number; graded: number; wins: number; losses: number };
  model: {
    state: string; tier: string; championVersion: number | null;
    moreForValidated: Record<string, number> | null;
    moreForExperimental: Record<string, number> | null;
  };
  improvement: { mode: string; auditEnabled: boolean; pendingProposals: number; blocked: number };
  config: {
    items: {
      key: string;
      state: string;
      meaning: string;
      blocks: ("options_alerts" | "stock_alerts" | "paper_trading")[];
    }[];
    summary: string[];
    readiness: AlertReadiness;
  };
}

function on(v: unknown): boolean {
  return v === "1";
}

function configItem(
  key: string,
  state: string,
  meaning: string,
  blocks: ("options_alerts" | "stock_alerts" | "paper_trading")[] = [],
) {
  return { key, state, meaning, blocks };
}

/**
 * Optional runtime facts that are NOT env vars (DB settings / secrets presence) so
 * the config surface can explain, e.g., why premarket/after-hours stock is silent.
 * Kept as an explicit param so buildConfigVisibility stays pure + unit-testable.
 */
export interface ConfigVisibilityExtras {
  extendedStockNotify?: boolean;   // DB setting extended_stock_notify=1
  stockWebhookConfigured?: boolean; // whether the stocks webhook URL is set (presence only)
  optionsWebhookConfigured?: boolean; // whether the options webhook URL is set (presence only)
  session?: string;                // current market session (regular/pre/post/closed)
}

/** One alert channel's readiness: is it able to send, and if not, exactly why. */
export interface AlertChannelReadiness {
  ready: boolean;
  blockedBy: string[];
}

/** Crisp, at-a-glance answer to "can each alert type actually send right now?" */
export interface AlertReadiness {
  session: string | null;
  optionsCallouts: AlertChannelReadiness;
  stockCallouts: AlertChannelReadiness;
  premarketNotifications: AlertChannelReadiness;
}

export function buildConfigVisibility(env: NodeJS.ProcessEnv = process.env, extras: ConfigVisibilityExtras = {}) {
  const supervisorOn = on(env.SUPERVISOR_RUNTIME);
  const canonicalPath = env.CALLOUT_CANONICAL_PATH === "supervisor" ? "supervisor" : "legacy";
  const supervisorDiscordOn = canonicalPath === "supervisor" && on(env.AGENT_CALLOUT_DISCORD);
  const stockOn = on(env.STOCK_CALLOUTS);
  const stockExtendedHoursOn = on(env.STOCK_EXTENDED_HOURS) || on(env.PAPER_STOCK_EXTENDED_HOURS);
  const independentOptionsOn = on(env.INDEPENDENT_OPTIONS_DISCOVERY_ENABLED);
  const portfolioDeliveryOn = on(env.OPTIONS_PORTFOLIO_DELIVERY_ENABLED);
  const extendedStockNotifyOn = extras.extendedStockNotify === true;
  const stockWebhookOn = extras.stockWebhookConfigured === true;
  const optionsWebhookOn = extras.optionsWebhookConfigured === true;
  const paperTradingOn = env.PAPER_TRADING_ENABLED !== "0";
  const paperAutoOn = on(env.PAPER_AUTO_ENTRY);
  const zeroDteOn = on(env.PAPER_ALLOW_ZERO_DTE);
  const killSwitchOn = on(env.PAPER_KILL_SWITCH);
  const earlyOn = on(env.EARLY_ALERTS_ENABLED);
  const bearishOn = on(env.BEARISH_ACTIONABLE);
  const verifiedPutsOn = env.OPTIONS_PUTS_ENABLED !== "0" && env.OPTIONS_PUT_CALLOUTS !== "0";
  const watchDiscordOn = canonicalPath !== "supervisor" && on(env.DISCORD_WATCH_ALERTS);
  const dbDir = env.ALERT_DB_DIR || "data";
  const stockMinPrice = env.STOCK_MOMENTUM_MIN_PRICE ?? "0.5";
  const stockMaxPrice = env.STOCK_MOMENTUM_MAX_PRICE ?? "50";
  const stockMinVolume = env.STOCK_MOMENTUM_MIN_DAY_VOLUME ?? "500000";
  const stockMinGain = env.STOCK_MOMENTUM_MIN_GAIN_FROM_PREV_CLOSE_PCT ?? "10";
  const challengeMaxPositionPct = env.PAPER_CHALLENGE_MAX_POSITION_PCT ?? "60";
  const challengeMaxExposurePct = env.PAPER_CHALLENGE_MAX_TOTAL_EXPOSURE_PCT ?? env.PAPER_MAX_TOTAL_EXPOSURE_PCT ?? "60";
  const stockDayStartingBalance = env.PAPER_STOCK_DAY_STARTING_BALANCE_USD ?? "10000";

  // Premarket/after-hours stock Discord needs ALL of: STOCK_CALLOUTS=1, an
  // extended-hours env flag, the extended_stock_notify DB setting, and a stock
  // webhook. Surface each gate so the owner never just sees "stale/no data".
  const extendedStockReady = stockOn && stockExtendedHoursOn && extendedStockNotifyOn && stockWebhookOn;

  const items = [
    configItem("SUPERVISOR_RUNTIME", supervisorOn ? "enabled" : "disabled", supervisorOn ? "Supervisor cycle runs automatically." : "Supervisor cycle is off.", supervisorOn ? [] : ["options_alerts", "paper_trading"]),
    configItem("CALLOUT_CANONICAL_PATH", canonicalPath, canonicalPath === "supervisor" ? "Supervisor is the canonical options sender." : "Legacy options path remains canonical.", canonicalPath === "supervisor" ? [] : ["options_alerts"]),
    configItem("AGENT_CALLOUT_DISCORD", on(env.AGENT_CALLOUT_DISCORD) ? "enabled" : "disabled", on(env.AGENT_CALLOUT_DISCORD) ? "Supervisor Discord master switch is on." : "Supervisor Discord master switch is off — options Discord will NOT send under the supervisor path until this is 1.", supervisorDiscordOn ? [] : ["options_alerts"]),
    configItem("DISCORD_WEBHOOK_OPTIONS", optionsWebhookOn ? "configured" : "missing", optionsWebhookOn ? "Options webhook is configured." : "No options webhook configured — options callouts cannot be delivered even when emittable.", optionsWebhookOn ? [] : ["options_alerts"]),
    configItem("INDEPENDENT_OPTIONS_DISCOVERY_ENABLED", independentOptionsOn ? "enabled" : "disabled", independentOptionsOn ? "Independent options discovery is enabled." : "Independent options discovery is disabled.", []),
    configItem("OPTIONS_PORTFOLIO_DELIVERY_ENABLED", portfolioDeliveryOn ? "enabled" : "disabled", portfolioDeliveryOn ? "Portfolio delivery ranking is mandatory and enabled for independent options." : "Portfolio delivery ranking is disabled. If independent options discovery is enabled, subscriber delivery is fail-closed.", independentOptionsOn && !portfolioDeliveryOn ? ["options_alerts"] : []),
    configItem("STOCK_CALLOUTS", stockOn ? "enabled" : "disabled", stockOn ? "Momentum stock callouts may route to the stock webhook." : "Momentum stock Discord is disabled because STOCK_CALLOUTS is off.", stockOn ? [] : ["stock_alerts"]),
    configItem("STOCK_EXTENDED_HOURS", stockExtendedHoursOn ? "enabled" : "disabled", stockExtendedHoursOn ? "Premarket/after-hours stock setups may pass the extended-hours gate (also honors PAPER_STOCK_EXTENDED_HOURS)." : "Premarket/after-hours stock Discord is blocked — set STOCK_EXTENDED_HOURS=1 (or PAPER_STOCK_EXTENDED_HOURS=1) to allow extended sessions. Regular-hours stock is unaffected.", stockOn && !stockExtendedHoursOn ? ["stock_alerts"] : []),
    configItem("extended_stock_notify", extendedStockNotifyOn ? "enabled" : "disabled", extendedStockNotifyOn ? "The extended_stock_notify setting permits premarket/after-hours stock Discord." : "DB setting extended_stock_notify is off — premarket/after-hours stock alerts stay dashboard-only. Enable it in Settings.", stockOn && stockExtendedHoursOn && !extendedStockNotifyOn ? ["stock_alerts"] : []),
    configItem("DISCORD_WEBHOOK_STOCKS", stockWebhookOn ? "configured" : "missing", stockWebhookOn ? "Stock webhook is configured." : "No stock webhook configured — stock callouts cannot be delivered.", stockOn && !stockWebhookOn ? ["stock_alerts"] : []),
    configItem("PAPER_TRADING_ENABLED", paperTradingOn ? "enabled" : "disabled", paperTradingOn ? "Paper trading subsystem is enabled." : "Paper trading subsystem is disabled.", paperTradingOn ? [] : ["paper_trading"]),
    configItem("PAPER_AUTO_ENTRY", paperAutoOn ? "enabled" : "disabled", paperAutoOn ? "Paper auto-entry is enabled." : "Paper auto-entry is disabled.", paperAutoOn ? [] : ["paper_trading"]),
    configItem("PAPER_ALLOW_ZERO_DTE", zeroDteOn ? "enabled" : "disabled", zeroDteOn ? "0DTE paper trading is enabled." : "0DTE paper trading is disabled.", zeroDteOn ? [] : ["paper_trading"]),
    configItem("PAPER_KILL_SWITCH", killSwitchOn ? "enabled" : "disabled", killSwitchOn ? "Paper kill switch is engaged." : "Paper kill switch is off.", killSwitchOn ? ["paper_trading"] : []),
    configItem("DISCORD_WATCH_ALERTS", watchDiscordOn ? "enabled" : "disabled", watchDiscordOn ? "Legacy WATCH heads-up may post to Discord (opt-in, legacy path only)." : "WATCH alerts are dashboard-only (default). They never send under the supervisor path.", []),
    configItem("EARLY_ALERTS_ENABLED", earlyOn ? "enabled" : "disabled", "Early alerts are ignored for normal Discord; ACTIONABLE_NOW is required.", []),
    configItem("BEARISH_ACTIONABLE", bearishOn ? "enabled" : "disabled", bearishOn ? "Bearish actionability is enabled." : "Bearish actionability is off.", bearishOn ? [] : ["options_alerts", "paper_trading"]),
    configItem("OPTIONS_PUTS_ENABLED", verifiedPutsOn ? "enabled" : "disabled", verifiedPutsOn ? "Verified option puts may be actionable in paper when all deterministic option gates pass; bearish stock/short remains gated." : "Verified option put actionability is disabled.", verifiedPutsOn ? [] : ["options_alerts", "paper_trading"]),
    configItem("STOCK_MOMENTUM_POLICY", `${stockMinPrice}-${stockMaxPrice} dollars, >=${stockMinVolume} volume, >=${stockMinGain}% day gain`, "Broad stock discovery only promotes low-priced, high-volume, already-moving names before fast-tape gates run.", []),
    configItem("PAPER_CHALLENGE_RISK", `${challengeMaxPositionPct}% position / ${challengeMaxExposurePct}% exposure`, "Challenge paper portfolio sizing is separate from Primary and the stock day trader portfolio.", []),
    configItem("PAPER_STOCK_DAY_STARTING_BALANCE_USD", stockDayStartingBalance, "Stock day-trader paper fills use their own starting balance and portfolio bucket.", []),
    configItem("ALERT_DB_DIR", dbDir, dbDir === "/app/data" ? "Database is using persistent path /app/data." : `Database path is ${dbDir}. Railway should use /app/data.`, dbDir === "/app/data" ? [] : ["paper_trading"]),
  ];

  const summary = [
    supervisorDiscordOn ? "Options Discord is enabled." : "Options Discord is disabled by Supervisor routing/config (need CALLOUT_CANONICAL_PATH=supervisor AND AGENT_CALLOUT_DISCORD=1).",
    independentOptionsOn && !portfolioDeliveryOn ? "Independent options subscriber delivery is blocked because OPTIONS_PORTFOLIO_DELIVERY_ENABLED is not 1." : "Independent options portfolio-delivery requirement is satisfied or discovery is disabled.",
    stockOn ? "Regular-hours stock Discord is enabled when DISCORD_WEBHOOK_STOCKS is configured and a fresh actionable setup exists." : "Momentum stock Discord is disabled because STOCK_CALLOUTS is off.",
    extendedStockReady
      ? "Premarket/after-hours stock Discord is enabled."
      : stockOn
        ? `Premarket/after-hours stock Discord is blocked: ${[!stockExtendedHoursOn ? "STOCK_EXTENDED_HOURS/PAPER_STOCK_EXTENDED_HOURS off" : null, !extendedStockNotifyOn ? "extended_stock_notify setting off" : null, !stockWebhookOn ? "no stock webhook" : null].filter(Boolean).join(", ") || "ready"}.`
        : "Premarket/after-hours stock Discord is disabled (STOCK_CALLOUTS off).",
    paperAutoOn && paperTradingOn && !killSwitchOn ? "Paper auto-entry is enabled." : "Paper auto-entry is disabled.",
    zeroDteOn ? "0DTE paper trading is enabled." : "0DTE paper trading is disabled.",
    "Early/WATCH states are dashboard-only; Discord carries ACTIONABLE_NOW only.",
    bearishOn ? "Bearish actionability is enabled." : "Bearish actionability is off.",
    verifiedPutsOn ? "Verified option puts are enabled for paper/actionable options only; bearish stock remains gated." : "Verified option puts are disabled.",
    `Stock momentum discovery policy: ${stockMinPrice}-${stockMaxPrice} dollars, >=${stockMinVolume} volume, >=${stockMinGain}% day gain.`,
    `Paper portfolios are separated: Challenge risk ${challengeMaxPositionPct}%/${challengeMaxExposurePct}%, Stock Day balance ${stockDayStartingBalance}.`,
    dbDir === "/app/data" ? "Database is using persistent path /app/data." : `Database path is ${dbDir}; Railway should use /app/data.`,
  ];

  // Crisp, at-a-glance readiness: can each alert type actually send right now, and
  // if not, exactly which gate is blocking it? This is the single place to look when
  // "no alerts are coming through". Deterministic; derived only from the flags above.
  const optionsBlockers: string[] = [];
  if (!supervisorOn) optionsBlockers.push("SUPERVISOR_RUNTIME != 1");
  if (canonicalPath !== "supervisor") optionsBlockers.push("CALLOUT_CANONICAL_PATH != supervisor");
  if (!on(env.AGENT_CALLOUT_DISCORD)) optionsBlockers.push("AGENT_CALLOUT_DISCORD != 1");
  if (!optionsWebhookOn) optionsBlockers.push("DISCORD_WEBHOOK_OPTIONS missing");
  if (independentOptionsOn && !portfolioDeliveryOn) optionsBlockers.push("OPTIONS_PORTFOLIO_DELIVERY_ENABLED != 1 while INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1");

  const stockBlockers: string[] = [];
  if (!stockOn) stockBlockers.push("STOCK_CALLOUTS != 1");
  if (!stockWebhookOn) stockBlockers.push("DISCORD_WEBHOOK_STOCKS missing");

  const premarketBlockers: string[] = [];
  if (!stockOn) premarketBlockers.push("STOCK_CALLOUTS != 1");
  if (!stockExtendedHoursOn) premarketBlockers.push("STOCK_EXTENDED_HOURS (or PAPER_STOCK_EXTENDED_HOURS) != 1");
  if (!extendedStockNotifyOn) premarketBlockers.push("extended_stock_notify setting off (enable in Settings)");
  if (!stockWebhookOn) premarketBlockers.push("DISCORD_WEBHOOK_STOCKS missing");

  const readiness: AlertReadiness = {
    session: extras.session ?? null,
    optionsCallouts: { ready: optionsBlockers.length === 0, blockedBy: optionsBlockers },
    stockCallouts: { ready: stockBlockers.length === 0, blockedBy: stockBlockers },
    premarketNotifications: { ready: premarketBlockers.length === 0, blockedBy: premarketBlockers },
  };

  return { items, summary, readiness };
}

export function buildRuntimeStatus(nowMs: number = Date.now()): RuntimeStatus {
  const thisPid = process.pid;

  // ── worker / lease ownership ───────────────────────────────────────────────
  const scannerHolder = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { scannerLockHolder } = require("@/lib/instance-lock");
    return scannerLockHolder(db(), nowMs);
  }, { holder: null, fresh: false });
  const schedHolder = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { leaseHolder } = require("@/lib/instance-lock");
    return leaseHolder(db(), "scheduler", nowMs);
  }, { holder: null, fresh: false });

  const loop = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/scanner-loop").loopState();
  }, { running: false, lastTickAt: null, ticks: 0, triggers: 0, alerts: 0, errors: 0, session: null });

  const sched = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/scheduler").schedulerState();
  }, { started: false, isOwner: false, note: "unavailable", lastRun: {}, runs: {} } as any);

  const supervisor = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/supervisor-cycle").supervisorTelemetry();
  }, {} as Record<string, unknown>);

  const calloutSummary = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/callouts/state-store").calloutStateSummary();
  }, { total: 0, byStatus: {}, lastEmitAtMs: null });

  const canonicalPath = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/callouts/routing").calloutCanonicalPath();
  }, "legacy");
  const discordDeliveryEnabled = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/callouts/routing").supervisorDiscordDeliveryEnabled();
  }, false);

  // ── Supervisor→paper bridge observability ──────────────────────────────────
  const paperCandidates = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/callouts/paper-bridge").paperCandidateSummary(nowMs);
  }, { total: 0, created: 0, rejected: 0, eligiblePending: 0, last24h: { created: 0, rejected: 0 }, recentRejections: [] } as any);
  const dailyPaper = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/paper-engine").dailyPaperSummary(nowMs);
  }, { text: "No paper trades today: paper summary unavailable.", qualifyingActionableCallouts: 0, paperCandidatesCreated: 0, readyOrders: 0, revalidationAttempts: 0, fills: 0, rejected: 0, expiredEntryWindows: 0 } as any);

  const deliveries: Record<string, number> = {};
  safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rows = require("@/lib/alert-store").discordDeliverySummary() as any[];
    for (const r of rows) deliveries[r.status] = Number(r.count);
    return null;
  }, null);

  // ── learning / drift / model ───────────────────────────────────────────────
  const learning = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/learning-store").learningStatus();
  }, { modelStatus: {}, latestDrift: null, counts: { graded: 0, outcomes: 0 }, recentRuns: [] } as any);

  const model = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/model-registry").modelStatus();
  }, { state: "INACTIVE_NO_TRAINABLE_DATA", tier: "NONE", championVersion: null, experimental: null } as any);

  const req = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reg = require("@/lib/model-registry");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exp = require("@/lib/model-experimental");
    const meta = model.experimental;
    if (!meta) return { moreForValidated: null, moreForExperimental: null };
    const v = reg.defaultActivationThresholds();
    const e = reg.defaultExperimentalThresholds();
    return {
      moreForValidated: exp.requiredForValidated(meta, { minGraded: v.minGraded, minWins: v.minWins, minLosses: v.minLosses, minHoldout: v.minHoldout }),
      moreForExperimental: exp.requiredForValidated(meta, { minGraded: e.minGraded, minWins: e.minWins, minLosses: e.minLosses, minHoldout: e.minHoldout }),
    };
  }, { moreForValidated: null, moreForExperimental: null });

  const counts = learning.counts ?? { graded: 0, outcomes: 0 };
  const expMeta = model.experimental ?? { wins: 0, losses: 0 };

  const learningMs = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/scheduler-policy").schedulerIntervals().learningMs;
  }, 60 * 60_000);
  const lastLearningRun = (sched.lastRun && sched.lastRun.learning) ?? null;
  const nextEligibleLearningMs = lastLearningRun != null ? lastLearningRun + learningMs : null;

  // ── improvement agent ──────────────────────────────────────────────────────
  const improvement = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/improvement-store").improvementStatus();
  }, { agentState: "INACTIVE_NO_AUTOMATION", counts: { total: 0 } } as any);
  const auditEnabled = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/scheduler").improvementAuditEnabled();
  }, false);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const deploy = safe(() => require("@/lib/build-info").deployInfo(), { commit: null, commitShort: null, branch: null });
  return {
    nowMs,
    deploy,
    worker: {
      scanner: {
        holderPid: scannerHolder.holder?.pid ?? null, fresh: scannerHolder.fresh,
        hostname: scannerHolder.holder?.hostname ?? null, heartbeatAt: scannerHolder.holder?.heartbeat_at ?? null,
        running: Boolean(loop.running),
      },
      scheduler: {
        holderPid: schedHolder.holder?.pid ?? null, fresh: schedHolder.fresh,
        hostname: schedHolder.holder?.hostname ?? null, heartbeatAt: schedHolder.holder?.heartbeat_at ?? null,
        started: Boolean(sched.started), isOwner: Boolean(sched.isOwner), note: String(sched.note ?? ""),
      },
      thisPid,
    },
    scanner: {
      running: Boolean(loop.running), lastTickAt: loop.lastTickAt ?? null, ticks: loop.ticks ?? 0,
      triggers: loop.triggers ?? 0, alerts: loop.alerts ?? 0, errors: loop.errors ?? 0, session: loop.session ?? null,
    },
    supervisor,
    callouts: {
      canonicalTracked: calloutSummary.total, byStatus: calloutSummary.byStatus,
      lastEmitAtMs: calloutSummary.lastEmitAtMs, canonicalPath, discordDeliveryEnabled,
    },
    paper: {
      autoEntryEnabled: process.env.PAPER_AUTO_ENTRY === "1",
      allowZeroDte: process.env.PAPER_ALLOW_ZERO_DTE === "1",
      tradingEnabled: process.env.PAPER_TRADING_ENABLED !== "0",
      candidates: {
        total: paperCandidates.total, created: paperCandidates.created, rejected: paperCandidates.rejected,
        eligiblePending: paperCandidates.eligiblePending,
        last24hCreated: paperCandidates.last24h.created, last24hRejected: paperCandidates.last24h.rejected,
      },
      daily: dailyPaper,
      recentRejections: paperCandidates.recentRejections,
      summary: `${paperCandidates.total} Supervisor paper candidates · ${paperCandidates.created} created · ${paperCandidates.rejected} rejected · ${paperCandidates.eligiblePending} pending`,
    },
    discord: { deliveries },
    scheduler: sched,
    learning: {
      lastCycleNote: learning.modelStatus?.message ?? null,
      nextEligibleLearningMs,
      driftState: learning.latestDrift?.state ?? null,
      lastDriftAtMs: learning.latestDrift?.atMs ?? null,
    },
    outcomes: {
      total: counts.outcomes ?? 0, graded: counts.graded ?? 0,
      wins: expMeta.wins ?? 0, losses: expMeta.losses ?? 0,
    },
    model: {
      state: model.state ?? "INACTIVE_NO_TRAINABLE_DATA", tier: model.tier ?? "NONE",
      championVersion: model.championVersion ?? null,
      moreForValidated: req.moreForValidated, moreForExperimental: req.moreForExperimental,
    },
    improvement: {
      mode: improvement.agentState ?? "INACTIVE_NO_AUTOMATION", auditEnabled,
      pendingProposals: improvement.counts?.READY_FOR_CODING_AGENT ?? 0,
      blocked: improvement.counts?.BLOCKED ?? 0,
    },
    config: buildConfigVisibility(process.env, {
      extendedStockNotify: safe(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require("@/lib/notifications").extendedStockNotifyEnabled();
      }, false),
      stockWebhookConfigured: safe(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require("@/lib/notifications").discordWebhookConfigured("stocks");
      }, false),
      optionsWebhookConfigured: safe(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require("@/lib/notifications").discordWebhookConfigured("options");
      }, false),
      session: safe(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require("@/lib/trading-session").marketSession(nowMs);
      }, undefined),
    }),
  };
}

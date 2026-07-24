/**
 * Paper trade end-to-end lifecycle diagnostic.
 * Assembles Candidate → … → Broker V2 mirrored stages with exact blocking reasons.
 * Two lanes: legacy_primary (Supervisor → paper_trades) and options (independent delivery).
 */
import type { BrokerDb } from "@/lib/broker/audit.ts";

export type LifecycleLane = "legacy_primary" | "options";
export type StageStatus = "OK" | "PENDING" | "SKIPPED" | "FAILED" | "N/A";

export interface LifecycleStage {
  stage: string;
  label: string;
  status: StageStatus;
  atMs: number | null;
  reason: string | null;
  refs: Record<string, string | number | null>;
}

export interface PaperLifecycleReport {
  lane: LifecycleLane;
  identity: {
    symbol: string | null;
    alertId: string | null;
    paperTradeId: number | null;
    optionTradeId: number | null;
    candidateId: number | null;
  };
  currentStage: string;
  blocked: boolean;
  blockingReason: string | null;
  stages: LifecycleStage[];
  summary: string;
}

export interface PaperLifecycleListItem {
  lane: LifecycleLane;
  id: string;
  symbol: string;
  status: string;
  blocked: boolean;
  blockingReason: string | null;
  currentStage: string;
  updatedAtMs: number | null;
}

function tableExists(db: BrokerDb, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function firstBlock(stages: LifecycleStage[]): { stage: string; reason: string | null } | null {
  const hit = stages.find((s) => s.status === "FAILED" || (s.status === "SKIPPED" && s.reason));
  if (!hit) return null;
  return { stage: hit.stage, reason: hit.reason };
}

function stage(
  id: string,
  label: string,
  status: StageStatus,
  atMs: number | null,
  reason: string | null,
  refs: Record<string, string | number | null> = {},
): LifecycleStage {
  return { stage: id, label, status, atMs, reason, refs };
}

/** Build Supervisor / Primary lane timeline for one paper_trades row. */
export function buildLegacyPaperLifecycle(db: BrokerDb, tradeId: number): PaperLifecycleReport | null {
  if (!tableExists(db, "paper_trades")) return null;
  const trade = db.prepare(`SELECT * FROM paper_trades WHERE id=?`).get(tradeId) as Record<string, any> | undefined;
  if (!trade) return null;

  const candidate = tableExists(db, "paper_candidates")
    ? (db.prepare(`SELECT * FROM paper_candidates WHERE paper_trade_id=? ORDER BY id DESC LIMIT 1`).get(tradeId) as
        | Record<string, any>
        | undefined)
    : undefined;

  const decisions = tableExists(db, "paper_decisions")
    ? ((db.prepare(`SELECT * FROM paper_decisions WHERE trade_id=? ORDER BY id DESC LIMIT 8`).all?.(tradeId) ??
        []) as Array<Record<string, any>>)
    : [];
  const outcome = tableExists(db, "paper_trade_outcomes")
    ? (db.prepare(`SELECT * FROM paper_trade_outcomes WHERE paper_trade_id=?`).get(tradeId) as
        | Record<string, any>
        | undefined)
    : undefined;

  const link = tableExists(db, "broker_legacy_links")
    ? (db
        .prepare(`SELECT * FROM broker_legacy_links WHERE legacy_table='paper_trades' AND legacy_id=?`)
        .get(String(tradeId)) as Record<string, any> | undefined)
    : undefined;
  const parityFail = tableExists(db, "broker_parity_events")
    ? Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM broker_parity_events WHERE legacy_table='paper_trades' AND legacy_id=? AND matched=0`,
            )
            .get(String(tradeId)) as { n: number } | undefined
        )?.n ?? 0,
      )
    : 0;

  const status = String(trade.status ?? "").toUpperCase();
  const stages: LifecycleStage[] = [];

  // Candidate
  if (candidate) {
    const cs = String(candidate.status ?? "").toUpperCase();
    stages.push(
      stage(
        "candidate",
        "Candidate",
        cs === "CREATED" || cs === "ELIGIBLE" ? "OK" : cs === "REJECTED" ? "FAILED" : "PENDING",
        Number(candidate.created_at_ms) || null,
        cs === "REJECTED" ? String(candidate.reject_reason ?? "rejected") : null,
        { candidateId: candidate.id, idempotencyKey: candidate.idempotency_key ?? null },
      ),
    );
  } else {
    stages.push(stage("candidate", "Candidate", "N/A", null, "no paper_candidates row linked", {}));
  }

  // Supervisor decision (from paper_decisions / candidate confidence)
  const refused = decisions.find((d) => Number(d.allowed) === 0);
  stages.push(
    stage(
      "supervisor_decision",
      "Supervisor Decision",
      refused ? "FAILED" : candidate || trade ? "OK" : "PENDING",
      refused ? Number(refused.created_at_ms) || null : Number(trade.created_at_ms) || null,
      refused ? String(refused.reason ?? refused.decision ?? "refused") : "eligible / created",
      { decision: refused?.decision ?? "create" },
    ),
  );

  // Discord — Supervisor Discord is parallel; Primary paper does not require Discord SENT
  stages.push(
    stage(
      "discord_delivery",
      "Discord Delivery",
      "N/A",
      null,
      "Supervisor paper path does not require Discord SENT (delivery is independent)",
      {},
    ),
  );

  // Paper created
  stages.push(
    stage(
      "paper_created",
      "Paper Trade Created",
      "OK",
      Number(trade.created_at_ms) || null,
      null,
      { paperTradeId: trade.id, status },
    ),
  );

  // Entry filled
  const entered = ["ENTERED", "EXITED", "STOPPED_OUT", "TAKE_PROFIT", "EXPIRED"].includes(status);
  const cancelled = status === "CANCELLED";
  stages.push(
    stage(
      "entry_filled",
      "Entry Filled",
      entered ? "OK" : cancelled ? "FAILED" : status === "READY" || status === "WATCHING" || status === "PENDING" ? "PENDING" : "FAILED",
      trade.entry_at_ms != null ? Number(trade.entry_at_ms) : null,
      cancelled
        ? String(trade.exit_reason ?? decisions.find((d) => /entry|cancel|reject/i.test(String(d.decision)))?.reason ?? "entry cancelled")
        : entered
          ? null
          : "awaiting fill / revalidation",
      { entryPrice: trade.entry_price ?? null },
    ),
  );

  // Open position
  stages.push(
    stage(
      "open_position",
      "Open Position",
      status === "ENTERED" ? "OK" : entered && status !== "ENTERED" ? "OK" : cancelled ? "SKIPPED" : "PENDING",
      trade.entry_at_ms != null ? Number(trade.entry_at_ms) : null,
      status === "ENTERED" ? "position open" : null,
      { status },
    ),
  );

  // Exit
  const closed = ["EXITED", "STOPPED_OUT", "TAKE_PROFIT", "EXPIRED"].includes(status);
  stages.push(
    stage(
      "exit_trigger",
      "Exit Trigger",
      closed ? "OK" : status === "ENTERED" ? "PENDING" : cancelled ? "SKIPPED" : "PENDING",
      trade.exit_at_ms != null ? Number(trade.exit_at_ms) : null,
      closed ? String(trade.exit_reason ?? status) : status === "ENTERED" ? "holding" : null,
      { exitReason: trade.exit_reason ?? null },
    ),
  );

  stages.push(
    stage(
      "position_closed",
      "Position Closed",
      closed ? "OK" : cancelled ? "FAILED" : "PENDING",
      trade.exit_at_ms != null ? Number(trade.exit_at_ms) : null,
      closed ? null : cancelled ? "never entered / cancelled" : "still open or not filled",
      { exitPrice: trade.exit_price ?? null },
    ),
  );

  // Graded
  if (outcome) {
    const g = String(outcome.grade ?? outcome.grading_status ?? "");
    stages.push(
      stage(
        "graded",
        "Graded",
        g === "UNGRADABLE" ? "FAILED" : "OK",
        Number(outcome.graded_at_ms ?? outcome.updated_at_ms ?? trade.exit_at_ms) || null,
        g === "UNGRADABLE" ? String(outcome.data_quality_status ?? "ungradable") : `grade=${g}`,
        { grade: outcome.grade ?? null, returnPct: outcome.return_pct ?? null },
      ),
    );
  } else {
    stages.push(
      stage(
        "graded",
        "Graded",
        closed ? "PENDING" : "PENDING",
        null,
        closed ? "outcome row not yet written" : "waiting for close",
        {},
      ),
    );
  }

  // Broker V2
  const v2On = process.env.PAPER_BROKER_V2_ENABLED === "1";
  if (!v2On) {
    stages.push(stage("broker_mirrored", "Brokerage V2 Mirrored", "N/A", null, "PAPER_BROKER_V2_ENABLED!=1", {}));
  } else if (!link) {
    stages.push(
      stage("broker_mirrored", "Brokerage V2 Mirrored", entered ? "FAILED" : "PENDING", null, "no broker_legacy_links row", {
        legacyTable: "paper_trades",
      }),
    );
  } else {
    const complete = link.entry_fill_id && (closed ? link.exit_fill_id : true);
    stages.push(
      stage(
        "broker_mirrored",
        "Brokerage V2 Mirrored",
        complete ? (parityFail > 0 ? "FAILED" : "OK") : "PENDING",
        Number(link.created_at_ms) || null,
        parityFail > 0 ? `${parityFail} unmatched parity event(s)` : complete ? null : "exit fill not mirrored yet",
        { linkId: link.id, entryFillId: link.entry_fill_id ?? null, exitFillId: link.exit_fill_id ?? null },
      ),
    );
  }

  const block = firstBlock(stages);
  const current =
    [...stages].reverse().find((s) => s.status === "OK" || s.status === "PENDING" || s.status === "FAILED")?.stage ??
    "candidate";

  return {
    lane: "legacy_primary",
    identity: {
      symbol: trade.ticker ?? candidate?.ticker ?? null,
      alertId: trade.alert_id != null ? String(trade.alert_id) : null,
      paperTradeId: tradeId,
      optionTradeId: null,
      candidateId: candidate?.id ?? null,
    },
    currentStage: current,
    blocked: Boolean(block && (block.reason || stages.some((s) => s.status === "FAILED"))),
    blockingReason: block?.reason ?? null,
    stages,
    summary: `${trade.ticker ?? "?"} ${status}${block?.reason ? ` — blocked: ${block.reason}` : ""}`,
  };
}

/** Build independent options lane timeline for one options_paper_trades or alert_id. */
export function buildOptionsPaperLifecycle(
  db: BrokerDb,
  opts: { optionTradeId?: number; alertId?: string },
): PaperLifecycleReport | null {
  if (!tableExists(db, "options_paper_trades") && !tableExists(db, "options_alerts")) return null;

  let trade: Record<string, any> | undefined;
  if (opts.optionTradeId != null && tableExists(db, "options_paper_trades")) {
    trade = db.prepare(`SELECT * FROM options_paper_trades WHERE id=?`).get(opts.optionTradeId) as
      | Record<string, any>
      | undefined;
  }
  const alertId = opts.alertId ?? (trade?.alert_id != null ? String(trade.alert_id) : null);
  if (!trade && alertId && tableExists(db, "options_paper_trades")) {
    trade = db
      .prepare(
        `SELECT * FROM options_paper_trades WHERE alert_id=? AND paper_kind='DELIVERED_ALERT_PAPER' ORDER BY id DESC LIMIT 1`,
      )
      .get(alertId) as Record<string, any> | undefined;
  }

  const alert =
    alertId && tableExists(db, "options_alerts")
      ? (db.prepare(`SELECT * FROM options_alerts WHERE alert_id=?`).get(alertId) as Record<string, any> | undefined)
      : undefined;
  const decision =
    alertId && tableExists(db, "options_delivery_decisions")
      ? (db
          .prepare(`SELECT * FROM options_delivery_decisions WHERE alert_id=? ORDER BY id DESC LIMIT 1`)
          .get(alertId) as Record<string, any> | undefined)
      : undefined;
  const candidate =
    tableExists(db, "options_candidates") && (alert?.candidate_symbol || trade?.option_symbol)
      ? (db
          .prepare(
            `SELECT * FROM options_candidates WHERE symbol=? ORDER BY id DESC LIMIT 1`,
          )
          .get(String(alert?.candidate_symbol ?? trade?.underlying_symbol ?? "").toUpperCase() || "___") as
          | Record<string, any>
          | undefined)
      : undefined;

  const symbol = String(
    alert?.candidate_symbol ?? trade?.option_symbol ?? candidate?.symbol ?? "?",
  ).toUpperCase();

  const link =
    trade && tableExists(db, "broker_legacy_links")
      ? (db
          .prepare(`SELECT * FROM broker_legacy_links WHERE legacy_table='options_paper_trades' AND legacy_id=?`)
          .get(String(trade.id)) as Record<string, any> | undefined)
      : undefined;
  const parityFail =
    trade && tableExists(db, "broker_parity_events")
      ? Number(
          (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM broker_parity_events WHERE legacy_table='options_paper_trades' AND legacy_id=? AND matched=0`,
              )
              .get(String(trade.id)) as { n: number } | undefined
          )?.n ?? 0,
        )
      : 0;

  const stages: LifecycleStage[] = [];

  if (candidate) {
    const st = String(candidate.state ?? "").toUpperCase();
    stages.push(
      stage(
        "candidate",
        "Candidate",
        st === "READY" || st === "SELECTED" ? "OK" : st.includes("REJECT") ? "FAILED" : "PENDING",
        Number(candidate.created_at_ms) || null,
        st.includes("REJECT") ? String(candidate.why ?? st) : null,
        { candidateId: candidate.id },
      ),
    );
  } else {
    stages.push(stage("candidate", "Candidate", alert || trade ? "OK" : "PENDING", null, candidate ? null : "no options_candidates row", {}));
  }

  if (decision) {
    const outcome = String(decision.outcome ?? "");
    const final = String(decision.final_delivery_outcome ?? "");
    const ok = outcome === "DELIVER_TO_DISCORD" && (final === "DELIVERED" || final === "" || final === "SKIPPED");
    stages.push(
      stage(
        "supervisor_decision",
        "Delivery Decision",
        outcome === "DELIVER_TO_DISCORD" ? (final === "DELIVERED" || !final || final === "SKIPPED" ? "OK" : "FAILED") : outcome === "RESEARCH_ONLY" ? "SKIPPED" : "FAILED",
        Number(decision.created_at_ms) || null,
        outcome === "DELIVER_TO_DISCORD"
          ? final && final !== "DELIVERED" && final !== "SKIPPED"
            ? String(decision.final_delivery_reason ?? final)
            : `quality=${decision.quality}`
          : String(decision.reason ?? outcome),
        { quality: decision.quality ?? null, outcome, final },
      ),
    );
  } else {
    stages.push(
      stage("supervisor_decision", "Delivery Decision", alert ? "OK" : "PENDING", null, "no options_delivery_decisions row", {}),
    );
  }

  if (alert) {
    const st = String(alert.state ?? "").toUpperCase();
    stages.push(
      stage(
        "discord_delivery",
        "Discord Delivery",
        st === "SENT" ? "OK" : st === "SEND_ATTEMPTED" ? "PENDING" : st.includes("FAIL") || st === "REJECTED" || st === "TOO_LATE" ? "FAILED" : "PENDING",
        Number(alert.sent_at_ms ?? alert.attempted_at_ms) || null,
        st === "SENT" ? null : String(alert.failure_reason ?? st),
        { alertId: alert.alert_id, paperLinked: alert.paper_linked },
      ),
    );
  } else {
    stages.push(stage("discord_delivery", "Discord Delivery", "PENDING", null, "no options_alerts row", {}));
  }

  if (trade && String(trade.paper_kind) === "DELIVERED_ALERT_PAPER") {
    stages.push(
      stage("paper_created", "Paper Trade Created", "OK", Number(trade.created_at_ms) || null, null, {
        optionTradeId: trade.id,
        paperKind: trade.paper_kind,
      }),
    );
  } else if (alert && Number(alert.paper_linked) === 1) {
    stages.push(stage("paper_created", "Paper Trade Created", "OK", null, "paper_linked=1", {}));
  } else if (alert && String(alert.state).toUpperCase() === "SENT") {
    stages.push(
      stage("paper_created", "Paper Trade Created", "FAILED", null, "Discord SENT but paper_linked=0 (mirror missing)", {
        alertId,
      }),
    );
  } else {
    stages.push(stage("paper_created", "Paper Trade Created", "PENDING", null, "awaiting delivered mirror", {}));
  }

  const tStatus = String(trade?.status ?? "").toUpperCase();
  const entered = tStatus === "ENTERED" || tStatus === "EXITED";
  stages.push(
    stage(
      "entry_filled",
      "Entry Filled",
      entered ? "OK" : trade ? "PENDING" : "PENDING",
      trade?.entered_at_ms != null ? Number(trade.entered_at_ms) : null,
      entered ? null : "not entered",
      { entryFill: trade?.entry_fill ?? null },
    ),
  );
  stages.push(
    stage(
      "open_position",
      "Open Position",
      tStatus === "ENTERED" ? "OK" : tStatus === "EXITED" ? "OK" : "PENDING",
      trade?.entered_at_ms != null ? Number(trade.entered_at_ms) : null,
      null,
      { status: tStatus || null },
    ),
  );
  stages.push(
    stage(
      "exit_trigger",
      "Exit Trigger",
      tStatus === "EXITED" ? "OK" : tStatus === "ENTERED" ? "PENDING" : "PENDING",
      trade?.exit_at_ms != null ? Number(trade.exit_at_ms) : null,
      trade?.exit_reason ? String(trade.exit_reason) : null,
      {},
    ),
  );
  stages.push(
    stage(
      "position_closed",
      "Position Closed",
      tStatus === "EXITED" ? "OK" : "PENDING",
      trade?.exit_at_ms != null ? Number(trade.exit_at_ms) : null,
      null,
      { exitFill: trade?.exit_fill ?? null },
    ),
  );

  if (tStatus === "EXITED" && trade) {
    const ungradable = trade.exit_reason === "expiration_no_quote" || trade.return_pct == null;
    stages.push(
      stage(
        "graded",
        "Graded",
        ungradable ? "FAILED" : "OK",
        Number(trade.exit_at_ms) || null,
        ungradable ? String(trade.exit_reason ?? "missing return_pct") : `return_pct=${trade.return_pct}`,
        { returnPct: trade.return_pct ?? null, pnl: trade.pnl ?? null },
      ),
    );
  } else {
    stages.push(stage("graded", "Graded", "PENDING", null, "waiting for exit", {}));
  }

  const v2On = process.env.PAPER_BROKER_V2_ENABLED === "1";
  if (!v2On) {
    stages.push(stage("broker_mirrored", "Brokerage V2 Mirrored", "N/A", null, "PAPER_BROKER_V2_ENABLED!=1", {}));
  } else if (!trade) {
    stages.push(stage("broker_mirrored", "Brokerage V2 Mirrored", "PENDING", null, "no paper trade to mirror", {}));
  } else if (!link) {
    stages.push(
      stage("broker_mirrored", "Brokerage V2 Mirrored", entered ? "FAILED" : "PENDING", null, "no broker_legacy_links row", {}),
    );
  } else {
    const complete = Boolean(link.entry_fill_id) && (tStatus !== "EXITED" || Boolean(link.exit_fill_id));
    stages.push(
      stage(
        "broker_mirrored",
        "Brokerage V2 Mirrored",
        complete ? (parityFail > 0 ? "FAILED" : "OK") : "PENDING",
        Number(link.created_at_ms) || null,
        parityFail > 0 ? `${parityFail} unmatched parity event(s)` : null,
        { linkId: link.id },
      ),
    );
  }

  const block = firstBlock(stages);
  const current =
    [...stages].reverse().find((s) => s.status === "OK" || s.status === "PENDING" || s.status === "FAILED")?.stage ??
    "candidate";

  return {
    lane: "options",
    identity: {
      symbol,
      alertId,
      paperTradeId: null,
      optionTradeId: trade?.id ?? null,
      candidateId: candidate?.id ?? null,
    },
    currentStage: current,
    blocked: Boolean(block),
    blockingReason: block?.reason ?? null,
    stages,
    summary: `${symbol}${block?.reason ? ` — blocked: ${block.reason}` : ` — ${current}`}`,
  };
}

/** Recent lifecycle list for the diagnostic dashboard. */
export function listRecentPaperLifecycles(db: BrokerDb, limit = 40): PaperLifecycleListItem[] {
  const out: PaperLifecycleListItem[] = [];
  if (tableExists(db, "paper_trades")) {
    const rows = (db
      .prepare(`SELECT id, ticker, status, updated_at_ms, created_at_ms FROM paper_trades ORDER BY id DESC LIMIT ?`)
      .all?.(Math.min(limit, 30)) ?? []) as Array<Record<string, any>>;
    for (const r of rows) {
      const report = buildLegacyPaperLifecycle(db, Number(r.id));
      if (!report) continue;
      out.push({
        lane: "legacy_primary",
        id: `legacy:${r.id}`,
        symbol: String(r.ticker ?? "?"),
        status: String(r.status ?? ""),
        blocked: report.blocked,
        blockingReason: report.blockingReason,
        currentStage: report.currentStage,
        updatedAtMs: Number(r.updated_at_ms ?? r.created_at_ms) || null,
      });
    }
  }
  if (tableExists(db, "options_paper_trades")) {
    const rows = (db
      .prepare(
        `SELECT id, option_symbol, status, alert_id, updated_at_ms, created_at_ms, paper_kind
         FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER' OR paper_kind='RESEARCH_ONLY_PAPER'
         ORDER BY id DESC LIMIT ?`,
      )
      .all?.(Math.min(limit, 30)) ?? []) as Array<Record<string, any>>;
    for (const r of rows) {
      const report = buildOptionsPaperLifecycle(db, { optionTradeId: Number(r.id), alertId: r.alert_id ? String(r.alert_id) : undefined });
      if (!report) continue;
      out.push({
        lane: "options",
        id: `options:${r.id}`,
        symbol: String(r.option_symbol ?? report.identity.symbol ?? "?"),
        status: String(r.status ?? ""),
        blocked: report.blocked,
        blockingReason: report.blockingReason,
        currentStage: report.currentStage,
        updatedAtMs: Number(r.updated_at_ms ?? r.created_at_ms) || null,
      });
    }
  }
  out.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
  return out.slice(0, limit);
}

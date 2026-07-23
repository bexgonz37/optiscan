/**
 * discord-doctor.mjs — one-command, end-to-end Discord alert-delivery diagnosis.
 *
 * WHY THIS EXISTS: the options discovery + delivery pipeline is intentionally
 * isolated — every cycle/pass swallows its errors so a provider/DB/Discord
 * failure can never crash the web server (see OPTIONS_RECOVERY_RUNBOOK.md). The
 * cost of that safety is that a real outage looks like silence: zero alerts, a
 * green healthcheck, and nothing in the user's face. This doctor reads the
 * already-exposed runtime state and turns that silence into a ranked cause.
 *
 * It is READ-ONLY by default. It never changes a flag, threshold, or filter, and
 * never fabricates a live signal. With --send it posts ONE clearly-labeled
 * connectivity message to the options webhook (the app's own transport test).
 *
 * USAGE (run against PRODUCTION — that's where the alerts come from):
 *   BASE_URL=https://YOUR-APP.up.railway.app SCAN_API_TOKEN=xxxx \
 *     node scripts/discord-doctor.mjs
 *   # add --send to also fire the labeled connectivity test:
 *   BASE_URL=... SCAN_API_TOKEN=... node scripts/discord-doctor.mjs --send
 *
 * Locally you can instead point it at a running dev server and load env safely:
 *   node --env-file=.env.local scripts/discord-doctor.mjs
 *   (BASE_URL defaults to http://localhost:8780)
 *
 * The token is read from SCAN_API_TOKEN and sent only as the x-scan-token header;
 * it is never printed. No webhook URL or secret is ever printed.
 */

const BASE = (process.env.BASE_URL ?? "http://localhost:8780").replace(/\/$/, "");
const TOKEN = process.env.SCAN_API_TOKEN ?? "";
const SEND = process.argv.includes("--send");
const H = TOKEN ? { "x-scan-token": TOKEN } : {};

async function get(path, auth = false) {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: auth ? H : {}, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text: json ? null : text.slice(0, 300) };
  } catch (e) {
    return { status: 0, json: null, error: String(e?.message ?? e) };
  }
}

async function post(path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text: json ? null : text.slice(0, 300) };
  } catch (e) {
    return { status: 0, json: null, error: String(e?.message ?? e) };
  }
}

const line = (s = "") => console.log(s);
const findings = []; // { sev: 'CRITICAL'|'WARN'|'INFO', msg, fix? }
const add = (sev, msg, fix) => findings.push({ sev, msg, fix });

line(`\nOptiScan Discord Doctor → ${BASE}`);
line("=".repeat(64));

// 1) LIVENESS + deployed commit + DB readiness (ungated).
const health = await get("/api/healthz");
if (health.status === 0) {
  add("CRITICAL", `Cannot reach ${BASE}/api/healthz (${health.error}). The server is down or the URL/network is wrong.`,
    "Confirm BASE_URL and that the Railway service is up.");
} else {
  const h = health.json ?? {};
  line(`\n[1] Liveness`);
  line(`    commit:   ${h.commitShort ?? "?"} (branch ${h.branch ?? "?"})`);
  line(`    db open:  ${h.db === true ? "yes" : "NO"}${h.dbError ? `  — ${h.dbError}` : ""}`);
  if (h.db === false) {
    add("CRITICAL", `Database cannot be opened in the deployed environment (${h.dbError ?? "unknown"}). ` +
      `healthz still returns 200 (liveness), so Railway keeps the container up, but every scanner/monitor cycle ` +
      `throws on getDb() and is silently swallowed → zero alerts.`,
      "Check the Railway persistent volume mount at /app/data (mounted? writable?). Restart the service after the volume is healthy.");
  }
}

// 2) Discord surface (UNGATED): webhook config + 24h delivery metrics + recent failures.
const dh = await get("/api/discord/health");
if (dh.json) {
  const w = dh.json.webhooks ?? {};
  const m = dh.json.metrics ?? {};
  line(`\n[2] Discord surface (last 24h)`);
  line(`    webhooks: options=${w.options} stocks=${w.stocks} default=${w.default} recap=${w.recap}`);
  line(`    sent24h=${m.sent24h ?? 0}  failed24h=${m.failed24h ?? 0}  suppressed24h=${m.suppressed24h ?? 0}  notConfigured24h=${m.notConfigured24h ?? 0}`);
  line(`    lastSentAt=${m.lastSentAt ?? "never"}  lastFailureAt=${m.lastFailureAt ?? "never"}`);
  if (w.options === false) add("CRITICAL", "DISCORD_WEBHOOK_OPTIONS is not set in the deployed env.", "Set DISCORD_WEBHOOK_OPTIONS in Railway and redeploy.");
  if ((m.failed24h ?? 0) > 0 || (m.notConfigured24h ?? 0) > 0) {
    const fails = dh.json.recentFailures ?? [];
    add("WARN", `${m.failed24h ?? 0} failed + ${m.notConfigured24h ?? 0} not-configured legacy deliveries in 24h. ` +
      (fails.length ? `Most recent: ${fails.map((f) => `${f.status}/${f.webhook_name ?? "?"}:${(f.failure_reason ?? "").slice(0, 60)}`).join("; ")}` : ""),
      "Inspect the failure_reason above.");
  }
} else {
  add("WARN", `/api/discord/health unreachable (${dh.status || dh.error}).`);
}

// 3) Options runtime (TOKEN): is the monitor running, are the gates open, what did delivery decide?
const opt = await get("/api/research/options", true);
if (opt.status === 401) {
  add("CRITICAL", "SCAN_API_TOKEN missing/incorrect — cannot read the options runtime (the path that sends subscriber option alerts).",
    "Set SCAN_API_TOKEN to the deployed token and re-run.");
} else if (opt.json) {
  const j = opt.json;
  const f = j.flags ?? {};
  const mh = j.monitor?.health ?? {};
  const dd = j.deliveryDecisions ?? {};
  const dm = j.delivery ?? {};
  const session = j.monitor?.sessionState ?? "?";
  line(`\n[3] Options runtime`);
  line(`    flags: independentOptionsDiscovery=${f.independentOptionsDiscovery} earlyOptionsCallouts=${f.earlyOptionsCallouts} realOptionPaper=${f.realOptionPaper}`);
  line(`    monitor: running=${j.monitor?.running} enabled=${mh.enabled} alive=${mh.alive} session=${session}`);
  line(`    portfolioDelivery: enabled=${dd.enabled} healthy=${mh.portfolioDelivery?.healthy} reason=${mh.portfolioDelivery?.reason ?? "-"}`);
  line(`    lastCycleMs: t0=${j.monitor?.lastTier0CycleMs ?? "-"} t1=${j.monitor?.lastTier1CycleMs ?? "-"} t2=${j.monitor?.lastTier2CycleMs ?? "-"}`);
  line(`    delivery: sent=${dm.sent ?? 0} sendFailed=${dm.sendFailed ?? 0} rejected=${dm.rejected ?? 0} tooLate=${dm.tooLate ?? 0} latestFailure=${dm.latestFailureReason ?? "-"}`);
  line(`    decisions: ranked=${dd.candidatesRanked ?? 0} selected=${dd.selectedForDelivery ?? 0} delivered=${dd.delivered ?? 0} ` +
    `withheldThreshold=${dd.withheldByThreshold ?? 0} killSwitch=${dd.deliveryBlockedKillSwitch ?? 0} ` +
    `discordFail=${dd.deliveryDiscordFailures ?? 0} webhookFail=${dd.deliveryWebhookFailures ?? 0}`);

  // Ranked interpretation — maps runtime state to the exact gate in delivery.ts / monitor.ts.
  if (f.independentOptionsDiscovery === false) {
    add("CRITICAL", "INDEPENDENT_OPTIONS_DISCOVERY_ENABLED != 1 — the options scanner is a clean no-op, so NO option alerts are produced or sent.",
      "If option alerts are expected, set INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1 in Railway (with EARLY_OPTIONS_CALLOUTS_ENABLED=1 and OPTIONS_PORTFOLIO_DELIVERY_ENABLED=1).");
  } else {
    if (f.earlyOptionsCallouts === false) add("CRITICAL", "EARLY_OPTIONS_CALLOUTS_ENABLED != 1 — deliverOptionsCallout short-circuits ('callouts_disabled'); nothing is sent.", "Set EARLY_OPTIONS_CALLOUTS_ENABLED=1.");
    if (dd.enabled === false) add("CRITICAL", "OPTIONS_PORTFOLIO_DELIVERY_ENABLED != 1 — delivery returns 'portfolio_delivery_required' and the monitor refuses to start delivery; nothing is sent.", "Set OPTIONS_PORTFOLIO_DELIVERY_ENABLED=1.");
    if (j.monitor?.running === false && mh.enabled) add("CRITICAL", `Options monitor is enabled but NOT running (${mh.portfolioDelivery?.reason ?? "startup refused"}).`, "Check portfolio-delivery health; restart the service.");
    if (mh.alive === false && session === "REGULAR_SESSION") add("CRITICAL", "Monitor cycles have stalled during regular hours (no cycle in >120s). The loop died or is starved.", "Restart the service; check provider health + breaker state.");
    if ((dd.deliveryBlockedKillSwitch ?? 0) > 0) add("CRITICAL", "OPTIONS_CALLOUTS_KILL=1 — the kill switch is engaged; deliveries are blocked.", "Remove/zero OPTIONS_CALLOUTS_KILL in Railway.");
    if ((dd.deliveryWebhookFailures ?? 0) > 0) add("CRITICAL", "Deliveries selected but the webhook is failing (WEBHOOK_FAILURE).", "Verify DISCORD_WEBHOOK_OPTIONS is valid (run with --send).");
    if ((dd.deliveryDiscordFailures ?? 0) > 0) add("WARN", "Discord returned errors on selected deliveries (DISCORD_FAILURE) — rate limit or transient.", "Re-run --send; check Discord status.");
    if ((dd.candidatesRanked ?? 0) > 0 && (dd.selectedForDelivery ?? 0) === 0 && (dd.withheldByThreshold ?? 0) > 0) {
      add("INFO", `Candidates were evaluated but all fell below the subscriber quality bar (withheldByThreshold=${dd.withheldByThreshold}). This is the filter doing its job — NOT loosened here.`,
        "If persistent, review setup quality; do not lower OPTIONS_QUALITY_DELIVER_BAR just to force a send.");
    }
    if ((dd.candidatesRanked ?? 0) === 0 && session !== "REGULAR_SESSION") add("INFO", `No candidates and session=${session} — 0DTE/options callouts only fire during regular hours (09:30–16:00 ET). Expected off-hours.`);
    if ((dd.candidatesRanked ?? 0) === 0 && session === "REGULAR_SESSION" && mh.alive) add("WARN", "Market is open, monitor alive, but zero candidates ranked — either genuinely nothing qualifies, or upstream discovery/provider is starved.", "Check /api/research/options/diagnostic and provider health.");
  }
} else {
  add("WARN", `/api/research/options unreachable (${opt.status || opt.error}).`);
}

// 4) OPTIONAL: labeled connectivity send (safe — no ticker/contract/position/paper row).
if (SEND) {
  line(`\n[4] Sending labeled connectivity test (transport_test)…`);
  const r = await post("/api/research/options", { action: "transport_test" });
  const res = r.json?.result ?? r.json ?? {};
  line(`    ok=${res.ok} status=${res.status ?? "-"} latencyMs=${res.latencyMs ?? "-"} error=${res.error ?? "-"}`);
  if (res.ok) add("INFO", "Labeled connectivity test delivered — the webhook + POST path are healthy end-to-end.");
  else add("CRITICAL", `Connectivity test FAILED (${res.error ?? "unknown"}). Delivery transport itself is broken.`, "Verify DISCORD_WEBHOOK_OPTIONS.");
} else {
  line(`\n[4] (skipped) Re-run with --send to fire ONE clearly-labeled connectivity test.`);
}

// VERDICT
line(`\n${"=".repeat(64)}`);
line("VERDICT");
const order = { CRITICAL: 0, WARN: 1, INFO: 2 };
findings.sort((a, b) => order[a.sev] - order[b.sev]);
if (findings.length === 0) {
  line("  No problems detected in the exposed runtime state.");
} else {
  for (const f of findings) {
    line(`  [${f.sev}] ${f.msg}`);
    if (f.fix) line(`          → ${f.fix}`);
  }
}
const critical = findings.filter((f) => f.sev === "CRITICAL");
line(`\n${critical.length ? `Most likely root cause: ${critical[0].msg}` : "No CRITICAL cause found; see WARN/INFO above."}`);
line("");
process.exit(critical.length ? 1 : 0);

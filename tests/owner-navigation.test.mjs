import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const shell = read("components/AxiomShell.tsx");
const navrail = read("components/ui/NavRail.tsx");
const mobile = read("components/MobileBottomNav.tsx");
const guide = read("app/guide/page.tsx");
const callouts = read("app/callouts/page.tsx");
const layout = read("app/layout.tsx");
const auth = read("lib/auth.ts");
const unlock = read("components/UnlockGate.tsx");

// ── routes remain accessible ────────────────────────────────────────────────
test("all routes still have a page (nothing removed)", () => {
  const routes = ["", "callouts", "paper", "performance", "data", "guide", "watchlist",
    "quant", "research-learning", "improvement", "settings", "alerts", "swing", "scanner"];
  for (const r of routes) {
    assert.ok(existsSync(join(root, "app", r, "page.tsx")), `missing route: /${r}`);
  }
});

// ── owner mode is the default: DAILY vs ADVANCED ────────────────────────────
test("DAILY nav holds exactly the six owner destinations", () => {
  const daily = shell.match(/const DAILY_NAV[\s\S]*?\];/)[0];
  for (const href of ['"/"', '"/callouts"', '"/paper"', '"/performance"', '"/data"', '"/guide"']) {
    assert.ok(daily.includes(href), `DAILY missing ${href}`);
  }
  // Advanced-only routes must NOT be in DAILY.
  for (const href of ['"/watchlist"', '"/quant"', '"/settings"', '"/improvement"']) {
    assert.ok(!daily.includes(href), `DAILY should not contain ${href}`);
  }
});

test("ADVANCED nav holds the advanced tools", () => {
  const adv = shell.match(/const ADVANCED_NAV[\s\S]*?\];/)[0];
  for (const href of ['"/watchlist"', '"/quant"', '"/research-learning"', '"/improvement"', '"/settings"']) {
    assert.ok(adv.includes(href), `ADVANCED missing ${href}`);
  }
});

test("ADVANCED section is collapsible and collapsed by default", () => {
  assert.match(shell, /title:\s*"ADVANCED TOOLS"/);
  const block = shell.match(/title:\s*"ADVANCED TOOLS"[\s\S]*?\}/)[0];
  assert.match(block, /collapsible:\s*true/);
  assert.match(block, /collapsedByDefault:\s*true/);
  // NavRail actually honors collapsedByDefault (open state derives from it).
  assert.match(navrail, /useState\(!collapsedByDefault\)/);
  assert.match(navrail, /aria-expanded=\{open\}/);
});

test("DAILY group is not collapsible (always visible)", () => {
  const daily = shell.match(/\{\s*title:\s*"DAILY"[\s\S]*?\}/)[0];
  assert.ok(!/collapsible/.test(daily), "DAILY must stay expanded");
});

// ── Improvement Agent hidden/inactive when automation off ───────────────────
test("Improvement Agent is marked inactive when automation is disabled", () => {
  assert.match(shell, /improvementActive === false/);
  assert.match(shell, /note:\s*"inactive"/);
  assert.match(shell, /auditEnabled/);
});

// ── mobile navigation ───────────────────────────────────────────────────────
test("mobile bottom nav points at owner destinations and consolidates callouts", () => {
  for (const href of ['"/"', '"/callouts"', '"/data"', '"/guide"']) {
    assert.ok(mobile.includes(href), `mobile nav missing ${href}`);
  }
  // Old /alerts and /swing map to the Callouts tab for active state.
  assert.match(mobile, /href === "\/callouts"[\s\S]*?"\/alerts"[\s\S]*?"\/swing"/);
});

// ── consolidation: old URLs still work + light up Callouts ───────────────────
test("legacy /alerts and /swing map to the consolidated Callouts destination", () => {
  const active = shell.match(/if \(href === "\/callouts"\)[\s\S]*?\}/)[0];
  assert.ok(active.includes('"/alerts"') && active.includes('"/swing"'), "callouts active-state must cover legacy URLs");
  assert.match(read("app/swing/page.tsx"), /SwingResearchPanel/);
  assert.match(read("app/swing/page.tsx"), /callouts\?tab=swing/);
  assert.match(read("app/alerts/page.tsx"), /axiom-compat-note/);
});

// ── Callouts page exposes every horizon as a tab ─────────────────────────────
test("Callouts page exposes every required tab", () => {
  for (const label of ["All", "0DTE", "1–5 DTE", "6–10 DTE", "11–35 DTE", "36–90 DTE",
    "Momentum Stocks", "Put Research", "Rejected / Blocked", "Swing Research"]) {
    assert.ok(callouts.includes(`"${label}"`), `Callouts tab missing: ${label}`);
  }
  // Deep-link support so redirects can target a filter.
  assert.match(callouts, /useSearchParams/);
  assert.match(callouts, /get\("tab"\)/);
});

// ── Guide covers every page + status + metric + example ─────────────────────
test("Guide explains every navigation page", () => {
  for (const page of ["Command Center", "Options Callouts", "Watchlist", "Paper Trading",
    "Performance", "Research & Backtesting", "System Health", "Settings", "Horizon Callouts",
    "Research & Learning", "Improvement Agent", "Swing Research", "Guide"]) {
    assert.ok(guide.includes(page), `Guide missing page: ${page}`);
  }
});

test("Guide explains every callout status", () => {
  for (const status of ["ACTIONABLE_NOW", "NEAR_TRIGGER", "DEVELOPING", "WATCH", "WAIT_FOR_PULLBACK",
    "EXTENDED", "NO_VALID_CONTRACT", "DATA_STALE", "INVALIDATED", "RESEARCH_ONLY",
    "MODEL_EXPERIMENTAL", "MODEL_INACTIVE", "INSUFFICIENT_EVIDENCE"]) {
    assert.ok(guide.includes(status), `Guide missing status: ${status}`);
  }
});

test("Guide distinguishes scores, probabilities, and verdicts", () => {
  for (const term of ["Setup score", "Experimental probability", "Validated probability",
    "Evidence status", "Risk verdict", "Contract score"]) {
    assert.ok(guide.includes(term), `Guide missing metric: ${term}`);
  }
});

test("Guide has concrete worked examples", () => {
  for (const ex of ["0DTE call", "Weekly call", "Multi-week call", "Put research setup",
    "Stale-data rejection", "No-valid-contract rejection", "Paper trade outcome"]) {
    assert.ok(guide.includes(ex), `Guide missing example: ${ex}`);
  }
});

test("Guide has the six-step daily workflow", () => {
  for (let step = 1; step <= 6; step++) assert.ok(guide.includes(`Step ${step} —`), `Guide missing Step ${step}`);
  assert.match(guide, /Check System Health/);
  assert.match(guide, /Review Discord callouts/);
  assert.match(guide, /Monitor Paper Trading/);
});

test("Guide documents the Railway owner setup (token, keys, webhooks, flags)", () => {
  assert.match(guide, /SCAN_API_TOKEN is your private owner password/);
  assert.match(guide, /POLYGON_API_KEY/);
  assert.match(guide, /DISCORD_WEBHOOK_OPTIONS/);
  assert.match(guide, /SUPERVISOR_RUNTIME=1/);
  assert.match(guide, /AGENT_CALLOUT_DISCORD=1/);
  assert.match(guide, /runs on Railway/);
});

test("Guide is searchable and makes no profitability guarantee", () => {
  assert.match(guide, /Search the guide/);
  assert.ok(!/guarantee[sd]? (a )?profit(?!\.)/i.test(guide.replace(/guarantees a profit\./g, "")), "no profit guarantee");
  assert.match(guide, /not financial advice/i);
});

// ── Unlock experience wired + no dev/db message on 401 ──────────────────────
test("UnlockGate is mounted globally and asks for the token privately", () => {
  assert.match(layout, /<UnlockGate\s*\/>/);
  assert.match(unlock, /Unlock OptiScan/);
  assert.match(unlock, /type="password"/); // token entry is masked
  assert.match(unlock, /This dashboard needs your private OptiScan access token/);
  // Developer instructions must NOT appear in the owner unlock flow.
  assert.ok(!/npm install|localStorage|better-sqlite3/i.test(unlock), "no dev instructions in unlock UI");
});

test("the token is never rendered as page text and never placed in a URL", () => {
  // The only place the token value binds is the password <input value={value}>.
  assert.ok(!/>\{value\}</.test(unlock), "token value must not be rendered as text");
  // The shared fetch attaches a header, never a query param.
  const clientAuth = read("lib/client-auth.ts");
  assert.match(clientAuth, /headers\.set\("x-scan-token", t\)/);
  assert.ok(!/[?&]token=/.test(clientAuth), "token must never be in a query string");
});

test("a 401 response carries an owner message only — no database/localStorage text", () => {
  const fn = auth.match(/export function unauthorized\(\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /status:\s*401/);
  assert.match(fn, /code:\s*"unauthorized"/);
  assert.ok(!/localStorage|better-sqlite3|npm install/i.test(fn), "401 must not include dev/db instructions");
});

test("alerts banner separates auth errors from database-install hint", () => {
  const alerts = read("app/alerts/page.tsx");
  assert.match(alerts, /Access token required/);
  // The better-sqlite3 hint is gated behind a database classification, not shown for auth.
  assert.match(alerts, /kind === "database"[\s\S]*?better-sqlite3/);
});

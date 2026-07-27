import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_CALLOUTS, isSupervisorRoutingNote } from "../lib/dashboard/demo-callouts.ts";
import { mapSystemChips } from "../lib/dashboard/command-center-view.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const BLOCKED = new Set(["NO_VALID_CONTRACT", "DATA_STALE", "INVALIDATED", "BLOCKED"]);

function finalActionForDemo(c) {
  const bid = c.contract?.bid ?? null;
  const ask = c.contract?.ask ?? null;
  const mid = c.contract?.mid ?? null;
  const spread = c.contract?.spreadPct ?? null;
  const hasQuote = (bid != null && ask != null) || mid != null;
  const stale = c.quoteFreshness !== "fresh" || BLOCKED.has(c.status) || c.status === "DATA_STALE";
  const contractUnavailable = !hasQuote || !c.contract?.optionSymbol || stale;

  let contractState = "READY";
  if (contractUnavailable) contractState = "UNAVAILABLE";
  else if (spread != null && spread > 12) contractState = "THIN";

  let entryState = "UNKNOWN";
  if (c.primaryBlockingReason || BLOCKED.has(c.status)) entryState = "BLOCK";
  else if (c.entryStatusLabel === "ACTIONABLE NOW" && c.actionable) entryState = "ACTIONABLE";
  else if (contractUnavailable || c.estimatedEntry == null) entryState = "WAIT";
  else entryState = "WAIT";

  let systemAction = "WATCH";
  if (c.direction === "bearish" || c.researchOnlyWarning) systemAction = "RESEARCH";
  if (entryState === "BLOCK" || c.primaryBlockingReason) systemAction = "BLOCK";
  else if (entryState === "ACTIONABLE" && contractState === "READY") systemAction = "SEND";
  else if (contractState === "UNAVAILABLE") systemAction = "WAIT";

  let finalAction = systemAction;
  if (contractState === "UNAVAILABLE") finalAction = "WAIT";
  if (entryState === "BLOCK") finalAction = "BLOCK";
  return finalAction;
}

test("review demo callouts form 2 SEND · 2 WATCH · 1 RESEARCH · 1 BLOCK hierarchy", () => {
  assert.equal(DEMO_CALLOUTS.length, 6);
  const counts = { SEND: 0, WATCH: 0, RESEARCH: 0, BLOCK: 0, WAIT: 0 };
  for (const c of DEMO_CALLOUTS) {
    counts[finalActionForDemo(c)] += 1;
    assert.equal(c.demo, true);
    assert.ok(c.contract?.bid != null && c.contract?.ask != null, `${c.key} needs bid/ask`);
  }
  assert.equal(counts.SEND, 2);
  assert.equal(counts.WATCH, 2);
  assert.equal(counts.RESEARCH, 1);
  assert.equal(counts.BLOCK, 1);
});

test("demo callouts have distinct scores and fresh quotes where actionable", () => {
  const scores = new Set(DEMO_CALLOUTS.map((c) => c.contractScore));
  assert.ok(scores.size >= 4, "scores should vary across setups");
  const sendRows = DEMO_CALLOUTS.filter((c) => c.actionable);
  assert.equal(sendRows.length, 2);
  for (const c of sendRows) {
    assert.equal(c.quoteFreshness, "fresh");
    assert.ok(c.estimatedEntry != null);
  }
});

test("supervisor routing notes are stripped from trader-facing Live Options", () => {
  assert.equal(
    isSupervisorRoutingNote(
      "Supervisor Discord delivery OFF (set CALLOUT_CANONICAL_PATH=supervisor and AGENT_CALLOUT_DISCORD=1).",
    ),
    true,
  );
  assert.equal(isSupervisorRoutingNote("Independent monitor healthy."), false);
});

test("review-mode system chips use coherent DEMO / REVIEW / SEEDED labels", () => {
  const chips = mapSystemChips({ authFailed: false, independent: {}, uiReview: true });
  const byLabel = Object.fromEntries(chips.map((c) => [c.label, c.state]));
  assert.equal(byLabel.SYSTEM, "DEMO");
  assert.equal(byLabel.SESSION, "REVIEW");
  assert.equal(byLabel.MONITOR, "DEMO");
  assert.equal(byLabel.PROVIDER, "SEEDED");
  assert.equal(byLabel.DISCORD, "NOT TESTED");
  assert.equal(byLabel.GRADER, "DEMO");
  assert.ok(!chips.some((c) => c.state === "LIVE" && c.label !== "SYSTEM"));
  assert.ok(!chips.some((c) => /STARTING|CONNECTED/i.test(c.state) && c.label !== "DISCORD"));
});

test("production mapSystemChips keeps canonical live labels", () => {
  const chips = mapSystemChips({
    authFailed: false,
    independent: {
      monitorAlive: true,
      runMode: "RUNNING_IN_WORKER",
      session: "REGULAR_SESSION",
      polygonConfigured: true,
      polygonHealthy: true,
      webhookConfigured: true,
    },
    graderRunning: true,
    graderLastCycleAgeMs: 5_000,
    uiReview: false,
  });
  assert.ok(chips.some((c) => c.label === "OPTISCAN" && c.state === "LIVE"));
  assert.ok(chips.some((c) => c.label === "Polygon" && c.state === "CONNECTED"));
});

test("ui review mode defaults off in deployed bundle (localStorage gate only)", () => {
  const uiReview = read("lib/dashboard/ui-review.ts");
  assert.match(uiReview, /localStorage\.getItem\("optiscan:uiReview"\)/);
  assert.match(uiReview, /NEXT_PUBLIC_OPTISCAN_UI_REVIEW/);
  const callouts = read("app/callouts/page.tsx");
  assert.match(callouts, /if \(isUiReviewMode\(\)\)/);
  assert.match(callouts, /DEMO_CALLOUTS/);
  assert.match(callouts, /isSupervisorRoutingNote/);
});

test("review demo data is not written by seed script to production sqlite path", () => {
  const seed = read("scripts/seed-terminal-demo.mjs");
  assert.match(seed, /Does NOT flip PAPER_0DTE_RESEARCH_ENABLED/);
  assert.ok(!/INSERT INTO.*callouts/i.test(seed), "seed script must not insert supervisor callouts");
});

test("access-token control lives in header — no floating FAB when modal closed", () => {
  const shell = read("components/AxiomShell.tsx");
  const unlock = read("components/UnlockGate.tsx");
  assert.match(shell, /HeaderUnlock/);
  assert.match(shell, /pgtop-actions/);
  assert.match(unlock, /if \(!open\) return null/);
  assert.ok(!/unlock-fab/.test(unlock), "UnlockGate must not render floating FAB");
  assert.match(read("lib/client-auth.ts"), /UNLOCK_PROMPT_EVENT/);
});

test("mobile layout keeps header unlock and hides legacy FAB styles", () => {
  const css = read("app/shared-ui.css");
  assert.match(css, /\.header-unlock-btn/);
  assert.match(css, /\.unlock-fab \{ display: none/);
});

test("Live Options page does not surface supervisor copy in production path", () => {
  const callouts = read("app/callouts/page.tsx");
  assert.ok(!/Supervisor Discord delivery/i.test(callouts));
  assert.match(callouts, /isSupervisorRoutingNote\(rawNote\) \? "" : rawNote/);
});

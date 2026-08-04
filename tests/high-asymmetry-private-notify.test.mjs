/**
 * tests/high-asymmetry-private-notify.test.mjs — the owner-private surfacing
 * path. These tests exist to make the module SAFE TO MERGE WHILE DISABLED:
 * every boundary is asserted executably, not assumed from documentation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  notifyPrivateAsymmetry,
  buildPrivateMessage,
  resolvePrivateConfig,
  resolvePrivateSessionMessageLimit,
  createPrivateCaseMemory,
  PRIVATE_NOTIFIABLE_STATES,
  PRIVATE_SUPPRESSED_STATES,
  FORBIDDEN_WEBHOOK_ENV,
  PRIVATE_ENABLED_ENV,
  PRIVATE_WEBHOOK_ENV,
  PRIVATE_MAX_SESSION_MESSAGES_ENV,
} from "../lib/research/asymmetry/private-notify.ts";
import { canResearchStateSend, ASYMMETRY_RESEARCH_STATES, RESEARCH_STATE_CAN_SEND } from "../lib/research/asymmetry/states.ts";

const PRIVATE = "https://discord.com/api/webhooks/PRIVATE/owner";
const ON = { [PRIVATE_ENABLED_ENV]: "1", [PRIVATE_WEBHOOK_ENV]: PRIVATE };

const candidate = (over = {}) => ({
  fingerprint: "fp_1", sessionDate: "2026-07-31", symbol: "NVDA", direction: "CALL",
  optionSymbol: "O:NVDA260807C00200000", state: "EARLY_ASYMMETRY", observedAtMs: Date.UTC(2026, 6, 31, 14, 0, 0),
  whyEarly: "Contract observed before any premium expansion from the earliest valid executable quote.",
  premiumChasePct: 1.2, bid: 2.0, ask: 2.1, spreadPct: 4.9,
  openInterest: 5000, contractVolume: 800,
  trigger: "Above $200.00", invalidation: "Loses $196.00",
  missingEvidence: ["impliedVolatility"], setupFamilyLabel: "Breakout continuation",
  ...over,
});

function recorder(ok = true) {
  const calls = [];
  return { calls, send: async (webhook, content) => { calls.push({ webhook, content }); return ok ? { ok: true } : { ok: false, reason: "webhook 500" }; } };
}

// ── Off by default ──────────────────────────────────────────────────────────

test("disabled by default: no flag means no work and no send", async () => {
  const s = recorder();
  const r = await notifyPrivateAsymmetry(candidate(), { send: s.send, memory: createPrivateCaseMemory(), env: {} });
  assert.equal(r.outcome, "DISABLED");
  assert.match(r.reason, new RegExp(PRIVATE_ENABLED_ENV));
  assert.equal(s.calls.length, 0);
  assert.equal(r.content, null);
});

test("enabled but unconfigured is inert, not a fallback", async () => {
  const s = recorder();
  const r = await notifyPrivateAsymmetry(candidate(), {
    send: s.send, memory: createPrivateCaseMemory(),
    // A full set of subscriber webhooks is present — none may be borrowed.
    env: { [PRIVATE_ENABLED_ENV]: "1", DISCORD_WEBHOOK_OPTIONS: "https://x/opt", DISCORD_WEBHOOK_WATCHLIST: "https://x/wl", DISCORD_WEBHOOK_RECAP: "https://x/rc", DISCORD_WEBHOOK_URL: "https://x/all" },
  });
  assert.equal(r.outcome, "NOT_CONFIGURED");
  assert.equal(s.calls.length, 0, "must never fall back to a subscriber webhook");
});

test("only the literal \"1\" enables it", () => {
  for (const v of ["", "0", "true", "yes", undefined]) {
    assert.equal(resolvePrivateConfig({ [PRIVATE_ENABLED_ENV]: v }).enabled, false, `${v} must not enable`);
  }
  assert.equal(resolvePrivateConfig({ [PRIVATE_ENABLED_ENV]: "1" }).enabled, true);
});

// ── Cannot reach a subscriber channel ───────────────────────────────────────

test("a private webhook equal to ANY subscriber webhook is refused", async () => {
  for (const name of FORBIDDEN_WEBHOOK_ENV) {
    const s = recorder();
    const r = await notifyPrivateAsymmetry(candidate(), {
      send: s.send, memory: createPrivateCaseMemory(),
      env: { [PRIVATE_ENABLED_ENV]: "1", [PRIVATE_WEBHOOK_ENV]: "https://collide", [name]: "https://collide" },
    });
    assert.equal(r.outcome, "REFUSED_SUBSCRIBER_WEBHOOK", `collision with ${name} must be refused`);
    assert.match(r.reason, new RegExp(name));
    assert.equal(s.calls.length, 0, `must not send when colliding with ${name}`);
  }
});

test("the sender only ever receives the dedicated private webhook", async () => {
  const s = recorder();
  await notifyPrivateAsymmetry(candidate(), {
    send: s.send, memory: createPrivateCaseMemory(),
    env: { ...ON, DISCORD_WEBHOOK_OPTIONS: "https://x/opt", DISCORD_WEBHOOK_WATCHLIST: "https://x/wl" },
  });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].webhook, PRIVATE);
});

test("the module reads no subscriber webhook variable and has no fallback operator", () => {
  const src = readFileSync("lib/research/asymmetry/private-notify.ts", "utf8");
  // Strip the forbidden-list declaration and comments; no other reference may remain.
  const body = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/export const FORBIDDEN_WEBHOOK_ENV[\s\S]*?\]\);/, "");
  for (const name of FORBIDDEN_WEBHOOK_ENV) {
    assert.equal(body.includes(`env.${name}`), false, `must not read ${name} directly`);
  }
  assert.equal(/\?\?\s*env\.DISCORD/.test(body), false, "no subscriber fallback operator");
});

// ── No subscriber SEND authority ────────────────────────────────────────────

test("the shadow radar cannot produce a subscriber SEND from any state", async () => {
  for (const state of ASYMMETRY_RESEARCH_STATES) {
    assert.equal(canResearchStateSend(state), false);
    assert.equal(RESEARCH_STATE_CAN_SEND[state], false);
    const r = await notifyPrivateAsymmetry(candidate({ state }), {
      send: recorder().send, memory: createPrivateCaseMemory(), env: ON,
    });
    assert.equal(r.subscriberSendCreated, false, `${state} must never create a subscriber send`);
  }
});

test("the module contains no alert, contract, paper, or trade authority", () => {
  const src = readFileSync("lib/research/asymmetry/private-notify.ts", "utf8");
  const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  // Formatting helpers and the read-only paper PERMISSION are allowed; neither
  // can select a contract, freeze an entry, or open a position.
  assert.deepEqual(imports.sort(), ["./contract-format.ts", "./states.ts"],
    "the private path must import only state types and pure formatting");
  // Strip comments: the safety rationale legitimately names the things the CODE
  // must not do, and prose must not be mistaken for an authority reference.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const forbidden of ["deliverOptionsCallout", "sendTrackedDiscord", "placeOrder", "freezeEntry", "selectContract"]) {
    assert.equal(code.includes(forbidden), false, `must not reference ${forbidden}`);
  }
  // "paper" may now appear, but ONLY as a reported status string — never as a
  // call that could open, size, or modify a position.
  assert.equal(/paperStatus\s*[:?]/.test(code), true, "paper status is reported");
  assert.equal(/openPaper|PaperTrade\(|paperEntry\(|sizePaper/.test(code), false,
    "the notifier must not reach any paper-writing function");
});

// ── Only early states are surfaced ──────────────────────────────────────────

test("premium-chased and failed candidates are never surfaced as early", async () => {
  for (const state of PRIVATE_SUPPRESSED_STATES) {
    const s = recorder();
    const r = await notifyPrivateAsymmetry(candidate({ state }), { send: s.send, memory: createPrivateCaseMemory(), env: ON });
    assert.equal(r.outcome, "SUPPRESSED_STATE", `${state} must be suppressed`);
    assert.equal(s.calls.length, 0);
  }
  assert.deepEqual([...PRIVATE_NOTIFIABLE_STATES], ["EARLY_ASYMMETRY", "CONFIRMING", "HIGH_ASYMMETRY", "TRIGGERED"]);
  // The two sets must be disjoint and together cover every state.
  assert.equal(new Set([...PRIVATE_NOTIFIABLE_STATES, ...PRIVATE_SUPPRESSED_STATES]).size, ASYMMETRY_RESEARCH_STATES.length);
});

// ── Noise control ───────────────────────────────────────────────────────────

test("one case per fingerprint: an unchanged repeat is silent", async () => {
  const s = recorder();
  const memory = createPrivateCaseMemory();
  const first = await notifyPrivateAsymmetry(candidate(), { send: s.send, memory, env: ON });
  assert.equal(first.outcome, "SENT");
  const repeat = await notifyPrivateAsymmetry(candidate(), { send: s.send, memory, env: ON });
  assert.equal(repeat.outcome, "SUPPRESSED_UNCHANGED");
  assert.equal(s.calls.length, 1, "a repeat must not send twice");
});

test("a genuine state change does surface", async () => {
  const s = recorder();
  const memory = createPrivateCaseMemory();
  await notifyPrivateAsymmetry(candidate({ state: "EARLY_ASYMMETRY" }), { send: s.send, memory, env: ON });
  const promoted = await notifyPrivateAsymmetry(candidate({ state: "HIGH_ASYMMETRY" }), { send: s.send, memory, env: ON });
  assert.equal(promoted.outcome, "SENT");
  assert.equal(s.calls.length, 2);
});

test("a per-symbol session ceiling bounds the noise", async () => {
  const s = recorder();
  const memory = createPrivateCaseMemory();
  const states = ["EARLY_ASYMMETRY", "CONFIRMING", "HIGH_ASYMMETRY", "TRIGGERED"];
  for (let i = 0; i < states.length; i++) {
    await notifyPrivateAsymmetry(candidate({ fingerprint: `fp_${i}`, state: states[i] }), { send: s.send, memory, env: ON, maxPerSymbolSession: 2 });
  }
  assert.equal(s.calls.length, 2, "the ceiling must stop further messages for the symbol");
});

// ── Message content ─────────────────────────────────────────────────────────

test("a global session ceiling bounds broad-market spam", async () => {
  const s = recorder();
  const memory = createPrivateCaseMemory();
  for (let i = 0; i < 5; i++) {
    await notifyPrivateAsymmetry(candidate({
      fingerprint: `fp_session_${i}`,
      symbol: `SYM${i}`,
    }), { send: s.send, memory, env: ON, maxPerSession: 3 });
  }
  assert.equal(s.calls.length, 3, "the session ceiling must stop one-off spam across many symbols");
  const blocked = await notifyPrivateAsymmetry(candidate({
    fingerprint: "fp_session_blocked",
    symbol: "NEW",
  }), { send: s.send, memory, env: ON, maxPerSession: 3 });
  assert.equal(blocked.outcome, "SUPPRESSED_RATE_LIMIT");
  assert.match(blocked.reason, /session ceiling 3 reached/);
});

test("the global session ceiling is env-configurable and clamped", () => {
  assert.equal(resolvePrivateSessionMessageLimit({}), 8);
  assert.equal(resolvePrivateSessionMessageLimit({ [PRIVATE_MAX_SESSION_MESSAGES_ENV]: "12" }), 12);
  assert.equal(resolvePrivateSessionMessageLimit({ [PRIVATE_MAX_SESSION_MESSAGES_ENV]: "-3" }), 0);
  assert.equal(resolvePrivateSessionMessageLimit({ [PRIVATE_MAX_SESSION_MESSAGES_ENV]: "9999" }), 500);
});

test("the message carries every required field and never claims a prediction", () => {
  const msg = buildPrivateMessage(candidate());
  // The trader-readable format: the human contract leads, the OCC is a footer.
  for (const required of ["HIGH ASYMMETRY", "NVDA 08/07 $200 Call", "Entry:", "State:", "Why:", "Confirmation:", "Invalidation:", "Risk:", "Paper:", "Research only"]) {
    assert.ok(msg.includes(required), `message must include ${required}`);
  }
  assert.ok(msg.includes("O:NVDA260807C00200000"), "the OCC stays available for verification");
  assert.equal(msg.split("Research only")[0].includes("O:NVDA260807C00200000"), false,
    "but must not appear in the body");
  assert.match(msg, /EARLY_ASYMMETRY/);
  assert.equal(/guaranteed|will move|sure thing|buy now/i.test(msg), false, "no guaranteed language");
});

test("missing evidence stays missing and is never rendered as zero", () => {
  const msg = buildPrivateMessage(candidate({ premiumChasePct: null, bid: null, ask: null, spreadPct: null, openInterest: null, contractVolume: null }));
  assert.match(msg, /Entry: awaiting valid quote/, "no quote means no entry price, stated plainly");
  assert.equal(/\$0\.00|: 0%/.test(msg), false, "absent evidence must not become 0");
  assert.equal(/Premium (still|already)/.test(msg), false,
    "an unmeasured premium chase must not be described at all");
});

// ── Failure containment ─────────────────────────────────────────────────────

test("a send failure is contained and cannot block the caller", async () => {
  const s = recorder(false);
  const r = await notifyPrivateAsymmetry(candidate(), { send: s.send, memory: createPrivateCaseMemory(), env: ON });
  assert.equal(r.outcome, "SEND_FAILED");
  assert.equal(r.reason, "webhook 500");
});

test("a throwing sender never propagates", async () => {
  const r = await notifyPrivateAsymmetry(candidate(), {
    send: async () => { throw new Error("socket reset"); },
    memory: createPrivateCaseMemory(), env: ON,
  });
  assert.equal(r.outcome, "SEND_FAILED");
  assert.match(r.reason, /socket reset/);
});

test("a failed send does not consume the dedupe slot", async () => {
  const memory = createPrivateCaseMemory();
  const bad = recorder(false);
  await notifyPrivateAsymmetry(candidate(), { send: bad.send, memory, env: ON });
  const good = recorder(true);
  const retry = await notifyPrivateAsymmetry(candidate(), { send: good.send, memory, env: ON });
  assert.equal(retry.outcome, "SENT", "a failure must not permanently suppress the candidate");
});

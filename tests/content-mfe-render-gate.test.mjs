/**
 * tests/content-mfe-render-gate.test.mjs
 *
 * The gate decides whether a draft may be built. This file tests the other half:
 * what the draft actually SAYS.
 *
 * A gate that passes a draft and then lets the renderer read
 * `opportunity_content_events.max_return_percent` has not stopped anything — that
 * column is a copy of the ratcheted case summary, and it is the literal source of
 * "Max favorable move was +185.4% (MFE)". So the peak is overridden at the value:
 * verified peaks replace the row, unverified ones blank it, and any line that needed
 * it disappears.
 *
 * Two failure shapes are covered:
 *   - a template that interpolates {{maxReturnPct}}      → the line is dropped
 *   - copy that discusses a maximum favourable move in prose without the placeholder
 *     → the whole draft is dropped, because there is no value to withhold
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildDraftBundle } from "../lib/content/content-event-engine.ts";
import { varsForEventRow } from "../lib/content/content-drafts-runtime.ts";

const EVENT_ROW = {
  symbol: "GOOGL",
  option_type: "PUT",
  strike: 357.5,
  expiration: "2026-08-07",
  frozen_entry: 2.33,
  current_mark: 3.43,
  return_percent: 47.2103,
  // The poisoned value, exactly as the content event stored it.
  max_return_percent: 185.4077,
  direction: "BEARISH",
};

test("an unverified peak is blanked, not read from the event row", () => {
  const v = varsForEventRow(EVENT_ROW, {}, {}, { checked: true, maxReturnPct: null });
  assert.equal(v.maxReturnPct, null);
  assert.equal(v.returnPct, 47.2103, "the realized return is untouched");
});

test("a verified peak replaces the event row's value", () => {
  const v = varsForEventRow(EVENT_ROW, {}, {}, { checked: true, maxReturnPct: 47.2103 });
  assert.equal(v.maxReturnPct, 47.2103);
  assert.notEqual(v.maxReturnPct, 185.4077);
});

test("with no claim check the row's value stands (non-performance copy)", () => {
  const v = varsForEventRow(EVENT_ROW, {}, {});
  assert.equal(v.maxReturnPct, 185.4077, "only a claim check may override; nothing else changes");
});

test("NO rendered draft can contain the false peak", () => {
  const v = varsForEventRow(EVENT_ROW, {}, {}, { checked: true, maxReturnPct: null });
  for (const category of ["CLOSED_WINNER", "NEW_HIGH", "WHY_THIS_WORKED"]) {
    const bundle = buildDraftBundle(category, v, { appendMfeDisclaimer: true });
    for (const d of bundle?.drafts ?? []) {
      assert.ok(!d.text.includes("185.4"), `${category}: the false peak reached copy:\n${d.text}`);
      assert.ok(
        !/max favorable|maximum favorable|MFE|peak favorable/i.test(d.text),
        `${category}: an excursion claim survived with no evidence:\n${d.text}`,
      );
    }
  }
});

test("a verified peak still renders its MFE copy", () => {
  const v = varsForEventRow(EVENT_ROW, {}, {}, { checked: true, maxReturnPct: 47.2103 });
  const bundle = buildDraftBundle("CLOSED_WINNER", v, { appendMfeDisclaimer: true });
  assert.ok(bundle, "a verified excursion must still be publishable");
  const withMfe = (bundle.drafts ?? []).filter((d) => /max favorable|MFE/i.test(d.text));
  assert.ok(withMfe.length > 0, "the gate must not suppress a peak it verified");
  for (const d of withMfe) assert.ok(d.text.includes("47.2"), d.text);
});

test("a realized-return draft survives when only the peak is unprovable", () => {
  const v = varsForEventRow(EVENT_ROW, {}, {}, { checked: true, maxReturnPct: null });
  const bundle = buildDraftBundle("CLOSED_WINNER", v, {});
  assert.ok(bundle, "a valid realized outcome is not discarded for a weak excursion");
  assert.ok(bundle.drafts.length > 0);
  assert.ok(
    bundle.drafts.some((d) => d.text.includes("47.2")),
    "the realized return is still stated",
  );
});

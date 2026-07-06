import test from "node:test";
import assert from "node:assert/strict";
import { inferHaltStatus, catalystFresh, catalystFromNews } from "../lib/halt-inference.ts";

test("inferHaltStatus detects halt and resume wording", () => {
  assert.equal(inferHaltStatus(["Company XYZ trading halt pending news"]), "halted");
  assert.equal(inferHaltStatus(["Trading resumed after volatility pause"]), "resumed");
  assert.equal(inferHaltStatus(["Stock up on earnings beat"]), null);
});

test("catalystFresh within 30 minutes", () => {
  const now = Date.now();
  assert.equal(catalystFresh(new Date(now - 10 * 60_000).toISOString(), now), true);
  assert.equal(catalystFresh(new Date(now - 45 * 60_000).toISOString(), now), false);
});

test("catalystFromNews picks freshest headline type", () => {
  const now = Date.now();
  const classify = (t) => (/\bearnings\b/i.test(t) ? "earnings" : "no_clear_catalyst");
  const out = catalystFromNews(
    [
      { title: "Old analyst note", publishedAt: new Date(now - 2 * 3600_000).toISOString() },
      { title: "Q1 earnings beat", publishedAt: new Date(now - 5 * 60_000).toISOString() },
    ],
    classify,
    now,
  );
  assert.equal(out.catalystType, "earnings");
  assert.equal(out.catalystFresh, true);
});

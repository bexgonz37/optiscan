import test from "node:test";
import assert from "node:assert/strict";
import { classifyHeadline, classifyCatalyst, CATALYST_TYPES } from "../lib/catalysts.js";

const NOW = Date.parse("2026-07-05T14:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

test("classifyHeadline hits each major category", () => {
  const cases = [
    ["Acme beats estimates, raises guidance for Q3", "earnings"],
    ["Acme upgraded to Overweight at MegaBank, price target raised to $90", "analyst"],
    ["FDA approves Acme's lead drug for chronic migraine", "fda_biotech"],
    ["MegaCorp to acquire Acme in $4B deal", "partnership"],
    ["Acme unveils new AI platform for logistics", "product_launch"],
    ["SEC investigation into Acme accounting practices widens", "legal_regulatory"],
    ["Fed rate cut hopes lift growth stocks", "macro_sector"],
    ["Acme becomes latest short squeeze favorite on wallstreetbets", "social_momentum"],
  ];
  for (const [title, want] of cases) {
    const got = classifyHeadline(title);
    assert.ok(got, `no match for: ${title}`);
    assert.equal(got.type, want, `${title} -> ${got.type}, want ${want}`);
  }
  assert.equal(classifyHeadline("Weather is nice today"), null);
  assert.equal(classifyHeadline(""), null);
});

test("classifyCatalyst: fresh strength-3 headline -> strong", () => {
  const res = classifyCatalyst(
    [{ title: "Acme beats estimates and raises guidance", publishedAt: hoursAgo(5), publisher: "Benzinga", url: "https://x" }],
    { nowMs: NOW },
  );
  assert.equal(res.type, "earnings");
  assert.equal(res.quality, "strong");
  assert.equal(res.records.length, 1);
  assert.equal(res.records[0].catalystType, "earnings");
});

test("classifyCatalyst: stale strength-3 -> medium; weak match -> weak", () => {
  const stale = classifyCatalyst(
    [{ title: "FDA approves Acme drug", publishedAt: hoursAgo(60) }],
    { nowMs: NOW },
  );
  assert.equal(stale.quality, "medium");

  const weak = classifyCatalyst(
    [{ title: "Analyst chatter around Acme continues", publishedAt: hoursAgo(4) }],
    { nowMs: NOW },
  );
  assert.equal(weak.quality, "weak");
});

test("classifyCatalyst: no news -> no_clear_catalyst/unknown; big relVol -> inferred social momentum", () => {
  const none = classifyCatalyst([], { nowMs: NOW, relVol: 1.4 });
  assert.equal(none.type, "no_clear_catalyst");
  assert.equal(none.quality, "unknown");

  const inferred = classifyCatalyst([], { nowMs: NOW, relVol: 4.2 });
  assert.equal(inferred.type, "social_momentum");
  assert.equal(inferred.quality, "weak");
  assert.equal(inferred.source, "inferred");
});

test("classifyCatalyst ignores stale (>3d) and unclassifiable items", () => {
  const res = classifyCatalyst(
    [
      { title: "Acme beats estimates", publishedAt: hoursAgo(24 * 5) }, // too old
      { title: "Totally unrelated fluff piece", publishedAt: hoursAgo(2) },
    ],
    { nowMs: NOW },
  );
  assert.equal(res.type, "no_clear_catalyst");
});

test("catalyst type list matches spec", () => {
  for (const t of ["earnings", "analyst", "fda_biotech", "partnership", "product_launch", "legal_regulatory", "macro_sector", "social_momentum", "no_clear_catalyst"]) {
    assert.ok(CATALYST_TYPES.includes(t), t);
  }
});

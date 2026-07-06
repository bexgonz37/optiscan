import test from "node:test";
import assert from "node:assert/strict";
import { classifyHeadline, classifyCatalyst, CATALYST_TYPES } from "../lib/catalysts.js";

const NOW = Date.parse("2026-07-05T14:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

test("classifyHeadline hits each major category", () => {
  const cases = [
    ["Acme beats estimates in record quarter", "earnings"],
    ["Acme raises full-year guidance", "guidance"],
    ["Acme upgraded to Overweight at MegaBank, price target raised to $90", "analyst"],
    ["FDA approves Acme's lead drug for chronic migraine", "fda_biotech"],
    ["MegaCorp to acquire Acme in $4B deal", "ma_acquisition"],
    ["Acme announces strategic partnership with BigCo", "partnership"],
    ["Acme unveils new AI platform for logistics", "product_launch"],
    ["SEC investigation into Acme accounting practices widens", "legal_regulatory"],
    ["Acme files S-1 for secondary offering", "sec_filing"],
    ["Fed rate cut hopes lift growth stocks", "macro_sector"],
    ["Bitcoin rally lifts crypto-adjacent names", "crypto_sympathy"],
    ["AI demand boosts chip stocks across the board", "ai_semiconductor_sympathy"],
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
    [{ title: "Acme beats estimates and posts record quarter", publishedAt: hoursAgo(5), publisher: "Benzinga", url: "https://x" }],
    { nowMs: NOW },
  );
  assert.equal(res.type, "earnings");
  assert.equal(res.quality, "strong");
  assert.equal(res.records.length, 1);
});

test("classifyCatalyst: 2-day-old strength-3 -> medium; weak match -> weak", () => {
  const twoDay = classifyCatalyst([{ title: "FDA approves Acme drug", publishedAt: hoursAgo(60) }], { nowMs: NOW });
  assert.equal(twoDay.quality, "medium");
  const weak = classifyCatalyst([{ title: "Analyst chatter around Acme continues", publishedAt: hoursAgo(4) }], { nowMs: NOW });
  assert.equal(weak.quality, "weak");
});

test("classifyCatalyst: old-but-matched news is STALE, not hidden", () => {
  const res = classifyCatalyst([{ title: "Acme beats estimates", publishedAt: hoursAgo(24 * 5) }], { nowMs: NOW });
  assert.equal(res.type, "earnings");
  assert.equal(res.quality, "stale");
});

test("classifyCatalyst: no news -> unknown; big relVol -> inferred social momentum; >7d dropped", () => {
  const none = classifyCatalyst([], { nowMs: NOW, relVol: 1.4 });
  assert.equal(none.type, "no_clear_catalyst");
  assert.equal(none.quality, "unknown");

  const inferred = classifyCatalyst([], { nowMs: NOW, relVol: 4.2 });
  assert.equal(inferred.type, "social_momentum");
  assert.equal(inferred.source, "inferred");

  const ancient = classifyCatalyst([{ title: "Acme beats estimates", publishedAt: hoursAgo(24 * 10) }], { nowMs: NOW });
  assert.equal(ancient.type, "no_clear_catalyst");
});

test("catalyst type list matches spec", () => {
  for (const t of ["earnings", "guidance", "analyst", "fda_biotech", "partnership", "product_launch", "legal_regulatory", "sec_filing", "ma_acquisition", "macro_sector", "crypto_sympathy", "ai_semiconductor_sympathy", "social_momentum", "no_clear_catalyst"]) {
    assert.ok(CATALYST_TYPES.includes(t), t);
  }
});

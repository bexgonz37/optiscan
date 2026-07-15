import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const paperPage = fs.readFileSync("app/paper/page.tsx", "utf8");
const paperRoute = fs.readFileSync("app/api/paper/trades/route.ts", "utf8");

test("paper dashboard surfaces analytics bucket cuts from the existing API", () => {
  assert.match(paperPage, /Analytics dashboard/);
  assert.match(paperPage, /BUCKET_LABELS/);
  assert.match(paperPage, /data\?\.buckets/);
  assert.match(paperPage, /byConfidence/);
  assert.match(paperPage, /byExpirationLength/);
  assert.match(paperPage, /bySetup/);
  assert.match(paperPage, /byExitKind/);
  assert.match(paperRoute, /byConfidence\(trades\)/);
  assert.match(paperRoute, /byExpirationLength\(trades\)/);
  assert.match(paperRoute, /bySetup\(trades\)/);
  assert.match(paperRoute, /byExitKind\(trades\)/);
});

test("paper analytics dashboard remains read-only over provider/trading side effects", () => {
  const analyticsBody = paperPage.slice(paperPage.indexOf("Analytics dashboard"), paperPage.indexOf("<Panel title=\"Open trades\""));
  assert.doesNotMatch(analyticsBody, /fetch\(/, "analytics panel must not call new APIs");
  assert.doesNotMatch(analyticsBody, /createPaperTrade|paperIt|PATCH|POST/, "analytics panel must not create or change trades");
  assert.match(analyticsBody, /no fabricated history/i);
  assert.match(analyticsBody, /do not place trades/i);
});

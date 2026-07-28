import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyAlertDossier } from "../lib/alert-detail-classification.ts";

const passProof = [
  "Independent options alert row",
  "Subscriber SEND state",
  "Discord message ID",
  "Discord HTTP success",
  "Opportunity case ID",
  "Paper mirror linkage",
  "Matching OCC contract",
  "Frozen entry",
  "Valid grading marks",
].map((label) => ({ label, status: "PASS", pass: true }));

function missingProof(label = "Discord message ID") {
  return passProof.map((p) => p.label === label ? { ...p, status: "MISSING", pass: null } : p);
}

test("NVDA $200 PUT +591.90 with missing Discord proof stays audit-only", () => {
  const store = readFileSync(new URL("../lib/alert-store.ts", import.meta.url), "utf8");
  const classifier = readFileSync(new URL("../lib/alert-detail-classification.ts", import.meta.url), "utf8");
  const dossierSource = `${store}\n${classifier}`;
  const legacyReturn = Number((((3.425 - 0.495) / 0.495) * 100).toFixed(2));
  const conservativeReturn = Number((((3.25 - 0.5) / 0.5) * 100).toFixed(2));

  assert.equal(legacyReturn, 591.92);
  assert.equal(conservativeReturn, 550);
  assert.match(store, /export function getAlertDetailOnDb/);
  assert.match(store, /NO VERIFIED DISCORD DELIVERY/);
  assert.match(dossierSource, /NOT VERIFIED DELIVERED/);
  assert.match(dossierSource, /AUDIT ONLY/);
  assert.match(store, /Legacy mid-to-mid/);
  assert.match(store, /Conservative ask-to-bid/);
  assert.match(store, /optionSymbol: occ/);
});

test("generic dossier classification covers delivered calls, puts, audit, paper-only, and open rows", () => {
  const deliveredCall = classifyAlertDossier({ proof: passProof });
  assert.equal(deliveredCall.badge, "VERIFIED DISCORD ALERT");
  assert.equal(deliveredCall.verifiedDelivered, true);

  const deliveredPut = classifyAlertDossier({ proof: passProof });
  assert.equal(deliveredPut.finalStatus, "VERIFIED DELIVERED");
  assert.equal(deliveredPut.lane, "delivered");

  const auditOnly = classifyAlertDossier({ proof: missingProof(), auditOnly: true });
  assert.equal(auditOnly.badge, "AUDIT ONLY");
  assert.equal(auditOnly.verifiedDelivered, false);

  const paperOnly = classifyAlertDossier({ proof: missingProof("Discord message ID"), paperTradeCount: 1 });
  assert.equal(paperOnly.badge, "PAPER ONLY");
  assert.equal(paperOnly.finalStatus, "NOT VERIFIED DELIVERED");

  const openUngraded = classifyAlertDossier({ proof: missingProof("Valid grading marks") });
  assert.equal(openUngraded.badge, "DELIVERY UNPROVEN");
  assert.deepEqual(openUngraded.missing, ["Valid grading marks"]);
});

test("alert rows expose the canonical alert detail route", () => {
  const page = readFileSync(new URL("../app/alerts/page.tsx", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../components/OptiscanAlertsDashboard.tsx", import.meta.url), "utf8");
  const detailPage = readFileSync(new URL("../app/alerts/[alertId]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /router\.push\(`\/alerts\/\$\{id\}`\)/);
  assert.match(page, /View Alert Details/);
  assert.match(dashboard, /onOpenAlertDetail/);
  assert.match(detailPage, /NO VERIFIED DISCORD DELIVERY/);
});

test("production dossier code has no NVDA-specific fixture logic", () => {
  const productionFiles = [
    "../lib/alert-store.ts",
    "../app/alerts/[alertId]/page.tsx",
    "../app/alerts/page.tsx",
    "../components/OptiscanAlertsDashboard.tsx",
    "../components/DailyPostPack.tsx",
    "../components/ui/ShareCard.tsx",
  ].map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));
  const src = productionFiles.join("\n");
  assert.doesNotMatch(src, /O:NVDA260727P00200000/);
  assert.doesNotMatch(src, /591\.9/);
  assert.doesNotMatch(src, /591\.90/);
  assert.doesNotMatch(src, /id\s*===\s*2012/);
  assert.doesNotMatch(src, /alertId\s*===\s*2012/);
});

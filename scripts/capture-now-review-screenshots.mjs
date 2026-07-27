/**
 * Capture NOW decision-first review screenshots + Discord fixture HTML/PNG.
 * Usage: OPTISCAN_BASE_URL=http://127.0.0.1:8791 SCAN_API_TOKEN=... node --experimental-strip-types scripts/capture-now-review-screenshots.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { DEMO_OVERNIGHT_PLAN } from "../lib/dashboard/demo-overnight-fixtures.ts";
import { demoDiscordMessages } from "../lib/notifications/owner-research-notify.ts";

const BASE = process.env.OPTISCAN_BASE_URL ?? process.env.NOW_REVIEW_BASE ?? "http://127.0.0.1:8791";
const TOKEN = process.env.SCAN_API_TOKEN ?? "";
const OUT = path.resolve("artifacts/now-review");
fs.mkdirSync(OUT, { recursive: true });

const msgs = demoDiscordMessages(DEMO_OVERNIGHT_PLAN);
for (const [name, body] of Object.entries(msgs)) {
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>${name}</title>
  <style>body{font-family:ui-monospace,Consolas,monospace;background:#0b1220;color:#e8eef7;padding:24px;white-space:pre-wrap;line-height:1.45}
  .badge{display:inline-block;background:#1e3a5f;color:#9ec5fe;padding:4px 8px;border-radius:6px;margin-bottom:12px;font-size:12px}
  </style></head><body><div class="badge">UI REVIEW · Discord fixture · ${name}</div>${String(body).replace(/</g, "&lt;")}</body></html>`;
  fs.writeFileSync(path.join(OUT, `discord-${name}.html`), html);
}

async function shot(page, name) {
  await page.waitForTimeout(1400);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log("wrote", file);
}

const browser = await chromium.launch({ headless: true });

for (const session of ["regular", "afterhours"]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(({ token, session }) => {
    try {
      localStorage.setItem("optiscan:token", token);
      localStorage.setItem("optiscan:uiReview", "1");
      localStorage.setItem("optiscan:uiReviewSession", session);
    } catch { /* */ }
  }, { token: TOKEN, session });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await shot(page, `now-${session}-desktop`);
  await context.close();
}

{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript((token) => {
    try {
      localStorage.setItem("optiscan:token", token);
      localStorage.setItem("optiscan:uiReview", "1");
      localStorage.setItem("optiscan:uiReviewSession", "regular");
    } catch { /* */ }
  }, TOKEN);
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await shot(page, "now-mobile");
  await context.close();
}

await browser.close();
console.log("done", OUT);

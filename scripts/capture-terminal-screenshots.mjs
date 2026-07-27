/**
 * Capture terminal UI screenshots for visual review.
 * Usage: OPTISCAN_BASE_URL=http://127.0.0.1:8791 SCAN_API_TOKEN=... node scripts/capture-terminal-screenshots.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.OPTISCAN_BASE_URL ?? "http://127.0.0.1:8791";
const TOKEN = process.env.SCAN_API_TOKEN ?? "";
const OUT = path.resolve("artifacts/terminal-review");
fs.mkdirSync(OUT, { recursive: true });

async function shot(page, name, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(1600);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log("wrote", file);
}

async function goto(page, pathName) {
  await page.goto(`${BASE}${pathName}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2800);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addInitScript((t) => {
  try {
    localStorage.setItem("optiscan:token", t);
    localStorage.setItem("optiscan:uiReview", "1");
  } catch { /* */ }
}, TOKEN);
const page = await context.newPage();

await goto(page, "/");
await shot(page, "command-center-desktop-1440", 1440, 900);
await shot(page, "command-center-mobile-390", 390, 844);

await goto(page, "/callouts");
await shot(page, "live-options-desktop-1440", 1440, 900);
await shot(page, "live-options-mobile-390", 390, 844);

await goto(page, "/quant");
await shot(page, "quant-lab-desktop-1440", 1440, 900);

await goto(page, "/paper/0dte");
await shot(page, "0dte-research-desktop-1440", 1440, 900);
await shot(page, "0dte-research-mobile-390", 390, 844);

const detailHref = await page.locator('a[href^="/paper/0dte/"]').first().getAttribute("href").catch(() => null);
if (detailHref) {
  await goto(page, detailHref);
  await shot(page, "0dte-position-detail-1440", 1440, 900);
} else {
  fs.writeFileSync(path.join(OUT, "0dte-position-detail-MISSING.txt"), "No open position link found");
}

await browser.close();
console.log("done", OUT);

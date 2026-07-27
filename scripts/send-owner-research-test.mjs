/**
 * POST owner-research test notification on production. Never prints token.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.OPTISCAN_BASE_URL ?? "https://optiscan-production.up.railway.app";
const tokenPath = path.join(process.env.TEMP ?? "/tmp", "optiscan-scan-token.tmp");

function readToken() {
  try {
    if (process.env.SCAN_API_TOKEN) return process.env.SCAN_API_TOKEN.trim();
    if (!fs.existsSync(tokenPath)) return null;
    return fs.readFileSync(tokenPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

const token = readToken();
if (!token) {
  console.log(JSON.stringify({ ok: false, error: "SCAN_API_TOKEN unavailable" }, null, 2));
  process.exit(1);
}

const res = await fetch(`${BASE}/api/research/owner-research/test-notification`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, accept: "application/json" },
});
const body = await res.json().catch(() => null);
console.log(JSON.stringify({ status: res.status, ...body }, null, 2));

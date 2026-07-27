/**
 * Read-only production checks for owner research + brokerage soak.
 * Never prints SCAN_API_TOKEN or webhook URLs.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.OPTISCAN_BASE_URL ?? "https://optiscan-production.up.railway.app";
const tokenPath = path.join(process.env.TEMP ?? "/tmp", "optiscan-scan-token.tmp");

function readToken() {
  try {
    if (!fs.existsSync(tokenPath)) return null;
    return fs.readFileSync(tokenPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function getJson(pathname, token) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${pathname}`, { headers, cache: "no-store" });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const token = readToken();
if (!token) {
  console.log(JSON.stringify({ error: "SCAN_API_TOKEN unavailable locally — add to .env.local (see report)" }, null, 2));
  process.exit(1);
}

const [health, discord, runtime, brokerage, healthPub] = await Promise.all([
  getJson("/api/health", token),
  getJson("/api/discord/health", token),
  getJson("/api/runtime/status", token),
  getJson("/api/research/brokerage-readiness", token),
  fetch(`${BASE}/api/health`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
]);

const brokerFlags = runtime.body?.broker ?? runtime.body?.brokerage ?? runtime.body?.flags ?? null;
const readiness = brokerage.body?.report?.status ?? brokerage.body?.report?.readinessStatus ?? null;

console.log(JSON.stringify({
  productionUrl: BASE,
  health: healthPub ? { ok: healthPub.ok, session: healthPub.session, loopRunning: healthPub.loopRunning } : null,
  discordWebhooks: discord.body?.webhooks ?? null,
  ownerResearchEnabled: process.env.OWNER_RESEARCH_DISCORD_ENABLED ?? "(runtime env — check Railway)",
  runtimeBrokerFlags: brokerFlags,
  brokerageReadinessStatus: readiness,
  brokerageCutoverEnabled: brokerage.body?.productionCutoverEnabled ?? null,
  brokerageSoakGate: brokerage.body?.soak?.period?.everReachedControlledCutoverGate ?? null,
  runtimeOk: runtime.body?.ok ?? null,
  paper0dte: runtime.body?.zeroDteResearch?.config?.enabled ?? runtime.body?.paper0dte?.enabled ?? null,
}, null, 2));

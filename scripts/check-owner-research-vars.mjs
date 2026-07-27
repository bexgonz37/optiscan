import fs from "node:fs";
import path from "node:path";

const cfg = JSON.parse(
  fs.readFileSync(path.join(process.env.USERPROFILE ?? "", ".railway", "config.json"), "utf8"),
);
const token = cfg.user?.accessToken;
const proj = Object.values(cfg.projects ?? {})[0];

async function gql(query, variables = {}) {
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

const query = `
  query vars($p: String!, $e: String!, $s: String) {
    variables(projectId: $p, environmentId: $e, serviceId: $s, unrendered: true)
  }
`;

const json = await gql(query, { p: proj.project, e: proj.environment, s: proj.service });
if (json.errors) {
  console.error(JSON.stringify(json.errors, null, 2));
  process.exit(1);
}

const v = json.data?.variables ?? {};
const SECRET = /WEBHOOK|TOKEN|KEY|SECRET|PASSWORD|POLYGON|STRIPE/i;
const WANT = [
  "OWNER_RESEARCH_DISCORD_ENABLED",
  "DISCORD_WEBHOOK_RECAP",
  "DISCORD_WEBHOOK_URL",
  "DISCORD_WEBHOOK_OPTIONS",
  "PAPER_0DTE_RESEARCH_ENABLED",
  "PAPER_BROKER_V2_READS_ENABLED",
  "PAPER_BROKER_V2_SHADOW_READ_ENABLED",
  "SCAN_API_TOKEN",
  "INDEPENDENT_OPTIONS_DISCOVERY_ENABLED",
  "OPTIONS_PORTFOLIO_DELIVERY_ENABLED",
];

const out = { variableCount: Object.keys(v).length };
for (const k of WANT) {
  out[k] = SECRET.test(k) ? (v[k] ? "[SET]" : "[UNSET]") : (v[k] ?? "(unset)");
}
console.log(JSON.stringify(out, null, 2));

const tmp = path.join(process.env.TEMP ?? "/tmp", "optiscan-scan-token.tmp");
if (v.SCAN_API_TOKEN) {
  fs.writeFileSync(tmp, v.SCAN_API_TOKEN, { mode: 0o600 });
}

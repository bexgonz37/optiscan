/**
 * Set OWNER_RESEARCH_DISCORD_ENABLED=1 on Railway (only this variable).
 * Never prints secret values.
 */
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

const checkQuery = `
  query vars($p: String!, $e: String!, $s: String) {
    variables(projectId: $p, environmentId: $e, serviceId: $s, unrendered: true)
  }
`;

const upsertMutation = `
  mutation upsert($input: VariableUpsertInput!) {
    variableUpsert(input: $input)
  }
`;

const ids = { p: proj.project, e: proj.environment, s: proj.service };
const existing = await gql(checkQuery, ids);
if (existing.errors) {
  console.log(JSON.stringify({ ok: false, step: "read", error: existing.errors[0]?.message ?? "read failed" }, null, 2));
  process.exit(1);
}

const v = existing.data?.variables ?? {};
const recapPresent = Boolean(String(v.DISCORD_WEBHOOK_RECAP ?? "").trim());
if (!recapPresent) {
  console.log(JSON.stringify({
    ok: false,
    step: "precheck",
    error: "DISCORD_WEBHOOK_RECAP must be configured securely in Railway before enabling owner research",
    recapConfigured: false,
  }, null, 2));
  process.exit(1);
}

const upsert = await gql(upsertMutation, {
  input: {
    projectId: ids.p,
    environmentId: ids.e,
    serviceId: ids.s,
    name: "OWNER_RESEARCH_DISCORD_ENABLED",
    value: "1",
    skipDeploys: false,
  },
});

if (upsert.errors) {
  console.log(JSON.stringify({ ok: false, step: "upsert", error: upsert.errors[0]?.message ?? "upsert failed" }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  changed: ["OWNER_RESEARCH_DISCORD_ENABLED=1"],
  recapConfigured: true,
  priorValue: v.OWNER_RESEARCH_DISCORD_ENABLED ?? "(unset)",
  deployTriggered: true,
}, null, 2));

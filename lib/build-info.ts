/**
 * build-info.ts — deployed build identity. The ONLY reliable way to confirm which
 * commit is actually live (vs origin/main) without shell access to the container.
 * Railway injects RAILWAY_GIT_COMMIT_SHA / RAILWAY_GIT_BRANCH into the runtime
 * automatically; other hosts may set GIT_COMMIT / SOURCE_COMMIT. None are secrets.
 */
export interface DeployInfo {
  commit: string | null;
  commitShort: string | null;
  branch: string | null;
}

export function deployInfo(env: NodeJS.ProcessEnv = process.env): DeployInfo {
  const commit = env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT || env.SOURCE_COMMIT || null;
  return {
    commit,
    commitShort: commit ? String(commit).slice(0, 7) : null,
    branch: env.RAILWAY_GIT_BRANCH || null,
  };
}

/**
 * Whether the running process can name its own commit — and, when it cannot, WHY.
 *
 * `railway up` uploads a directory and carries no git metadata, so a deploy made that way
 * runs with none of the variables above set. Every row written during such a deploy has no
 * honest SHA to record. The failure this type exists to prevent is that absence being written
 * as `UNKNOWN_LEGACY_VERSION`, which means something entirely different: "this row predates
 * attribution". A live row from an unidentifiable deploy and a 2026-07 legacy row would then
 * be indistinguishable, and the one report that could catch a bad deploy would be the report
 * that hid it.
 *
 * `state` is therefore explicit and is surfaced in diagnostics rather than defaulted away.
 * A SHA is NEVER fabricated — the supported remedy is to deploy through the GitHub/main path,
 * which sets `RAILWAY_GIT_COMMIT_SHA`.
 */
export type DeploymentShaState = "OBSERVED" | "RUNTIME_SHA_UNAVAILABLE";

export interface DeploymentShaAttribution {
  sha: string | null;
  shaShort: string | null;
  branch: string | null;
  state: DeploymentShaState;
  /** Which env var answered, or null when none did. Never a value, only a name. */
  source: string | null;
  /** True when rows written right now cannot be attributed to a commit. */
  degraded: boolean;
  message: string;
}

const SHA_SOURCES = ["RAILWAY_GIT_COMMIT_SHA", "GIT_COMMIT", "SOURCE_COMMIT"] as const;

export function deploymentShaAttribution(env: NodeJS.ProcessEnv = process.env): DeploymentShaAttribution {
  const source = SHA_SOURCES.find((k) => String(env[k] ?? "").trim()) ?? null;
  const sha = source ? String(env[source]).trim() : null;
  if (!sha) {
    return {
      sha: null, shaShort: null, branch: env.RAILWAY_GIT_BRANCH || null,
      state: "RUNTIME_SHA_UNAVAILABLE", source: null, degraded: true,
      message:
        "This process cannot name its own commit: none of " + SHA_SOURCES.join(", ") + " is set. " +
        "Rows written now are stamped RUNTIME_SHA_UNAVAILABLE, which is NOT the same as legacy data. " +
        "Deploy through the GitHub/main path (which sets RAILWAY_GIT_COMMIT_SHA) rather than `railway up`.",
    };
  }
  return {
    sha, shaShort: sha.slice(0, 7), branch: env.RAILWAY_GIT_BRANCH || null,
    state: "OBSERVED", source, degraded: false,
    message: `commit identity observed from ${source}`,
  };
}

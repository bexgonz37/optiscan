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

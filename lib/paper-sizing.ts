export function paperMinPositionDollars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PAPER_MIN_POSITION_DOLLARS ?? env.PAPER_EXPERIMENTAL_POSITION_DOLLARS ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function paperTargetProfitDollars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PAPER_TARGET_PROFIT_DOLLARS ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function paperExperimentalOversize(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPER_EXPERIMENTAL_OVERSIZE === "1" || paperMinPositionDollars(env) > 0;
}

export function unitsForDollarExposure(input: {
  entryPrice: number;
  minPositionDollars: number;
  multiplier?: number;
  fallbackUnits?: number;
}): number {
  const fallback = Math.max(1, Math.floor(input.fallbackUnits ?? 1));
  const entry = Number(input.entryPrice);
  const target = Number(input.minPositionDollars);
  const multiplier = Number(input.multiplier ?? 1);

  if (!Number.isFinite(entry) || entry <= 0) return fallback;
  if (!Number.isFinite(target) || target <= 0) return fallback;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return fallback;

  const dollarsPerUnit = entry * multiplier;
  if (!Number.isFinite(dollarsPerUnit) || dollarsPerUnit <= 0) return fallback;
  return Math.max(fallback, Math.ceil(target / dollarsPerUnit));
}

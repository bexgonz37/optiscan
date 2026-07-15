const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: string | undefined, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);

export const OPTIONS_CORE_SYMBOLS = Object.freeze([
  "SPY", "QQQ", "NVDA", "AAPL", "META", "TSLA", "AMD", "AMZN", "MSFT", "GOOGL", "NFLX", "AVGO", "IWM", "SPCX",
]);

export interface OptionsChainUsabilityConfig {
  minContracts: number;
  minTwoSidedContracts: number;
  minUsableContracts: number;
  maxSpreadPct: number;
  minVolume: number;
  minOpenInterest: number;
}

export function optionsChainUsabilityConfig(env: NodeJS.ProcessEnv = process.env): OptionsChainUsabilityConfig {
  return {
    minContracts: num(env.OPTIONS_DYNAMIC_MIN_CONTRACTS, 20),
    minTwoSidedContracts: num(env.OPTIONS_DYNAMIC_MIN_TWO_SIDED, 8),
    minUsableContracts: num(env.OPTIONS_DYNAMIC_MIN_USABLE, 3),
    maxSpreadPct: num(env.OPTIONS_DYNAMIC_MAX_SPREAD_PCT, 12),
    minVolume: num(env.OPTIONS_DYNAMIC_MIN_CONTRACT_VOLUME, 100),
    minOpenInterest: num(env.OPTIONS_DYNAMIC_MIN_OPEN_INTEREST, 250),
  };
}

export interface OptionContractLike {
  bid?: number | null;
  ask?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  oi?: number | null;
}

export interface OptionChainLike {
  available?: boolean;
  contracts?: OptionContractLike[] | null;
  options?: OptionContractLike[] | null;
  chain?: OptionContractLike[] | null;
}

export interface OptionsChainUsability {
  usable: boolean;
  reason: string;
  totalContracts: number;
  twoSidedContracts: number;
  usableContracts: number;
}

function contractsFrom(chain: OptionChainLike | OptionContractLike[] | null | undefined): OptionContractLike[] {
  if (Array.isArray(chain)) return chain;
  return chain?.contracts ?? chain?.options ?? chain?.chain ?? [];
}

function spreadPct(c: OptionContractLike): number | null {
  if (!isNum(c.bid) || !isNum(c.ask) || c.bid <= 0 || c.ask < c.bid) return null;
  const mid = (c.bid + c.ask) / 2;
  return mid > 0 ? ((c.ask - c.bid) / mid) * 100 : null;
}

export function summarizeOptionsChainUsability(
  chain: OptionChainLike | OptionContractLike[] | null | undefined,
  cfg: OptionsChainUsabilityConfig = optionsChainUsabilityConfig(),
): OptionsChainUsability {
  const contracts = contractsFrom(chain);
  const totalContracts = contracts.length;
  const twoSidedContracts = contracts.filter((c) => spreadPct(c) != null).length;
  const usableContracts = contracts.filter((c) => {
    const spread = spreadPct(c);
    const oi = c.openInterest ?? c.oi ?? null;
    return spread != null &&
      spread <= cfg.maxSpreadPct &&
      ((isNum(c.volume) && c.volume >= cfg.minVolume) || (isNum(oi) && oi >= cfg.minOpenInterest));
  }).length;

  if (totalContracts < cfg.minContracts) return { usable: false, reason: `contracts ${totalContracts} < ${cfg.minContracts}`, totalContracts, twoSidedContracts, usableContracts };
  if (twoSidedContracts < cfg.minTwoSidedContracts) return { usable: false, reason: `two-sided contracts ${twoSidedContracts} < ${cfg.minTwoSidedContracts}`, totalContracts, twoSidedContracts, usableContracts };
  if (usableContracts < cfg.minUsableContracts) return { usable: false, reason: `usable contracts ${usableContracts} < ${cfg.minUsableContracts}`, totalContracts, twoSidedContracts, usableContracts };
  return { usable: true, reason: "usable options chain", totalContracts, twoSidedContracts, usableContracts };
}

export function isCoreOptionsSymbol(symbol: string | null | undefined): boolean {
  return OPTIONS_CORE_SYMBOLS.includes(String(symbol ?? "").trim().toUpperCase());
}

export function dynamicOptionsSymbolEligible(
  symbol: string,
  chain: OptionChainLike | OptionContractLike[] | null | undefined,
  cfg: OptionsChainUsabilityConfig = optionsChainUsabilityConfig(),
): OptionsChainUsability {
  if (isCoreOptionsSymbol(symbol)) {
    return { usable: true, reason: "core options symbol", totalContracts: 0, twoSidedContracts: 0, usableContracts: 0 };
  }
  return summarizeOptionsChainUsability(chain, cfg);
}

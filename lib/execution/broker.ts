/**
 * broker.ts — the execution boundary (future-broker architecture).
 *
 * THE RULE: the scanner never executes. Anything that fills an order —
 * simulated or real — lives behind this interface. The paper broker is the
 * first adapter; a real broker (e.g. Robinhood MCP) becomes a second adapter
 * later WITHOUT touching scanner, capture, or scoring code.
 *
 * Adapters are deliberately dumb: given an order and a quote, decide the
 * fill. All strategy (when to enter, when to exit, risk) lives outside.
 */

export interface OptionQuote {
  optionSymbol: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadPct: number | null;
  asOfMs: number;
}

export interface LimitOrder {
  side: "buy_to_open" | "sell_to_close";
  optionSymbol: string;
  contracts: number;
  limit: number; // premium per contract share (e.g. 1.20)
}

export interface Fill {
  filled: boolean;
  price: number | null;
  reason: string;
}

export interface Broker {
  readonly name: string;
  /** True = simulation. Real adapters return false and are gated elsewhere. */
  readonly paper: boolean;
  /** Attempt to fill a limit order against the current quote. */
  tryFill(order: LimitOrder, quote: OptionQuote): Fill;
}

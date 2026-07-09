/**
 * paper-broker.ts — simulated limit-order fills (paper trading v1).
 *
 * Fill model (deliberately CONSERVATIVE so paper results understate rather
 * than flatter — the whole point is building trust before real money):
 *
 *  - buy_to_open fills only when the ASK is at/below the limit, at the ask
 *    (you pay the offer; mid-fills are a fantasy for retail market orders).
 *  - sell_to_close fills only when the BID is at/above the limit, at the bid.
 *  - No fills on one-sided/crossed/absent quotes.
 *  - Stops are simulated as "stop-limit at the touch": when triggered, the
 *    exit fills at the current bid (documented slippage model).
 *
 * Limit orders only — market orders are not simulated (per requirements).
 */

import type { Broker, Fill, LimitOrder, OptionQuote } from "./broker.ts";

function quoteUsable(q: OptionQuote): boolean {
  return q.bid != null && q.ask != null && q.bid > 0 && q.ask > 0 && q.ask >= q.bid;
}

export class PaperBroker implements Broker {
  readonly name = "paper";
  readonly paper = true;

  tryFill(order: LimitOrder, quote: OptionQuote): Fill {
    if (!quoteUsable(quote)) {
      return { filled: false, price: null, reason: "no usable two-sided quote" };
    }
    if (order.contracts <= 0) {
      return { filled: false, price: null, reason: "invalid contract count" };
    }
    if (order.side === "buy_to_open") {
      if ((quote.ask as number) <= order.limit) {
        return { filled: true, price: quote.ask, reason: `ask ${quote.ask} <= limit ${order.limit}` };
      }
      return { filled: false, price: null, reason: `ask ${quote.ask} above limit ${order.limit}` };
    }
    // sell_to_close
    if ((quote.bid as number) >= order.limit) {
      return { filled: true, price: quote.bid, reason: `bid ${quote.bid} >= limit ${order.limit}` };
    }
    return { filled: false, price: null, reason: `bid ${quote.bid} below limit ${order.limit}` };
  }

  /** Stop exit: triggered stops leave at the bid (documented slippage model). */
  stopFill(quote: OptionQuote): Fill {
    if (!quoteUsable(quote)) return { filled: false, price: null, reason: "no usable quote for stop" };
    return { filled: true, price: quote.bid, reason: "stop triggered — filled at bid" };
  }
}

export const paperBroker = new PaperBroker();

/**
 * B3 equity reconciliation checks — prove dollar identity and P&L transfer rules.
 */
import { roundMoney } from "./ledger.ts";
import type { AccountEquity } from "./equity.ts";
import { computeAccountEquity } from "./equity.ts";
import type { BrokerDb } from "./audit.ts";

export interface ReconciliationCheck {
  name: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
  detail?: string;
}

export interface ReconciliationReport {
  ok: boolean;
  checks: ReconciliationCheck[];
  equity: AccountEquity;
}

const TOL = 0.02;

function near(a: number, b: number, tol = TOL): boolean {
  return Math.abs(a - b) <= tol;
}

export function reconcileAccountEquity(equity: AccountEquity): ReconciliationCheck[] {
  const checks: ReconciliationCheck[] = [];

  const identity = roundMoney(equity.cash + equity.grossPositionValue);
  checks.push({
    name: "equity_equals_cash_plus_marked_positions",
    ok: near(equity.totalEquity, identity),
    expected: identity,
    actual: equity.totalEquity,
    detail: "totalEquity = cash + grossPositionValue",
  });

  checks.push({
    name: "buying_power_equals_cash_minus_reserved",
    ok: near(equity.buyingPower, roundMoney(equity.cash - equity.reserved)),
    expected: roundMoney(equity.cash - equity.reserved),
    actual: equity.buyingPower,
  });

  const sumMv = roundMoney(equity.positions.reduce((s, p) => s + p.marketValueDollars, 0));
  checks.push({
    name: "positions_aggregate_to_gross_value",
    ok: near(sumMv, equity.grossPositionValue),
    expected: equity.grossPositionValue,
    actual: sumMv,
  });

  const sumUpnl = roundMoney(equity.positions.reduce((s, p) => s + p.unrealizedPnlDollars, 0));
  checks.push({
    name: "positions_aggregate_to_unrealized",
    ok: near(sumUpnl, equity.unrealizedPnl),
    expected: equity.unrealizedPnl,
    actual: sumUpnl,
  });

  checks.push({
    name: "missing_marks_never_silently_complete",
    ok: equity.missingMarkCount === 0 || equity.completeness !== "COMPLETE",
    expected: "INCOMPLETE or PARTIAL when marks missing",
    actual: equity.completeness,
    detail: `missingMarkCount=${equity.missingMarkCount}`,
  });

  checks.push({
    name: "high_water_mark_not_below_equity",
    ok: equity.highWaterMark + TOL >= equity.totalEquity,
    expected: `>= ${equity.totalEquity}`,
    actual: equity.highWaterMark,
  });

  for (const p of equity.positions) {
    if (p.markStatus === "WORTHLESS") {
      checks.push({
        name: `worthless_mark_zero:${p.symbol}`,
        ok: p.marketPrice === 0 && p.marketValueDollars === 0,
        expected: 0,
        actual: p.marketPrice,
      });
    }
    if (p.markStatus === "MISSING" || p.markStatus === "ONE_SIDED") {
      checks.push({
        name: `missing_mark_excludes_value:${p.symbol}`,
        ok: p.marketValueDollars === 0 && p.marketPrice == null,
        expected: "null mark / 0 value",
        actual: { mark: p.marketPrice, mv: p.marketValueDollars },
        detail: "stale/missing quotes must not invent equity",
      });
    }
  }

  return checks;
}

export function reconcileAccountOnDb(db: BrokerDb, accountId: string): ReconciliationReport {
  const equity = computeAccountEquity(db, accountId);
  const checks = reconcileAccountEquity(equity);
  return { ok: checks.every((c) => c.ok), checks, equity };
}

/**
 * Closing a long position: unrealized becomes realized; total equity changes only by
 * fill vs prior mark (slippage) and fees — not by a bookkeeping transfer alone.
 */
export function reconcileCloseTransfer(input: {
  equityBefore: number;
  equityAfter: number;
  unrealizedBefore: number;
  realizedBefore: number;
  realizedAfter: number;
  fillSlippageDollars: number;
  feesDollars: number;
}): ReconciliationCheck[] {
  const expectedEquityDelta = roundMoney(-(input.fillSlippageDollars + Math.abs(input.feesDollars)));
  // When closing at the prior mark, equity is unchanged except fees; slippage moves equity.
  const actualEquityDelta = roundMoney(input.equityAfter - input.equityBefore);
  const realizedDelta = roundMoney(input.realizedAfter - input.realizedBefore);

  return [
    {
      name: "close_transfers_unrealized_into_realized",
      ok: near(realizedDelta, input.unrealizedBefore - input.fillSlippageDollars, 0.05),
      expected: roundMoney(input.unrealizedBefore - input.fillSlippageDollars),
      actual: realizedDelta,
      detail: "realized increases by prior unrealized adjusted for fill vs mark",
    },
    {
      name: "close_equity_only_moves_by_slippage_and_fees",
      ok: near(actualEquityDelta, expectedEquityDelta, 0.05),
      expected: expectedEquityDelta,
      actual: actualEquityDelta,
    },
  ];
}

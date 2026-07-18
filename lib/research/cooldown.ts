/**
 * lib/research/cooldown.ts — PURE cooldown-scope helper (Phase 3). Takes an explicit
 * db handle (no I/O of its own beyond the query), so it is unit-testable and shared
 * by the paper engine.
 *
 * Cooldown isolation: the most-recent realized-loss timestamp is scoped per portfolio
 * and — when `ticker` is supplied — per symbol. Primary passes no ticker (stricter,
 * account-wide). The independent Challenge/Research lanes pass a ticker so one symbol's
 * loss never freezes unrelated symbols, and a loss in one lane never freezes another.
 */
export function realizedLastLossAtMs(db: any, portfolio: string, ticker?: string | null): number | null {
  const params: any[] = [portfolio];
  let tickerClause = "";
  if (ticker) { tickerClause = " AND ticker=?"; params.push(ticker); }
  const recentClosed = db.prepare(
    `SELECT exit_at_ms, entry_price, exit_price, contracts, option_symbol, option_type FROM paper_trades
     WHERE exit_at_ms IS NOT NULL AND entry_price IS NOT NULL AND exit_price IS NOT NULL AND COALESCE(portfolio,'PRIMARY')=?${tickerClause}
     ORDER BY exit_at_ms DESC LIMIT 20`,
  ).all(...params) as any[];
  const lastLoss = recentClosed.find((r) => {
    const multiplier = r.option_symbol ? 100 : 1;
    const direction = !r.option_symbol && r.option_type === "put" ? -1 : 1;
    return (r.exit_price - r.entry_price) * direction * multiplier * (r.contracts ?? 1) < 0;
  });
  return lastLoss?.exit_at_ms ?? null;
}

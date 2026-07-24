import { createEvidenceChain } from "../evidence.ts";
import { openAccount, submitOrder, fillOrder, applyMark } from "../engine.ts";
import { storeMarketSnapshot } from "../market-snapshot.ts";
import type { BrokerAdapter, BrokerAdapterContext, BrokerFillResult, LimitFillRequest } from "./contract.ts";
import type { ApplyMarkInput, OpenAccountInput, SubmitOrderInput } from "../types.ts";
import type { BrokerDb } from "../audit.ts";

export class PaperSimBrokerAdapter implements BrokerAdapter {
  readonly name = "paper_sim";
  readonly kind = "PAPER_SIM" as const;
  readonly paper = true;

  openAccount(ctx: BrokerAdapterContext, input: OpenAccountInput): { accountId: string } {
    const db = ctx.db as BrokerDb;
    return openAccount(db, input);
  }

  submitOrder(
    ctx: BrokerAdapterContext,
    input: SubmitOrderInput & { marketSnapshotId?: string },
  ) {
    const db = ctx.db as BrokerDb;
    return submitOrder(db, input);
  }

  fillOrder(
    ctx: BrokerAdapterContext,
    input: Parameters<typeof fillOrder>[1] & { marketSnapshotId?: string },
  ): BrokerFillResult {
    const db = ctx.db as BrokerDb;
    const result = fillOrder(db, input);
    return { ...result, orderId: input.orderId };
  }

  applyMark(
    ctx: BrokerAdapterContext,
    input: ApplyMarkInput & { marketSnapshotId?: string },
  ) {
    const db = ctx.db as BrokerDb;
    return applyMark(db, input);
  }

  /** Convenience: evidence chain + market snapshot + reserve + immediate fill. */
  mirrorLimitFill(ctx: BrokerAdapterContext, req: LimitFillRequest & { marketSnapshotId?: string }) {
    const db = ctx.db as BrokerDb;
    const marketSnapshotId =
      req.marketSnapshotId ??
      (req.marketSnapshot ? storeMarketSnapshot(db, { ...req.marketSnapshot, accountId: req.accountId }).id : undefined);
    const evidenceChainId =
      req.evidenceChainId ??
      createEvidenceChain(db, {
        chainJson: {
          symbol: req.symbol,
          assetClass: req.assetClass,
          side: req.side,
          limitPrice: req.limitPrice,
          marketSnapshotId,
        },
      }).id;
    const order = this.submitOrder(ctx, {
      accountId: req.accountId,
      clientOrderKey: req.clientOrderKey,
      evidenceChainId: evidenceChainId,
      assetClass: req.assetClass,
      symbol: req.symbol,
      side: req.side,
      quantity: req.quantity,
      limitPrice: req.limitPrice,
      contractMultiplier: req.contractMultiplier,
      metadata: { marketSnapshotId },
    });
    const fill = this.fillOrder(ctx, {
      orderId: order.orderId,
      fillKey: req.fillKey,
      quantity: req.quantity,
      price: req.limitPrice,
      commission: req.commission,
      fees: req.fees,
      filledAtMs: req.filledAtMs,
      metadata: { marketSnapshotId },
    });
    return { ...fill, orderId: order.orderId, evidenceChainId, marketSnapshotId };
  }
}

export const paperSimBrokerAdapter = new PaperSimBrokerAdapter();

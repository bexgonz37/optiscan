import { handlePaperBrokerV2Get } from "@/lib/broker/paper-api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Research / Brokerage V2 — evidence-chain drill-down.
 * Query: ?evidenceChainId=bev_… or ?id=bev_…
 * Disabled when PAPER_BROKER_V2_ENABLED=0.
 */
export async function GET(req: Request) {
  return handlePaperBrokerV2Get(req, "evidence");
}

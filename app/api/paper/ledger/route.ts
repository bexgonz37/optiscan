import { handlePaperBrokerV2Get } from "@/lib/broker/paper-api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Research / Brokerage V2 — append-only ledger. Disabled when PAPER_BROKER_V2_ENABLED=0. */
export async function GET(req: Request) {
  return handlePaperBrokerV2Get(req, "ledger");
}

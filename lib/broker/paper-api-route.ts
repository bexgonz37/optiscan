/**
 * Shared Next.js route helper for B4 /api/paper/* brokerage V2 endpoints.
 */
import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";
import { paperBrokerV2Enabled } from "./flags.ts";
import { brokerV2DisabledPayload, BROKER_V2_SURFACE_LABEL } from "./surface.ts";
import {
  buildAccountSummary,
  buildEvidenceDrilldown,
  buildEquityCurvePayload,
  buildFillsPayload,
  buildLedgerPayload,
  buildOrdersPayload,
  buildPositionsPayload,
  buildStatsPayload,
  listBrokerAccounts,
  parsePaperApiFilters,
  resolveBrokerAccount,
  type PaperApiFilters,
} from "./paper-read.ts";
import type { BrokerDb } from "./audit.ts";

export type PaperBrokerResource =
  | "account"
  | "positions"
  | "orders"
  | "fills"
  | "ledger"
  | "equity-curve"
  | "stats"
  | "evidence";

const JSON_HEADERS = { "content-type": "application/json" } as const;

function disabledResponse() {
  return NextResponse.json(brokerV2DisabledPayload(), { status: 200, headers: JSON_HEADERS });
}

function noAccountResponse(filters: PaperApiFilters) {
  return NextResponse.json(
    {
      ok: true,
      enabled: true,
      label: BROKER_V2_SURFACE_LABEL,
      authoritative: false,
      empty: true,
      error: "No broker V2 account matched filters",
      filters,
    },
    { status: 200, headers: JSON_HEADERS },
  );
}

export async function handlePaperBrokerV2Get(
  req: Request,
  resource: PaperBrokerResource,
): Promise<Response> {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();

  try {
    if (!paperBrokerV2Enabled(process.env)) {
      return disabledResponse();
    }

    const { getDb } = await import("@/lib/db");
    const { ensureBrokerSchemaOnDb } = await import("./schema-migrate.ts");
    const db = getDb() as unknown as BrokerDb;
    ensureBrokerSchemaOnDb(db as never);

    const url = new URL(req.url);
    const filters = parsePaperApiFilters(url);

    if (resource === "evidence") {
      const id =
        filters.evidenceChainId ||
        url.searchParams.get("id") ||
        url.pathname.split("/").filter(Boolean).pop();
      if (!id || id === "evidence") {
        return NextResponse.json(
          {
            ok: false,
            enabled: true,
            label: BROKER_V2_SURFACE_LABEL,
            error: "evidenceChainId (or id) is required",
          },
          { status: 400, headers: JSON_HEADERS },
        );
      }
      const drilldown = buildEvidenceDrilldown(db, id);
      if (!drilldown) {
        return NextResponse.json(
          {
            ok: false,
            enabled: true,
            label: BROKER_V2_SURFACE_LABEL,
            error: "evidence chain not found",
            evidenceChainId: id,
          },
          { status: 404, headers: JSON_HEADERS },
        );
      }
      return NextResponse.json(
        { ok: true, enabled: true, ...drilldown },
        { status: 200, headers: JSON_HEADERS },
      );
    }

    if (resource === "account" && url.searchParams.get("list") === "1") {
      const accounts = listBrokerAccounts(db, filters).map((a) => ({
        id: a.id,
        accountKey: a.account_key,
        accountType: a.account_type,
        displayName: a.display_name,
        status: a.status,
      }));
      return NextResponse.json(
        {
          ok: true,
          enabled: true,
          label: BROKER_V2_SURFACE_LABEL,
          authoritative: false,
          accounts,
        },
        { status: 200, headers: JSON_HEADERS },
      );
    }

    const account = resolveBrokerAccount(db, filters);
    if (!account) return noAccountResponse(filters);

    let payload: Record<string, unknown>;
    switch (resource) {
      case "account":
        payload = buildAccountSummary(db, account, process.env);
        break;
      case "positions":
        payload = buildPositionsPayload(db, account, filters);
        break;
      case "orders":
        payload = buildOrdersPayload(db, account, filters);
        break;
      case "fills":
        payload = buildFillsPayload(db, account, filters);
        break;
      case "ledger":
        payload = buildLedgerPayload(db, account, filters);
        break;
      case "equity-curve":
        payload = buildEquityCurvePayload(db, account, filters);
        break;
      case "stats":
        payload = buildStatsPayload(db, account, process.env, filters);
        break;
      default:
        return NextResponse.json(
          { ok: false, error: `Unknown resource: ${resource}` },
          { status: 404, headers: JSON_HEADERS },
        );
    }

    return NextResponse.json(
      { ok: true, enabled: true, source: "V2", ...payload },
      { status: 200, headers: JSON_HEADERS },
    );
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

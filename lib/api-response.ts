import { NextResponse } from "next/server";
import { classifyRouteError, type ApiErrorBody, type ApiErrorCode } from "@/lib/api-error";

export type { ApiErrorBody, ApiErrorCode };

const JSON_HEADERS = { "content-type": "application/json" } as const;

export function jsonApiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  extra?: Record<string, unknown>,
) {
  const body: ApiErrorBody = { ok: false, error: { code, message }, ...extra };
  return NextResponse.json(body, { status, headers: JSON_HEADERS });
}

export function jsonApiSuccess<T extends Record<string, unknown>>(payload: T, status = 200) {
  return NextResponse.json({ ok: true, ...payload }, { status, headers: JSON_HEADERS });
}

export { classifyRouteError } from "@/lib/api-error";

export function jsonFromRouteError(err: unknown, extra?: Record<string, unknown>) {
  const { status, code, message } = classifyRouteError(err);
  return jsonApiError(status, code, message, extra);
}

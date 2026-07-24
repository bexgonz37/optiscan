export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "SCHEMA_MISMATCH"
  | "DATABASE_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "BAD_REQUEST";

export interface ApiErrorBody {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
  };
  requestId?: string;
}

/** Map thrown errors to a safe, bounded JSON error without leaking secrets. */
export function classifyRouteError(err: unknown): { status: number; code: ApiErrorCode; message: string } {
  const msg = String((err as Error)?.message ?? err ?? "Internal error");
  const lower = msg.toLowerCase();
  if (/no such table|no such column|schema mismatch|sqlite_error.*opportunity_cases/.test(lower)) {
    return {
      status: 503,
      code: "SCHEMA_MISMATCH",
      message: "Database schema is missing required tables. Apply pending migrations.",
    };
  }
  if (/better-sqlite3|database is locked|unable to open|sql/i.test(lower)) {
    return {
      status: 503,
      code: "DATABASE_UNAVAILABLE",
      message: "Database unavailable.",
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: msg.slice(0, 200),
  };
}

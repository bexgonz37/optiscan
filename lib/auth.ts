import { timingSafeEqual } from "node:crypto";

/**
 * Optional single-token gate for the scan API.
 *
 * Set SCAN_API_TOKEN in .env.local (generate: openssl rand -hex 24) and every
 * /api/scan/* request must carry it as the x-scan-token header or
 * Authorization: Bearer. Query-string ?token= is deliberately NOT accepted —
 * tokens in URLs leak into access logs, browser history, and Referer headers
 * (audit P0-3). Unset = open, as before. The UI reads the token from
 * localStorage("optiscan:token") and sends it as a header.
 *
 * Scope: this stops drive-by quota burn if the URL leaks. It is NOT user auth —
 * anyone you give the page + token to has full access. For a truly public
 * deploy put real auth (Vercel protection, Cloudflare Access, a reverse-proxy
 * basic-auth) in front instead of growing this.
 */
export function checkApiToken(req: Request): boolean {
  const expected = process.env.SCAN_API_TOKEN;
  if (!expected) return true;
  const got =
    req.headers.get("x-scan-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function unauthorized() {
  // Owner-facing message only, with no developer or storage-key hints — the
  // frontend detects the 401 `code` and opens the "Unlock OptiScan" prompt.
  return new Response(
    JSON.stringify({
      ok: false,
      code: "unauthorized",
      error: "This dashboard needs your private OptiScan access token.",
      signals: [],
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

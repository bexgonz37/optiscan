import { timingSafeEqual } from "node:crypto";

/**
 * Optional single-token gate for the scan API.
 *
 * Set SCAN_API_TOKEN in .env.local and every /api/scan/* request must carry it
 * (x-scan-token header, Authorization: Bearer, or ?token=). Unset = open, as
 * before. The UI reads the token from localStorage("optiscan:token").
 *
 * Scope: this stops drive-by quota burn if the URL leaks. It is NOT user auth —
 * anyone you give the page + token to has full access. For a truly public
 * deploy put real auth (Vercel protection, Cloudflare Access, a reverse-proxy
 * basic-auth) in front instead of growing this.
 */
export function checkApiToken(req: Request): boolean {
  const expected = process.env.SCAN_API_TOKEN;
  if (!expected) return true;
  const url = new URL(req.url);
  const got =
    req.headers.get("x-scan-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    url.searchParams.get("token") ??
    "";
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function unauthorized() {
  return new Response(
    JSON.stringify({ ok: false, error: "unauthorized: missing or bad token (set localStorage 'optiscan:token')", signals: [] }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

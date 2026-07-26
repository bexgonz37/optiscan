import { checkApiToken, unauthorized } from "@/lib/auth";

/** Require owner token on API routes. Returns unauthorized Response or null if OK. */
export function requireApiToken(req: Request): Response | null {
  if (!checkApiToken(req)) return unauthorized();
  return null;
}

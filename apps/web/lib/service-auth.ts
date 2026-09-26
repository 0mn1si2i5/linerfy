import { createHash, timingSafeEqual } from "node:crypto";

function bearerToken(header: string | null | undefined): string {
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Authorize Pox without granting it a Supabase user or service-role token. */
export function isPoxServiceAuthorized(
  authorization: string | null | undefined,
  expectedToken = process.env.LINERFY_POX_SERVICE_TOKEN ?? "",
): boolean {
  const providedToken = bearerToken(authorization);
  const matches = timingSafeEqual(digest(providedToken), digest(expectedToken));
  return providedToken.length > 0 && expectedToken.length > 0 && matches;
}

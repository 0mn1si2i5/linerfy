/**
 * GitHub OAuth via Supabase Auth, driven entirely from the Electron main
 * process. The renderer never touches the session: it only asks main to
 * "sign in" and observes a minimal signed-in/signed-out state.
 *
 * Flow (PKCE, per Supabase Auth):
 *   1. generate a code_verifier + S256 code_challenge,
 *   2. open the system browser to the authorize URL,
 *   3. capture the redirect code on a loopback server on 127.0.0.1,
 *   4. exchange the code for a session with the token endpoint,
 *   5. hand the session back to main, which encrypts it via safeStorage.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

/** The subset of the Supabase session main persists (encrypted) in the store. */
export interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
}

export interface OAuthConfig {
  /** Supabase project URL, e.g. https://<ref>.supabase.co */
  url: string;
  /** The publishable (anon) key — enough to run the auth flow, not to read RLS-guarded rows. */
  anonKey: string;
  provider: "github";
  /** Loopback port for the redirect; must be allow-listed in Supabase Auth. */
  redirectPort?: number;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const AUTH_REQUEST_TIMEOUT_MS = 8_000;

function sessionExpiry(data: {
  expires_at?: number;
  expires_in?: number;
}): number | undefined {
  if (typeof data.expires_at === "number" && Number.isFinite(data.expires_at)) {
    return data.expires_at;
  }
  if (
    typeof data.expires_in === "number" &&
    Number.isFinite(data.expires_in) &&
    data.expires_in > 0
  ) {
    return Math.floor(Date.now() / 1000) + data.expires_in;
  }
  return undefined;
}

function base64Url(input: Buffer): string {
  return input.toString("base64url");
}

/** A PKCE S256 verifier/challenge pair, random on every call. */
export function generatePkce(): PkcePair {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** The authorize URL the system browser is sent to. */
export function authorizeUrl(
  config: OAuthConfig,
  redirectTo: string,
  challenge: string,
): string {
  const params = new URLSearchParams({
    provider: config.provider,
    redirect_to: redirectTo,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${config.url.replace(/\/+$/, "")}/auth/v1/authorize?${params}`;
}

/** Exchange the authorization code for a session (GoTrue PKCE grant). */
export async function exchangeCodeForSession(
  config: OAuthConfig,
  code: string,
  verifier: string,
  fetcher: Fetcher = fetch,
): Promise<SupabaseSession> {
  const res = await fetcher(
    `${config.url.replace(/\/+$/, "")}/auth/v1/token?grant_type=pkce`,
    {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    throw new Error(`token exchange failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    expires_in?: number;
  };
  if (!data.access_token || !data.refresh_token) {
    throw new Error("token exchange returned no session");
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: sessionExpiry(data),
  };
}

/** The refresh token was rejected: the stored session is invalid/revoked. */
export class InvalidRefreshTokenError extends Error {}

/** Refresh an expired access token using the persisted refresh token (GoTrue). */
export async function refreshSession(
  config: OAuthConfig,
  refreshToken: string,
  fetcher: Fetcher = fetch,
): Promise<SupabaseSession> {
  const res = await fetcher(
    `${config.url.replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    // A 400/401 is a definitive rejection of the refresh token (cleared by the
    // caller); a 5xx/429 is transient and must not clear a stored session.
    if (res.status === 400 || res.status === 401) {
      throw new InvalidRefreshTokenError(
        `token refresh failed: HTTP ${res.status}`,
      );
    }
    throw new Error(`token refresh failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error("token refresh returned no access token");
  }
  return {
    access_token: data.access_token,
    // Supabase may rotate the refresh token on refresh; keep the new one.
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at: sessionExpiry(data),
  };
}

export interface CallbackServer {
  port: number;
  /**
   * Resolve with the authorization code once the redirect arrives, after
   * validating the one-time PKCE code during exchange. Supabase owns the
   * provider-facing OAuth `state` parameter and does not return a caller-
   * supplied value to this loopback redirect.
   */
  waitForCallback(timeoutMs?: number): Promise<string>;
  close(): void;
}

interface CallbackPayload {
  code: string;
}

/**
 * A loopback HTTP server on 127.0.0.1 that captures the OAuth redirect. It
 * answers the callback with a short "you may close this tab" page, so the code
 * lands back in the main process only.
 */
export function startCallbackServer(port = 0): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let settle: (payload: CallbackPayload) => void = () => {};
    const payloadPromise = new Promise<CallbackPayload>((res) => {
      settle = res;
    });

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const ok = Boolean(code);
        res.writeHead(ok ? 200 : 400, {
          "Content-Type": "text/html; charset=utf-8",
        });
        res.end(
          '<!doctype html><meta charset="utf-8"><title>Linerfy</title>' +
            (ok
              ? "<p>登录完成，可以关闭此窗口。</p>"
              : "<p>登录失败，请返回 Linerfy 重试。</p>"),
        );
        if (!settled) {
          settled = true;
          settle({ code: code ?? "" });
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        waitForCallback(timeoutMs = 120_000) {
          return new Promise<string>((res, rej) => {
            const timer = setTimeout(() => {
              if (!settled) {
                settled = true;
                rej(new Error("login timed out"));
              }
            }, timeoutMs);
            void payloadPromise.then(
              (payload) => {
                clearTimeout(timer);
                if (!payload.code) {
                  rej(new Error("authorization returned no code"));
                } else {
                  res(payload.code);
                }
              },
              () => {
                clearTimeout(timer);
                rej(new Error("login failed"));
              },
            );
          });
        },
        close() {
          server.close();
        },
      });
    });
  });
}

/** Run the whole flow and return the session, or throw on any failure. */
export async function performOAuthFlow(
  config: OAuthConfig,
  openExternal: (url: string) => Promise<void>,
  fetcher: Fetcher = fetch,
): Promise<SupabaseSession> {
  const { verifier, challenge } = generatePkce();
  const server = await startCallbackServer(config.redirectPort ?? 4862);
  try {
    const redirectTo = `http://127.0.0.1:${server.port}/callback`;
    await openExternal(authorizeUrl(config, redirectTo, challenge));
    const code = await server.waitForCallback();
    return await exchangeCodeForSession(config, code, verifier, fetcher);
  } finally {
    server.close();
  }
}

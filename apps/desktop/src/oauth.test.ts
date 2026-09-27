import { get } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizeUrl,
  exchangeCodeForSession,
  generatePkce,
  InvalidRefreshTokenError,
  refreshSession,
  startCallbackServer,
} from "./oauth";

const config = {
  url: "https://rcrtpapxhkqkobjcqxkd.supabase.co",
  anonKey: "anon-key",
  provider: "github",
} as const;

it.each(["exchange", "refresh"] as const)(
  "normalizes expires_in for %s so valid sessions can be reused",
  async (operation) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const fetcher = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "test-access",
              refresh_token: "test-refresh",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
      );
      const result =
        operation === "exchange"
          ? await exchangeCodeForSession(
              config,
              "test-code",
              "test-verifier",
              fetcher,
            )
          : await refreshSession(config, "test-refresh", fetcher);
      expect(result.expires_at).toBe(1_700_003_600);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  },
);

describe("generatePkce", () => {
  it("produces a base64url verifier and its S256 challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it("is random per call", () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("authorizeUrl", () => {
  it("points at the Supabase authorize endpoint with PKCE params", () => {
    const url = authorizeUrl(
      config,
      "http://127.0.0.1:4000/callback",
      "challenge",
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://rcrtpapxhkqkobjcqxkd.supabase.co/auth/v1/authorize",
    );
    expect(parsed.searchParams.get("provider")).toBe("github");
    expect(parsed.searchParams.get("redirect_to")).toBe(
      "http://127.0.0.1:4000/callback",
    );
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.has("state")).toBe(false);
  });
});

describe("exchangeCodeForSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges the code via the pkce grant and returns the session", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            access_token: "at",
            refresh_token: "rt",
            expires_at: 123,
          }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const session = await exchangeCodeForSession(config, "code", "verifier");
    expect(session).toEqual({
      access_token: "at",
      refresh_token: "rt",
      expires_at: 123,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(
      "https://rcrtpapxhkqkobjcqxkd.supabase.co/auth/v1/token?grant_type=pkce",
    );
    expect(init.headers.apikey).toBe("anon-key");
    expect(JSON.parse(init.body)).toEqual({
      auth_code: "code",
      code_verifier: "verifier",
    });
  });

  it("throws on a non-2xx token response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400 }) as unknown as Response),
    );
    await expect(
      exchangeCodeForSession(config, "code", "verifier"),
    ).rejects.toThrow(/HTTP 400/);
  });
});

describe("startCallbackServer", () => {
  it("captures the authorization code", async () => {
    const server = await startCallbackServer();
    try {
      const pending = server.waitForCallback(5000);
      await new Promise<void>((resolve, reject) => {
        const req = get(
          `http://127.0.0.1:${server.port}/callback?code=abc123`,
          (res) => {
            res.resume();
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
      });
      await expect(pending).resolves.toBe("abc123");
    } finally {
      server.close();
    }
  });

  it("rejects a redirect without a code", async () => {
    const server = await startCallbackServer();
    try {
      const pending = server.waitForCallback(5000);
      // Attach the rejection handler before the redirect arrives so the
      // rejection is observed, not reported as an unhandled promise rejection.
      const assertion = expect(pending).rejects.toThrow(/no code/);
      await new Promise<void>((resolve, reject) => {
        const req = get(`http://127.0.0.1:${server.port}/callback`, (res) => {
          expect(res.statusCode).toBe(400);
          res.resume();
          res.on("end", () => resolve());
        });
        req.on("error", reject);
      });
      await assertion;
    } finally {
      server.close();
    }
  });
});

describe("refreshSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges a refresh token for a fresh session", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            access_token: "new-at",
            refresh_token: "new-rt",
            expires_at: 456,
          }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const session = await refreshSession(config, "old-rt");
    expect(session).toEqual({
      access_token: "new-at",
      refresh_token: "new-rt",
      expires_at: 456,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe(
      "https://rcrtpapxhkqkobjcqxkd.supabase.co/auth/v1/token?grant_type=refresh_token",
    );
    expect(JSON.parse(init.body)).toEqual({ refresh_token: "old-rt" });
  });

  it("keeps the old refresh token when the server does not rotate it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({ access_token: "new-at", expires_at: 456 }),
          }) as unknown as Response,
      ),
    );

    const session = await refreshSession(config, "old-rt");
    expect(session.refresh_token).toBe("old-rt");
  });

  it("throws on a non-2xx refresh response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400 }) as unknown as Response),
    );
    await expect(refreshSession(config, "old-rt")).rejects.toThrow(/HTTP 400/);
  });

  it("types only a definitive token rejection, not a transient one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response),
    );
    await expect(refreshSession(config, "old-rt")).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response),
    );
    const transient = refreshSession(config, "old-rt");
    await expect(transient).rejects.toThrow(/HTTP 503/);
    await expect(transient).rejects.not.toBeInstanceOf(
      InvalidRefreshTokenError,
    );
  });
});

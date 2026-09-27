import type { NowPlayingTrack } from "@linerfy/now-playing";
import { describe, expect, it, vi } from "vitest";

import {
  createContextClient,
  type ContextClientOptions,
} from "./context-client";

const track: NowPlayingTrack = {
  provider: "spotify",
  title: "Song",
  artist: "Artist",
  album: "Album",
  state: "playing",
};

function setup() {
  const fetcher = vi.fn<ContextClientOptions["fetcher"]>();
  const getSession = vi.fn(async () => ({ access_token: "old-token" }));
  const refreshSession = vi.fn(async () => ({ access_token: "fresh-token" }));
  const onUnauthorized = vi.fn();
  const client = createContextClient({
    apiUrl: "https://example.test/",
    fetcher,
    getSession,
    refreshSession,
    onUnauthorized,
  });
  return { client, fetcher, getSession, refreshSession, onUnauthorized };
}

describe("context client", () => {
  it("refreshes a 401 once and preserves the request's explicit retry intent", async () => {
    const { client, fetcher, refreshSession, onUnauthorized } = setup();
    fetcher
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ status: "unavailable" }));
    const signal = new AbortController().signal;
    await expect(client(track, signal, true)).resolves.toEqual({
      status: "ok",
      body: { status: "unavailable" },
    });
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenLastCalledWith(
      "https://example.test/api/context",
      expect.objectContaining({
        signal,
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-token",
        }),
        body: JSON.stringify({ ...track, retry: true }),
      }),
    );
  });

  it("clears an access session only after the refreshed request also returns 401", async () => {
    const { client, fetcher, onUnauthorized } = setup();
    fetcher.mockImplementation(async () => new Response(null, { status: 401 }));
    await expect(client(track, new AbortController().signal)).resolves.toEqual({
      status: "unauthorized",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "keeps a forbidden session without another refresh (after401=%s)",
    async (after401) => {
      const { client, fetcher, refreshSession, onUnauthorized } = setup();
      if (after401)
        fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
      fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
      await expect(
        client(track, new AbortController().signal),
      ).resolves.toEqual({
        status: "forbidden",
      });
      expect(refreshSession).toHaveBeenCalledTimes(after401 ? 1 : 0);
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );

  it.each([429, 503])(
    "reports HTTP %s as a service failure",
    async (statusCode) => {
      const { client, fetcher, refreshSession, onUnauthorized } = setup();
      fetcher.mockResolvedValueOnce(new Response(null, { status: statusCode }));
      await expect(
        client(track, new AbortController().signal),
      ).resolves.toEqual({
        status: "service-error",
        statusCode,
        retryable: statusCode === 429 || statusCode >= 500,
      });
      expect(refreshSession).not.toHaveBeenCalled();
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new DOMException("aborted", "AbortError"), "timeout"],
    [new TypeError("connection reset"), "network-error"],
    [new SyntaxError("invalid JSON"), "invalid"],
  ] as const)(
    "classifies response-body failure %s as %s",
    async (error, status) => {
      const { client, fetcher } = setup();
      const response = Response.json({ status: "unavailable" });
      vi.spyOn(response, "json").mockRejectedValueOnce(error);
      fetcher.mockResolvedValueOnce(response);
      await expect(
        client(track, new AbortController().signal),
      ).resolves.toEqual({ status });
    },
  );

  it("rejects invalid successful response shapes", async () => {
    const { client, fetcher } = setup();
    fetcher.mockResolvedValueOnce(Response.json({ status: "ready" }));
    await expect(client(track, new AbortController().signal)).resolves.toEqual({
      status: "invalid",
    });
  });

  it("does not mark a permanent client error as retryable", async () => {
    const { client, fetcher } = setup();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(client(track, new AbortController().signal)).resolves.toEqual({
      status: "service-error",
      statusCode: 400,
      retryable: false,
    });
  });

  it("does not send a request after cancellation while a session is loading", async () => {
    const { client, fetcher, getSession } = setup();
    let resolveSession!: (session: { access_token: string }) => void;
    getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    const controller = new AbortController();
    const pending = client(track, controller.signal);
    controller.abort();
    resolveSession({ access_token: "late-token" });
    await expect(pending).resolves.toEqual({ status: "timeout" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not clear the session when refreshing fails transiently", async () => {
    const { client, fetcher, refreshSession, onUnauthorized } = setup();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
    refreshSession.mockRejectedValueOnce(new TypeError("connection reset"));
    await expect(client(track, new AbortController().signal)).resolves.toEqual({
      status: "network-error",
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

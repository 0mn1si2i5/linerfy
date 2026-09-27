import type { ContextFetch, FetchOutcome } from "./context-engine";
import { parseContextApiResponse } from "./context-state";

interface AccessSession {
  access_token: string;
}

export interface ContextClientOptions {
  apiUrl: string;
  fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  getSession: () => Promise<AccessSession | null>;
  refreshSession: () => Promise<AccessSession | null>;
  onUnauthorized: () => void;
}

function transportFailure(signal: AbortSignal, error: unknown): FetchOutcome {
  return signal.aborted ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
    ? { status: "timeout" }
    : { status: "network-error" };
}

/** Authenticated context requests, with no Electron or persisted-token access. */
export function createContextClient(
  options: ContextClientOptions,
): ContextFetch {
  return async (track, signal, retry = false) => {
    if (signal.aborted) return { status: "timeout" };
    if (!options.apiUrl) return { status: "unauthorized" };

    try {
      const session = await options.getSession();
      if (signal.aborted) return { status: "timeout" };
      if (!session) return { status: "unauthorized" };

      const post = (token: string) =>
        options.fetcher(`${options.apiUrl.replace(/\/+$/, "")}/api/context`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            provider: track.provider,
            title: track.title,
            artist: track.artist,
            album: track.album,
            state: track.state,
            retry,
          }),
          signal,
        });

      let response = await post(session.access_token);
      if (signal.aborted) return { status: "timeout" };
      // Forbidden is an authorization decision, not an expired access token.
      if (response.status === 403) return { status: "forbidden" };
      if (response.status === 401) {
        const refreshed = await options.refreshSession();
        if (signal.aborted) return { status: "timeout" };
        if (!refreshed) return { status: "unauthorized" };
        response = await post(refreshed.access_token);
        if (signal.aborted) return { status: "timeout" };
        if (response.status === 401) {
          options.onUnauthorized();
          return { status: "unauthorized" };
        }
        if (response.status === 403) return { status: "forbidden" };
      }
      if (!response.ok) {
        return {
          status: "service-error",
          statusCode: response.status,
          retryable: response.status === 429 || response.status >= 500,
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError && !signal.aborted) {
          return { status: "invalid" };
        }
        return transportFailure(signal, error);
      }
      if (signal.aborted) return { status: "timeout" };
      try {
        return { status: "ok", body: parseContextApiResponse(body) };
      } catch {
        return { status: "invalid" };
      }
    } catch (error) {
      return transportFailure(signal, error);
    }
  };
}

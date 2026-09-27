import { featuredContext } from "@linerfy/domain/fixtures";
import type { NowPlayingTrack } from "@linerfy/now-playing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContextEngine,
  type ContextEngineOptions,
  type FetchOutcome,
} from "./context-engine";
import type { ContextState } from "./context-state";

function track(overrides: Partial<NowPlayingTrack> = {}): NowPlayingTrack {
  return {
    provider: "spotify",
    title: "Song",
    artist: "Artist",
    album: "Album",
    state: "playing",
    ...overrides,
  };
}

const trackA = track({ album: "Album A" });
const trackB = track({ album: "Album B" });

function deferred() {
  let resolve!: (outcome: FetchOutcome) => void;
  const promise = new Promise<FetchOutcome>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Harness {
  engine: ContextEngine;
  fetch: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  resolve: (index: number, outcome: FetchOutcome) => Promise<void>;
}

function setup(options: Partial<ContextEngineOptions> = {}): Harness {
  const pending: Array<ReturnType<typeof deferred>> = [];
  const fetch = vi.fn(
    (_track: NowPlayingTrack, _signal: AbortSignal, _retry?: boolean) => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
  );
  const send = vi.fn();
  const engine = new ContextEngine({
    fetch,
    send,
    pollIntervalMs: 2500,
    requestTimeoutMs: 8_000,
    maxRetries: 1,
    ...options,
  });
  return {
    engine,
    fetch,
    send,
    resolve: async (index, outcome) => {
      pending[index]!.resolve(outcome);
      // Let the awaiting fetchOnce continuation run to completion.
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
  };
}

function statuses(send: ReturnType<typeof vi.fn>): string[] {
  return send.mock.calls.map((call) => (call[0] as ContextState).status);
}

const ready = (): FetchOutcome => ({
  status: "ok",
  body: { status: "ready", context: featuredContext },
});
const partial = (): FetchOutcome => ({
  status: "ok",
  body: {
    status: "partial",
    stage: "build_consensus",
    context: featuredContext,
  },
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ContextEngine", () => {
  it("sends explicit retry intent and preserves content while restarting the album", async () => {
    const { engine, fetch, send, resolve } = setup();
    engine.onTrack(trackA);
    await resolve(0, partial());
    engine.rearm(trackA, true);
    expect(fetch.mock.calls[1]?.[2]).toBe(true);
    expect(send.mock.lastCall?.[0].context).toEqual(featuredContext);
    await resolve(1, { status: "ok", body: { status: "queued" } });
    expect(send.mock.lastCall?.[0].context).toEqual(featuredContext);
    vi.advanceTimersByTime(2500);
    expect(fetch.mock.calls[2]?.[2]).toBe(false);
  });
  it("issues at most one request for the same track", () => {
    const { engine, fetch } = setup();
    engine.onTrack(trackA);
    engine.onTrack(trackA);
    engine.onTrack(trackA);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not supersede a slow request for the same track", async () => {
    const { engine, fetch, send, resolve } = setup();
    engine.onTrack(trackA);
    // A later now-playing poll for the same track must not start a second request.
    engine.onTrack(trackA);
    expect(fetch).toHaveBeenCalledTimes(1);
    await resolve(0, ready());
    expect(statuses(send)).toEqual(["loading", "ready"]);
  });

  it("re-requests the same album on rearm (sign-in)", () => {
    const { engine, fetch } = setup();
    engine.onTrack(trackA);
    expect(fetch).toHaveBeenCalledTimes(1);
    // rearm bypasses the active-track-key guard so sign-in re-requests the album.
    engine.rearm(trackA);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps published content when the job fails", async () => {
    const { engine, send, resolve } = setup();
    engine.onTrack(trackA);
    await resolve(0, {
      status: "ok",
      body: {
        status: "failed",
        stage: "build_consensus",
        context: featuredContext,
      },
    });
    expect(send).toHaveBeenLastCalledWith({
      status: "failed",
      stage: "build_consensus",
      context: featuredContext,
    });
  });

  it("drops a stale response after a track change", async () => {
    const { engine, fetch, send, resolve } = setup();
    engine.onTrack(trackA);
    engine.onTrack(trackB);
    expect(fetch).toHaveBeenCalledTimes(2);
    // The old track's response arrives late and must not overwrite the new one.
    await resolve(0, ready());
    expect(statuses(send)).toEqual(["loading", "loading"]);
    await resolve(1, ready());
    expect(statuses(send)).toEqual(["loading", "loading", "ready"]);
  });

  it("keeps polling after partial and stops after ready", async () => {
    const { engine, fetch, send, resolve } = setup();
    engine.onTrack(trackA);
    await resolve(0, partial());
    expect(statuses(send)).toEqual(["loading", "partial"]);

    vi.advanceTimersByTime(2500);
    expect(fetch).toHaveBeenCalledTimes(2);
    await resolve(1, ready());
    expect(statuses(send)).toEqual(["loading", "partial", "ready"]);

    // `ready` is terminal: no further timer fires.
    vi.advanceTimersByTime(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops after a terminal state", async () => {
    const { engine, fetch, send, resolve } = setup();
    engine.onTrack(trackA);
    await resolve(0, { status: "ok", body: { status: "unavailable" } });
    expect(statuses(send)).toEqual(["loading", "unavailable"]);
    vi.advanceTimersByTime(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries network errors a bounded number of times then surfaces an error", async () => {
    const { engine, fetch, send, resolve } = setup();
    engine.onTrack(trackA);
    await resolve(0, { status: "network-error" });
    vi.advanceTimersByTime(2500);
    await resolve(1, { status: "network-error" });

    // The first failure is visible; one retry then ends the request.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(statuses(send)).toEqual(["loading", "retrying", "error"]);
    vi.advanceTimersByTime(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps partial content and exits loading when network retries exhaust", async () => {
    const { engine, fetch, send, resolve } = setup();
    engine.onTrack(trackA);
    await resolve(0, partial());
    // All subsequent polls fail; partial must not be cleared.
    for (let i = 1; i <= 2; i++) {
      vi.advanceTimersByTime(2500);
      await resolve(i, { status: "network-error" });
    }
    expect(statuses(send)).toEqual(["loading", "partial", "retrying", "error"]);
    expect(send.mock.calls[2]?.[0].context).toEqual(featuredContext);
    expect(send.mock.lastCall?.[0].context).toEqual(featuredContext);
    expect(fetch).toHaveBeenCalledTimes(3); // initial successful poll + two failures
  });

  it("ends an abort-ignoring attempt within 18.5 seconds and ignores late results", async () => {
    const { engine, fetch, send, resolve } = setup();
    engine.onTrack(trackA);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetch.mock.calls[0]?.[1].aborted).toBe(true);
    expect(send).toHaveBeenLastCalledWith({
      status: "retrying",
      message: "请求超时",
      attempt: 1,
      context: undefined,
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(send).toHaveBeenLastCalledWith({
      status: "error",
      message: "请求超时",
      context: undefined,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await resolve(0, ready());
    await resolve(1, ready());
    expect(statuses(send)).toEqual(["loading", "retrying", "error"]);
  });

  it("identifies service errors while preserving partial content through the retry", async () => {
    const { engine, send, resolve } = setup();
    engine.onTrack(trackA);
    await resolve(0, partial());
    vi.advanceTimersByTime(2500);
    await resolve(1, {
      status: "service-error",
      statusCode: 503,
      retryable: true,
    });
    expect(send).toHaveBeenLastCalledWith({
      status: "retrying",
      message: "乐评服务暂时不可用（HTTP 503）",
      attempt: 1,
      context: featuredContext,
    });
    vi.advanceTimersByTime(2500);
    await resolve(2, {
      status: "service-error",
      statusCode: 503,
      retryable: true,
    });
    expect(send).toHaveBeenLastCalledWith({
      status: "error",
      message: "乐评服务暂时不可用（HTTP 503）",
      context: featuredContext,
    });
  });

  it("does not retry a permanent service error", async () => {
    const { engine, fetch, send, resolve } = setup();
    engine.onTrack(trackA);
    await resolve(0, {
      status: "service-error",
      statusCode: 400,
      retryable: false,
    });
    expect(send).toHaveBeenLastCalledWith({
      status: "error",
      message: "乐评请求失败（HTTP 400）",
      context: undefined,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not retry forbidden responses", async () => {
    const { engine, fetch, send, resolve } = setup();
    engine.onTrack(trackA);
    await resolve(0, { status: "forbidden" });
    expect(send).toHaveBeenLastCalledWith({
      status: "error",
      message: "当前账号无权访问乐评服务",
      context: undefined,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops retries and ignores completion after cancellation", async () => {
    const { engine, fetch, send, resolve } = setup();
    engine.onTrack(trackA);
    engine.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await resolve(0, ready());
    expect(fetch).toHaveBeenCalledOnce();
    expect(statuses(send)).toEqual(["loading"]);
  });

  it("aborts the in-flight request when the track changes", async () => {
    const { engine, fetch } = setup();
    engine.onTrack(trackA);
    engine.onTrack(trackB);
    // The first request's signal is aborted so the transport can stop it.
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstSignal = fetch.mock.calls[0]![1] as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
  });
});

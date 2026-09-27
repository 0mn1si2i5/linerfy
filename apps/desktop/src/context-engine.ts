import type { NowPlayingTrack } from "@linerfy/now-playing";
import type { MusicContext } from "@linerfy/domain";

import {
  trackKey,
  type ContextApiResponse,
  type ContextState,
} from "./context-state";

/**
 * The outcome of one POST /api/context attempt, already narrowed by the caller.
 *
 * The engine never touches Electron or the network directly: the caller supplies
 * `fetch` (session + HTTP + schema validation) and `send` (IPC to the renderer),
 * so the timing/racing logic here stays testable without an Electron harness.
 */
export type FetchOutcome =
  | { status: "ok"; body: ContextApiResponse }
  | { status: "network-error" }
  | { status: "timeout" }
  | { status: "service-error"; statusCode: number; retryable: boolean }
  | { status: "forbidden" }
  | { status: "invalid" }
  | { status: "unauthorized" };

export type ContextFetch = (
  track: NowPlayingTrack,
  signal: AbortSignal,
  retry?: boolean,
) => Promise<FetchOutcome>;

export interface ContextEngineOptions {
  fetch: ContextFetch;
  send: (state: ContextState) => void;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
}

/**
 * The context status poll, kept separate from the now-playing poll.
 *
 * Invariants it guarantees:
 * - At most one request per track is in flight; a slow request is never
 *   superseded by another request for the *same* track.
 * - A track change invalidates the previous request (bumping a generation) and,
 *   because `fetch` receives an AbortSignal, actively aborts it.
 * - `queued`/`running`/`partial` schedule the next status request on a dedicated
 *   timer; `ready` and the terminal states stop it.
 * - Network errors retry a bounded number of times; once `partial` content has
 *   been shown it is never cleared by a later failure.
 */
export class ContextEngine {
  private readonly fetch: ContextFetch;
  private readonly send: (state: ContextState) => void;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;

  private generation = 0;
  private activeTrackKey: string | null = null;
  private inFlight = false;
  private currentAbort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private content: MusicContext | undefined;
  private retryRequested = false;

  constructor(options: ContextEngineOptions) {
    this.fetch = options.fetch;
    this.send = options.send;
    this.pollIntervalMs = options.pollIntervalMs;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.maxRetries = options.maxRetries;
  }

  /** Called on every now-playing poll; no-ops unless the album actually changed. */
  onTrack(track: NowPlayingTrack | null): void {
    const key = track ? trackKey(track) : null;
    if (key === this.activeTrackKey) return;
    this.start(track);
  }

  /**
   * Force a re-request of the given track even when its key is unchanged. Used
   * after sign-in so the now-playing album re-enters the requestable state
   * instead of being blocked by the key the signed-out poll already recorded.
   */
  rearm(track: NowPlayingTrack | null, retry = false): void {
    const content =
      track && trackKey(track) === this.activeTrackKey
        ? this.content
        : undefined;
    this.start(track, retry, content);
  }

  /** Tear everything down (sign-out, window hidden, quit). */
  stop(): void {
    this.reset();
  }

  private start(
    track: NowPlayingTrack | null,
    retry = false,
    content?: MusicContext,
  ): void {
    this.reset();
    this.content = content;
    this.retryRequested = retry;
    if (!track) {
      this.send({ status: "idle" });
      return;
    }
    this.activeTrackKey = trackKey(track);
    this.send(
      content
        ? { status: "partial", context: content, stage: "" }
        : { status: "loading" },
    );
    void this.fetchOnce(track);
  }

  private reset(): void {
    this.generation += 1;
    this.clearTimer();
    this.currentAbort?.abort();
    this.currentAbort = null;
    this.activeTrackKey = null;
    this.inFlight = false;
    this.retries = 0;
    this.content = undefined;
    this.retryRequested = false;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedulePoll(track: NowPlayingTrack): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fetchOnce(track);
    }, this.pollIntervalMs);
  }

  private async fetchOnce(track: NowPlayingTrack): Promise<void> {
    if (this.inFlight) return;
    const generation = this.generation;
    this.inFlight = true;

    const controller = new AbortController();
    this.currentAbort = controller;
    let onAbort!: () => void;
    const aborted = new Promise<FetchOutcome>((resolve) => {
      onAbort = () => resolve({ status: "timeout" });
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let outcome: FetchOutcome;
    try {
      // The whole attempt includes session refresh and response-body reading.
      // Race the signal too: an uncooperative transport must not hold the UI
      // forever, and the retry limit still bounds replacement attempts.
      outcome = await Promise.race([
        this.fetch(track, controller.signal, this.retryRequested),
        aborted,
      ]);
    } catch {
      outcome = { status: "network-error" };
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
    }

    if (generation !== this.generation) {
      // Invalidated while in flight (track change or stop()). Leave `inFlight`
      // alone: a newer request may already own it.
      return;
    }
    this.inFlight = false;
    this.currentAbort = null;

    if (outcome.status === "unauthorized") {
      this.send({ status: "idle" });
      return;
    }
    if (
      outcome.status === "network-error" ||
      outcome.status === "timeout" ||
      (outcome.status === "service-error" && outcome.retryable)
    ) {
      this.handleNetworkError(track, outcome);
      return;
    }
    if (outcome.status === "service-error") {
      this.retries = 0;
      this.send({
        status: "error",
        message: `乐评请求失败（HTTP ${outcome.statusCode}）`,
        context: this.content,
      });
      return;
    }
    if (outcome.status === "forbidden") {
      this.send({
        status: "error",
        message: "当前账号无权访问乐评服务",
        context: this.content,
      });
      return;
    }
    if (outcome.status === "invalid") {
      this.send({
        status: "error",
        message: "响应格式错误",
        context: this.content,
      });
      return;
    }
    this.retryRequested = false;
    this.handleBody(track, outcome.body);
  }

  private handleNetworkError(
    track: NowPlayingTrack,
    outcome: Extract<
      FetchOutcome,
      { status: "network-error" | "timeout" | "service-error" }
    >,
  ): void {
    const message =
      outcome.status === "timeout"
        ? "请求超时"
        : outcome.status === "service-error"
          ? `乐评服务暂时不可用（HTTP ${outcome.statusCode}）`
          : "网络连接失败";
    this.retries += 1;
    if (this.retries <= this.maxRetries) {
      this.send({
        status: "retrying",
        message,
        attempt: this.retries,
        context: this.content,
      });
      this.schedulePoll(track);
      return;
    }
    this.retries = 0;
    this.send({
      status: "error",
      message,
      context: this.content,
    });
  }

  private handleBody(track: NowPlayingTrack, body: ContextApiResponse): void {
    this.retries = 0;
    switch (body.status) {
      case "ready":
        this.content = body.context;
        this.send({ status: "ready", context: body.context });
        return;
      case "partial":
        this.content = body.context;
        this.send({
          status: "partial",
          context: body.context,
          stage: body.stage ?? "",
          paused: body.paused,
        });
        this.schedulePoll(track);
        return;
      case "queued":
      case "running":
        if (this.content) {
          this.send({
            status: "partial",
            context: this.content,
            stage: body.stage ?? "",
            paused: body.paused,
          });
          this.schedulePoll(track);
          return;
        }
        this.send({
          status: body.status,
          stage: body.stage ?? "",
          paused: body.paused,
        });
        this.schedulePoll(track);
        return;
      case "unavailable":
        this.send({ status: "unavailable" });
        return;
      case "ambiguous":
        this.send({ status: "ambiguous" });
        return;
      case "failed":
        if (body.context || this.content) {
          this.content = body.context ?? this.content;
          this.send({
            status: "failed",
            stage: body.stage ?? "",
            context: this.content,
          });
        } else {
          this.send({ status: "failed", stage: body.stage ?? "" });
        }
        return;
    }
  }
}

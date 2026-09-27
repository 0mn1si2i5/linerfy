import {
  contextApiResponseSchema,
  type ContextApiResponse,
  type MusicContext,
} from "@linerfy/domain";
import type { NowPlayingTrack } from "@linerfy/now-playing";

/**
 * The context-fetch state the renderer observes. It never carries the session
 * token or raw API responses beyond the assembled `MusicContext`, which is
 * public catalog data.
 */
export type ContextState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "retrying";
      message: string;
      attempt: number;
      context?: MusicContext;
    }
  | { status: "queued"; stage: string; paused?: boolean }
  | { status: "running"; stage: string; paused?: boolean }
  | {
      status: "partial";
      context: MusicContext;
      stage: string;
      paused?: boolean;
    }
  | { status: "unavailable" }
  | { status: "ambiguous" }
  | { status: "failed"; stage?: string; context?: MusicContext }
  | { status: "ready"; context: MusicContext }
  | { status: "error"; message: string; context?: MusicContext };

export type { ContextApiResponse };

/** A concise, user-facing label for an enrichment pipeline stage. */
export function stageLabel(stage: string): string {
  switch (stage) {
    case "resolve_entity":
      return "识别专辑";
    case "fetch_sources":
      return "查找乐评来源";
    case "build_source_summaries":
      return "整理来源内容";
    case "build_consensus":
      return "生成综合归纳";
    default:
      return "处理中";
  }
}

export function contextStatusLabel(
  authStatus: "signed-out" | "signed-in",
  context: ContextState,
): string | null {
  if (authStatus === "signed-out") return "登录后加载乐评";
  switch (context.status) {
    case "loading":
      return "正在加载…";
    case "retrying":
      return `${context.message}，正在重连…`;
    case "queued":
      return context.paused ? "排队中（服务暂停）" : "排队中";
    case "running":
      return context.paused
        ? `${stageLabel(context.stage)}…（服务暂停）`
        : `${stageLabel(context.stage)}…`;
    case "unavailable":
      return "未找到乐评";
    case "ambiguous":
      return "无法识别专辑";
    case "failed":
      return "乐评获取失败";
    case "error":
      return context.message;
    case "idle":
      return "等待获取乐评";
    case "partial":
      return context.paused
        ? `${stageLabel(context.stage)}…（服务暂停）`
        : `${stageLabel(context.stage)}…`;
    case "ready": {
      const data = context.context;
      if (
        data.sourceSummaries.some((summary) => summary.claims.length > 0) ||
        data.consensusBlocks.some((block) => block.claims.length > 0)
      )
        return null;
      if (data.sources.length) return "已找到来源，暂无可用的乐评总结";
      if (data.ratings.length) return "仅找到评分，当前来源暂无乐评";
      return "当前来源未找到这张专辑的乐评";
    }
  }
}

/**
 * Validate a POST /api/context body at runtime against the shared contract.
 *
 * The main process must never trust a raw JSON body with a TypeScript cast: an
 * unexpected shape (or a `ready` that omits its `context`) is rejected here so
 * the renderer can only ever observe a well-formed state.
 */
export function parseContextApiResponse(input: unknown): ContextApiResponse {
  return contextApiResponseSchema.parse(input);
}

/**
 * A stable key for detecting a change in the *album* being enriched. It is
 * album identity only — provider + artist + album — and deliberately excludes
 * the track's `providerUrl`, so moving to the next track on the same album
 * keeps the already-loaded reviews instead of resetting the context request.
 * The separator is a NUL byte so real field values can never collide.
 */
export function trackKey(track: NowPlayingTrack): string {
  return `${track.provider}\u0000${track.artist}\u0000${track.album}`;
}

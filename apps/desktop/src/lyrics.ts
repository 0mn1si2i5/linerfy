import type { NowPlayingTrack } from "@linerfy/now-playing";

/**
 * A collapsible, synced-lyrics feature backed by LRCLIB. Everything here is
 * pure or takes an injected fetcher, so it can be tested without Electron or
 * the network. The main process is the only caller that fetches; the renderer
 * imports only the types and `parseLrc` / `lyricsTrackKey`.
 *
 * Lyrics load on demand and never block the review pipeline.
 */

export interface LyricsLine {
  timeMs: number;
  text: string;
}

export type LyricsResult =
  | {
      status: "synced";
      trackKey: string;
      lines: LyricsLine[];
      sourceUrl: string;
    }
  | { status: "plain"; trackKey: string; text: string; sourceUrl: string }
  | { status: "instrumental"; trackKey: string }
  | { status: "unavailable"; trackKey: string }
  | { status: "error"; trackKey: string; message: string };

/** A `fetch`-like injectable so tests never touch the network. */
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const LRCLIB_SEARCH = "https://lrclib.net/api/search";
const LRCLIB_TRACK = "https://lrclib.net/track";
// LRCLIB asks clients to identify themselves; no API key is involved.
const LRCLIB_USER_AGENT = "Linerfy/0.1 (https://github.com/0mn1si2i5/Linerfy)";
// LRCLIB documents ±2s tolerance when matching by duration.
const DURATION_TOLERANCE_SECONDS = 2;

/**
 * Track identity for lyrics: artist + title + album + duration, so a live,
 * re-recorded, or instrumental edition does not collide with the ordinary
 * track (and vice versa). The separator is a NUL so real field values can
 * never collide.
 */
export function lyricsTrackKey(track: NowPlayingTrack): string {
  return [
    track.artist,
    track.title,
    track.album,
    Math.round(track.durationMs ?? 0),
  ].join("\u0000");
}

const _TIME_TAG = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/**
 * Parse an LRC string into timestamped lines. Pure and forgiving: multiple
 * time tags on one line, millisecond or centisecond fractions, and a global
 * ``[offset:±ms]`` shift are all supported. Metadata tags (`[ar:]`, `[ti:]`,
 * ...) and empty/blank lines are dropped; duplicate timestamps are kept and
 * the result is sorted ascending by time.
 */
export function parseLrc(lrc: string): LyricsLine[] {
  const offsetMatch = /\[offset:([+-]?\d+)\]/i.exec(lrc);
  const offset = offsetMatch ? Number(offsetMatch[1]) : 0;

  const lines: LyricsLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const tags: number[] = [];
    for (const match of raw.matchAll(_TIME_TAG)) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = (match[3] ?? "").padEnd(3, "0");
      tags.push(minutes * 60_000 + seconds * 1000 + Number(fraction));
    }
    if (tags.length === 0) continue; // metadata or blank line
    const text = raw.replace(_TIME_TAG, "").trim();
    if (!text) continue; // instrumental marker
    for (const timeMs of tags) {
      lines.push({ timeMs: timeMs + offset, text });
    }
  }
  lines.sort((a, b) => a.timeMs - b.timeMs);
  return lines;
}

interface LrclibTrack {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

function _norm(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

function isTrack(value: unknown): value is LrclibTrack {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(item.id) &&
    typeof item.id === "number" &&
    item.id > 0 &&
    typeof item.trackName === "string" &&
    typeof item.artistName === "string" &&
    typeof item.albumName === "string" &&
    typeof item.duration === "number" &&
    Number.isFinite(item.duration) &&
    item.duration >= 0 &&
    typeof item.instrumental === "boolean" &&
    (item.plainLyrics === null || typeof item.plainLyrics === "string") &&
    (item.syncedLyrics === null || typeof item.syncedLyrics === "string")
  );
}

/**
 * Choose the single best candidate, or null when the result is ambiguous.
 *
 * The title must match (lyrics are per-track) and, when present, the artist
 * must match too (to reject homonyms). Known duration must be within ±2s;
 * album fallback is allowed only with a matching duration.
 * If more than one distinct track still survives, return null rather than
 * blindly take the first result.
 */
function _bestMatch(
  items: LrclibTrack[],
  track: NowPlayingTrack,
): LrclibTrack | null {
  const title = _norm(track.title);
  const artist = _norm(track.artist);
  const album = _norm(track.album);
  const duration =
    track.durationMs !== undefined ? Math.round(track.durationMs / 1000) : null;

  const titleMatches = items.filter((item) => _norm(item.trackName) === title);
  if (titleMatches.length === 0) return null;

  const artistMatches = titleMatches.filter(
    (item) => _norm(item.artistName) === artist,
  );
  const pool = artistMatches.filter((item) =>
    duration === null
      ? _norm(item.albumName) === album
      : Math.abs(item.duration - duration) <= DURATION_TOLERANCE_SECONDS,
  );

  const exact = pool.filter(
    (item) =>
      _norm(item.albumName) === album &&
      (duration === null ||
        Math.abs(item.duration - duration) <= DURATION_TOLERANCE_SECONDS),
  );
  const candidates = exact.length > 0 ? exact : pool;

  const distinct = new Set(candidates.map((item) => item.id));
  if (distinct.size > 1) return null; // ambiguous — never take the first one
  return candidates[0] ?? null;
}

/**
 * Fetch and match lyrics for a track from LRCLIB (the only allowed source).
 * The URL is built here from a fixed host and the track metadata; no arbitrary
 * URL or key ever crosses from the renderer.
 */
export async function fetchLyrics(
  fetcher: Fetcher,
  track: NowPlayingTrack,
  signal?: AbortSignal,
): Promise<LyricsResult> {
  const key = lyricsTrackKey(track);
  const params = new URLSearchParams({
    track_name: track.title,
    artist_name: track.artist,
    album_name: track.album,
  });
  if (track.durationMs !== undefined) {
    params.set("duration", String(Math.round(track.durationMs / 1000)));
  }

  let response: Response;
  const timeout = AbortSignal.timeout(10_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    response = await fetcher(`${LRCLIB_SEARCH}?${params.toString()}`, {
      headers: { "User-Agent": LRCLIB_USER_AGENT },
      signal: requestSignal,
    });
  } catch {
    return {
      status: "error",
      trackKey: key,
      message: timeout.aborted ? "歌词请求超时" : "歌词请求未完成",
    };
  }

  if (response.status === 429) {
    return {
      status: "error",
      trackKey: key,
      message: "请求过于频繁，请稍后再试",
    };
  }
  if (!response.ok) {
    return { status: "error", trackKey: key, message: "歌词服务不可用" };
  }

  let items: LrclibTrack[];
  try {
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      return { status: "error", trackKey: key, message: "歌词响应格式错误" };
    }
    // Search may mix usable entries with incomplete community records.
    items = body.filter(isTrack);
    if (body.length > 0 && items.length === 0) {
      return { status: "error", trackKey: key, message: "歌词响应格式错误" };
    }
  } catch {
    return { status: "error", trackKey: key, message: "歌词响应格式错误" };
  }

  const match = _bestMatch(items, track);
  if (match === null) return { status: "unavailable", trackKey: key };
  if (match.instrumental) return { status: "instrumental", trackKey: key };

  const sourceUrl = `${LRCLIB_TRACK}/${match.id}`;
  if (match.syncedLyrics) {
    const lines = parseLrc(match.syncedLyrics);
    if (lines.length > 0) {
      return { status: "synced", trackKey: key, lines, sourceUrl };
    }
  }
  if (match.plainLyrics && match.plainLyrics.trim()) {
    return {
      status: "plain",
      trackKey: key,
      text: match.plainLyrics,
      sourceUrl,
    };
  }
  return { status: "unavailable", trackKey: key };
}

import type { NowPlayingTrack } from "@linerfy/now-playing";
import { describe, expect, it } from "vitest";

import { fetchLyrics, lyricsTrackKey, parseLrc } from "./lyrics";

function track(overrides: Partial<NowPlayingTrack> = {}): NowPlayingTrack {
  return {
    provider: "spotify",
    title: "Song",
    artist: "Artist",
    album: "Album",
    state: "playing",
    durationMs: 200_000,
    ...overrides,
  };
}

describe("parseLrc", () => {
  it("parses a standard timestamped line", () => {
    const lines = parseLrc("[00:01.00]第一行\n[00:02.50]第二行");
    expect(lines).toEqual([
      { timeMs: 1000, text: "第一行" },
      { timeMs: 2500, text: "第二行" },
    ]);
  });

  it("accepts millisecond and bare-second fractions", () => {
    const lines = parseLrc("[00:01.250]毫秒\n[00:02]整秒");
    expect(lines.map((line) => line.timeMs)).toEqual([1250, 2000]);
  });

  it("expands multiple time tags on one line", () => {
    const lines = parseLrc("[00:01.00][00:05.00]重复的副歌");
    expect(lines).toEqual([
      { timeMs: 1000, text: "重复的副歌" },
      { timeMs: 5000, text: "重复的副歌" },
    ]);
  });

  it("applies a global offset", () => {
    const lines = parseLrc("[offset:500]\n[00:01.00]第一行");
    expect(lines[0]).toEqual({ timeMs: 1500, text: "第一行" });
  });

  it("drops metadata tags, blank lines, and instrumental markers", () => {
    const lines = parseLrc(
      "[ar:Artist]\n[ti:Title]\n[00:01.00]有词\n[00:03.00]\n[00:05.00]还有词",
    );
    expect(lines.map((line) => line.text)).toEqual(["有词", "还有词"]);
  });

  it("sorts lines ascending by time", () => {
    const lines = parseLrc("[00:05.00]晚\n[00:01.00]早");
    expect(lines.map((line) => line.timeMs)).toEqual([1000, 5000]);
  });
});

describe("lyricsTrackKey", () => {
  it("distinguishes editions by title/album/duration", () => {
    const base = track();
    const live = track({ title: "Song (Live)", durationMs: 210_000 });
    const instrumental = track({ album: "Album (Instrumental)" });
    expect(lyricsTrackKey(base)).not.toBe(lyricsTrackKey(live));
    expect(lyricsTrackKey(base)).not.toBe(lyricsTrackKey(instrumental));
    expect(lyricsTrackKey(base)).toBe(lyricsTrackKey(track()));
  });
});

describe("fetchLyrics", () => {
  function fetcher(
    body: unknown,
    status = 200,
  ): (input: string) => Promise<Response> {
    return async () => new Response(JSON.stringify(body), { status });
  }

  it("matches Bags despite an unrelated result with null duration", async () => {
    const item = {
      id: 280875,
      trackName: "Bags",
      artistName: "Clairo",
      albumName: "Immunity",
      duration: 261,
      instrumental: false,
      plainLyrics: "Test line",
      syncedLyrics: "[00:12.40]Test line",
    };
    const result = await fetchLyrics(
      fetcher([
        { ...item, id: 36229629, duration: null },
        { ...item, id: 33633865, duration: 233 },
        item,
      ]),
      track({
        title: "Bags",
        artist: "Clairo",
        album: "Immunity",
        durationMs: 260519,
      }),
    );
    expect(result.status).toBe("synced");
    if (result.status === "synced") {
      expect(result.sourceUrl).toContain("280875");
      expect(result.lines).toEqual([{ timeMs: 12400, text: "Test line" }]);
    }
  });

  it("returns synced lines when syncedLyrics is present", async () => {
    const result = await fetchLyrics(
      fetcher([
        {
          id: 1,
          trackName: "Song",
          artistName: "Artist",
          albumName: "Album",
          duration: 200,
          instrumental: false,
          plainLyrics: "plain",
          syncedLyrics: "[00:01.00]第一行",
        },
      ]),
      track(),
    );
    expect(result.status).toBe("synced");
    if (result.status === "synced") {
      expect(result.lines).toEqual([{ timeMs: 1000, text: "第一行" }]);
    }
  });

  it("falls back to plain text when there is no synced track", async () => {
    const result = await fetchLyrics(
      fetcher([
        {
          id: 1,
          trackName: "Song",
          artistName: "Artist",
          albumName: "Album",
          duration: 200,
          instrumental: false,
          plainLyrics: "some plain lyrics",
          syncedLyrics: null,
        },
      ]),
      track(),
    );
    expect(result.status).toBe("plain");
  });

  it("reports an instrumental track", async () => {
    const result = await fetchLyrics(
      fetcher([
        {
          id: 1,
          trackName: "Song",
          artistName: "Artist",
          albumName: "Album",
          duration: 200,
          instrumental: true,
          plainLyrics: null,
          syncedLyrics: null,
        },
      ]),
      track(),
    );
    expect(result.status).toBe("instrumental");
  });

  it("returns unavailable when the title does not match", async () => {
    const result = await fetchLyrics(
      fetcher([
        {
          id: 1,
          trackName: "Different Song",
          artistName: "Artist",
          albumName: "Album",
          duration: 200,
          instrumental: false,
          plainLyrics: "x",
          syncedLyrics: null,
        },
      ]),
      track(),
    );
    expect(result.status).toBe("unavailable");
  });

  it("returns unavailable when candidates are ambiguous", async () => {
    // Two distinct records with the same title/artist/album/duration cannot be
    // disambiguated; never silently take the first one.
    const ambiguous = [
      {
        id: 1,
        trackName: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 200,
        instrumental: false,
        plainLyrics: "a",
        syncedLyrics: null,
      },
      {
        id: 2,
        trackName: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 200,
        instrumental: false,
        plainLyrics: "b",
        syncedLyrics: null,
      },
    ];
    const result = await fetchLyrics(fetcher(ambiguous), track());
    expect(result.status).toBe("unavailable");
  });

  it("returns an error category on a non-ok response", async () => {
    const result = await fetchLyrics(fetcher({}, 503), track());
    expect(result.status).toBe("error");
  });

  it("returns an error category when the body is not JSON", async () => {
    const badFetcher = async () => new Response("not json", { status: 200 });
    const result = await fetchLyrics(badFetcher, track());
    expect(result.status).toBe("error");
  });

  it("returns an error category when the network fails", async () => {
    const throwing = async () => {
      throw new Error("offline");
    };
    const result = await fetchLyrics(throwing, track());
    expect(result.status).toBe("error");
  });

  it("rejects another artist or an incompatible recording duration", async () => {
    const item = {
      id: 1,
      trackName: "Song",
      artistName: "Other",
      albumName: "Album",
      duration: 200,
      instrumental: false,
      plainLyrics: "synthetic",
      syncedLyrics: null,
    };
    expect((await fetchLyrics(fetcher([item]), track())).status).toBe(
      "unavailable",
    );
    expect(
      (
        await fetchLyrics(
          fetcher([{ ...item, artistName: "Artist", duration: 300 }]),
          track(),
        )
      ).status,
    ).toBe("unavailable");
  });

  it("handles valid JSON with the wrong shape without throwing", async () => {
    for (const body of [{ error: "unexpected" }, [null], [{ id: 1 }]]) {
      expect((await fetchLyrics(fetcher(body), track())).status).toBe("error");
    }
  });

  it("passes cancellation to the request and reports aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await fetchLyrics(
      async (_url, options) => {
        expect(options?.signal?.aborted).toBe(true);
        throw new Error("aborted");
      },
      track(),
      controller.signal,
    );
    expect(result.status).toBe("error");
  });
});

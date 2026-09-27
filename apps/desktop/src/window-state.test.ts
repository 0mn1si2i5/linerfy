import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collapseLyricsBounds,
  defaultWindowState,
  expandForLyrics,
  loadWindowState,
  sanitizeWindowState,
  saveWindowState,
} from "./window-state";

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "linerfy-state-"));
  return path.join(dir, "window-state.json");
}

describe("window state", () => {
  it("keeps user moves and resizes when removing lyric expansion", () => {
    const area = { x: 0, width: 1800 };
    const base = { x: 100, y: 40, width: 760, height: 560 };
    const expanded = expandForLyrics(base, area);
    const current = { x: 240, y: 80, width: 1200, height: 700 };
    expect(collapseLyricsBounds(base, expanded, current, area, 360)).toEqual({
      x: 240,
      y: 80,
      width: 880,
      height: 700,
    });
  });

  it("undoes only an automatic edge shift, not a subsequent user move", () => {
    const area = { x: 0, width: 1600 };
    const base = { x: 700, y: 40, width: 760, height: 560 };
    const expanded = expandForLyrics(base, area);
    expect(collapseLyricsBounds(base, expanded, expanded, area, 360)).toEqual(
      base,
    );
    expect(
      collapseLyricsBounds(base, expanded, { ...expanded, x: 600 }, area, 360)
        .x,
    ).toBe(600);
  });

  it("clamps the collapsed window after moving to a smaller display", () => {
    const base = { x: 100, y: 40, width: 760, height: 560 };
    const expanded = expandForLyrics(base, { x: 0, width: 1800 });
    const current = { ...expanded, x: -900, width: 680 };
    expect(
      collapseLyricsBounds(
        base,
        expanded,
        current,
        { x: -800, width: 800 },
        360,
      ),
    ).toEqual({
      x: -800,
      y: 40,
      width: 360,
      height: 560,
    });
  });

  it("adds lyric space on the right without changing the original bounds", () => {
    const original = { x: 100, y: 40, width: 760, height: 560 };
    expect(expandForLyrics(original, { x: 0, width: 1600 })).toEqual({
      x: 100,
      y: 40,
      width: 1080,
      height: 560,
    });
    expect(original.width).toBe(760);
    expect(
      expandForLyrics({ ...original, x: 700 }, { x: 0, width: 1600 }).x,
    ).toBe(520);
  });
  it("defaults to the base window geometry", () => {
    expect(defaultWindowState()).toEqual({ width: 760, height: 560 });
  });

  it("repairs a malformed persisted state to safe defaults", () => {
    expect(sanitizeWindowState({ width: 1, height: 10 })).toEqual({
      width: 760,
      height: 560,
    });
    expect(sanitizeWindowState("garbage")).toEqual(defaultWindowState());
    expect(sanitizeWindowState(null)).toEqual(defaultWindowState());
  });

  it("keeps valid fields including optional position", () => {
    expect(
      sanitizeWindowState({ width: 900, height: 700, x: 12, y: 34 }),
    ).toEqual({ width: 900, height: 700, x: 12, y: 34 });
  });

  it("round-trips state through a file", async () => {
    const file = await tempFile();
    await saveWindowState(file, { width: 800, height: 600, x: 5, y: 6 });
    await expect(loadWindowState(file)).resolves.toEqual({
      width: 800,
      height: 600,
      x: 5,
      y: 6,
    });
  });

  it("falls back to defaults when the file is absent or corrupt", async () => {
    const file = await tempFile();
    await expect(loadWindowState(file)).resolves.toEqual(defaultWindowState());

    await fs.writeFile(file, "{ not json", "utf-8");
    await expect(loadWindowState(file)).resolves.toEqual(defaultWindowState());
  });
});

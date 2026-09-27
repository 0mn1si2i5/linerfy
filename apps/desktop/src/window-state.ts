import { promises as fs } from "node:fs";
import path from "node:path";

/** Persisted window geometry. */
export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export const MIN_WINDOW_DIMENSION = 200;
export const LYRICS_SIDEBAR_WIDTH = 320;

type WindowBounds = { x: number; y: number; width: number; height: number };

export function expandForLyrics(
  bounds: WindowBounds,
  area: { x: number; width: number },
) {
  const width = Math.min(bounds.width + LYRICS_SIDEBAR_WIDTH, area.width);
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width));
  return { ...bounds, x, width };
}

/** Remove only the automatic expansion, preserving later user moves/resizes. */
export function collapseLyricsBounds(
  base: WindowBounds,
  expanded: WindowBounds,
  current: WindowBounds,
  area: { x: number; width: number },
  minWidth: number,
): WindowBounds {
  const width = Math.min(
    area.width,
    Math.max(minWidth, base.width + current.width - expanded.width),
  );
  const preferredX = current.x === expanded.x ? base.x : current.x;
  const x = Math.max(area.x, Math.min(preferredX, area.x + area.width - width));
  return { ...current, x, width };
}

export function defaultWindowState(): WindowState {
  return { width: 760, height: 560 };
}

/** Clamp/repair an untrusted persisted value into a valid WindowState. */
export function sanitizeWindowState(value: unknown): WindowState {
  const defaults = defaultWindowState();
  if (typeof value !== "object" || value === null) return defaults;
  const v = value as Record<string, unknown>;
  return {
    width:
      typeof v.width === "number" && v.width >= MIN_WINDOW_DIMENSION
        ? v.width
        : defaults.width,
    height:
      typeof v.height === "number" && v.height >= MIN_WINDOW_DIMENSION
        ? v.height
        : defaults.height,
    ...(typeof v.x === "number" ? { x: v.x } : {}),
    ...(typeof v.y === "number" ? { y: v.y } : {}),
  };
}

export async function loadWindowState(file: string): Promise<WindowState> {
  try {
    return sanitizeWindowState(JSON.parse(await fs.readFile(file, "utf-8")));
  } catch {
    return defaultWindowState();
  }
}

export async function saveWindowState(
  file: string,
  state: WindowState,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2), "utf-8");
}

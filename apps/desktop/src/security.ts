import type { BrowserWindowConstructorOptions } from "electron";

/** Non-security window chrome, adjustable per launch state. */
export interface WindowStyleOptions {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  x?: number;
  y?: number;
  show?: boolean;
  backgroundColor?: string;
}

/** Window background matching the renderer's `--paper` token per theme. */
export function windowBackgroundColor(dark: boolean): string {
  return dark ? "#18160f" : "#f3eee3";
}

/**
 * Build the window options with the renderer security boundary fixed and only
 * the chrome adjustable. The security fields are non-negotiable.
 */
export function createWindowOptions(
  preload: string,
  style: WindowStyleOptions = {},
): BrowserWindowConstructorOptions {
  return {
    width: 1080,
    height: 760,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: windowBackgroundColor(false),
    title: "Linerfy",
    frame: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 20 },
    ...style,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
}

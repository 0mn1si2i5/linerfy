import { describe, expect, it } from "vitest";

import { createWindowOptions, windowBackgroundColor } from "./security";

describe("desktop renderer boundary", () => {
  it("isolates the renderer from Node and the main process", () => {
    const options = createWindowOptions("/fixed/preload.js");

    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
    expect(options.webPreferences?.preload).toBe("/fixed/preload.js");
    expect(options).toMatchObject({
      frame: true,
      minWidth: 360,
      titleBarStyle: "hiddenInset",
    });
  });

  it("defaults the window background to the light paper colour", () => {
    expect(createWindowOptions("/fixed/preload.js").backgroundColor).toBe(
      "#f3eee3",
    );
  });

  it("lets the caller pick the background without touching the boundary", () => {
    const options = createWindowOptions("/fixed/preload.js", {
      backgroundColor: windowBackgroundColor(true),
    });
    expect(options.backgroundColor).toBe("#18160f");
    expect(options.webPreferences?.sandbox).toBe(true);
  });
});

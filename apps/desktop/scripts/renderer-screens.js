// Capture the built renderer in fixed states, light and dark, for visual review.
// Uses fixture data and stubbed IPC; nothing is written into the repository.
//
// Run after `electron-forge package` (which writes .vite/), from apps/desktop:
//   node_modules/.bin/electron scripts/renderer-screens.js

const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PRELOAD = path.join(ROOT, ".vite", "build", "preload.js");
const RENDERER = path.join(
  ROOT,
  ".vite",
  "renderer",
  "main_window",
  "index.html",
);
const nfr = require(
  path.resolve(__dirname, "../../../packages/domain/src/nfr.json"),
);

const reviewed = {
  ...nfr,
  ratings: [
    { provider: "musicbrainz", value: 4.2, scale: 5, voteCount: 3 },
    { provider: "critiquebrainz", value: 4.5, scale: 5, voteCount: 12 },
  ],
};

const WIDTH = 460;
const HEIGHT = 760;
const LYRICS_WIDTH = 320;

const track = {
  provider: "spotify",
  title: "Mariners Apartment Complex",
  artist: nfr.artist.name,
  album: nfr.release.title,
  state: "playing",
  positionMs: 83000,
  durationMs: 326000,
};

const SCENARIOS = [
  {
    name: "playing",
    auth: "signed-in",
    context: { status: "ready", context: reviewed },
  },
  {
    name: "waiting",
    auth: "signed-in",
    context: { status: "running", stage: "summarize" },
  },
  { name: "no-reviews", auth: "signed-in", context: { status: "unavailable" } },
  {
    name: "failed",
    auth: "signed-in",
    context: { status: "failed", context: reviewed },
  },
  { name: "player-error", auth: "signed-in", nowPlayingError: true },
  { name: "signed-out", auth: "signed-out", context: { status: "idle" } },
  {
    name: "lyrics",
    auth: "signed-in",
    context: { status: "ready", context: reviewed },
    openLyrics: true,
  },
];

let current = SCENARIOS[0];
let window = null;

ipcMain.handle("now-playing:get", () => {
  if (current.nowPlayingError) throw new Error("player unavailable");
  return track;
});
ipcMain.handle("auth:get-state", () => ({ status: current.auth }));
ipcMain.handle("lyrics:set-open", (_event, open) =>
  window?.setSize(open ? WIDTH + LYRICS_WIDTH : WIDTH, HEIGHT),
);
ipcMain.handle("lyrics:get", () => ({
  status: "synced",
  trackKey: [track.artist, track.title, track.album, track.durationMs].join(
    "\0",
  ),
  sourceUrl: "https://lrclib.net",
  lines: [
    { timeMs: 0, text: "First fixture lyric" },
    { timeMs: 60000, text: "Second fixture lyric" },
    { timeMs: 120000, text: "Third fixture lyric" },
  ],
}));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function capture(scenario, theme, outDir) {
  current = scenario;
  nativeTheme.themeSource = theme;
  // One window is reused: a second BrowserWindow loading the same file after
  // the first was destroyed fails with ERR_FAILED under the sandbox.
  if (!window) {
    window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
  }
  window.setSize(WIDTH, HEIGHT);
  await window.loadFile(RENDERER);
  await sleep(300);
  if (scenario.context) {
    window.webContents.send("context:changed", scenario.context);
  }
  if (scenario.openLyrics) {
    await window.webContents.executeJavaScript(
      "document.querySelector('.lyrics-toggle')?.click()",
    );
  }
  // Leave time for React, the remote cover image and the lyrics request.
  await sleep(1200);
  const image = await window.webContents.capturePage();
  await fs.writeFile(
    path.join(outDir, `${scenario.name}-${theme}.png`),
    image.toPNG(),
  );
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "linerfy-screens-"));
    for (const theme of ["light", "dark"]) {
      for (const scenario of SCENARIOS) {
        await capture(scenario, theme, outDir);
      }
    }
    console.log(`SCREENS: ${outDir}`);
  } catch (error) {
    console.error(error);
    code = 1;
  }
  app.exit(code);
});

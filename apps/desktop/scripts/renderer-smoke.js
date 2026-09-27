// Minimal renderer startup smoke. Loads the built renderer bundle in a hidden
// Electron window with the real preload, then asserts that React actually
// mounted content into #root. This catches the duplicate-React black screen
// (two bundled React copies make the first render throw "Cannot read properties
// of null (reading 'useContext')", leaving #root empty) without standing up an
// E2E framework.
//
// Run after `electron-forge package` (which writes .vite/), from apps/desktop:
//   node_modules/.bin/electron scripts/renderer-smoke.js

const { app, BrowserWindow, ipcMain } = require("electron");
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

const DUP_REACT_RE =
  /useContext|Cannot read properties of null|Minified React error|Invalid hook call/i;

let rendererError = false;
let window = null;
const lyricsSmoke = process.argv.includes("--lyrics");
const smokeTrack = {
  provider: "spotify",
  title: "Smoke Track",
  artist: "Smoke Artist",
  album: "Smoke Album",
  state: "playing",
  positionMs: 1000,
  durationMs: 120000,
};
if (lyricsSmoke) {
  ipcMain.handle("lyrics:set-open", (_event, open) =>
    window.setSize(open ? 1120 : 800, 600),
  );
  ipcMain.handle("now-playing:get", () => smokeTrack);
  ipcMain.handle("auth:get-state", () => ({ status: "signed-in" }));
  ipcMain.handle("lyrics:get", async () => {
    const requested = { ...smokeTrack };
    await new Promise((resolve) =>
      setTimeout(resolve, requested.title === "Slow Track" ? 500 : 200),
    );
    const trackKey = [
      requested.artist,
      requested.title,
      requested.album,
      requested.durationMs,
    ].join("\0");
    if (requested.title !== "Smoke Track") {
      return {
        status: "plain",
        trackKey,
        sourceUrl: "https://lrclib.net",
        text: `${requested.title} lyrics`,
      };
    }
    return {
      status: "synced",
      trackKey,
      sourceUrl: "https://lrclib.net",
      lines: [
        { timeMs: 0, text: "First smoke lyric" },
        { timeMs: 5000, text: "Second smoke lyric" },
      ],
    };
  });
}

function finish(code, message) {
  console.log(message);
  app.exit(code);
}

app.whenReady().then(() => {
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    rendererError = true;
    console.error("SMOKE: renderer process gone:", details.reason);
  });

  window.webContents.on("console-message", (event) => {
    const message = String(event.message || "");
    const level = event.level ?? event[1];
    // Flag only the errors that indicate a broken React tree. Unhandled IPC
    // rejections are expected here (no main-process handlers are registered in
    // this smoke), so they are deliberately not treated as failures.
    if ((level === "error" || level === 3) && DUP_REACT_RE.test(message)) {
      rendererError = true;
      console.error("SMOKE: renderer error:", message);
    }
  });

  window
    .loadFile(RENDERER)
    .then(() => (lyricsSmoke ? checkLyrics() : pollContent(0)))
    .catch((error) =>
      finish(1, `SMOKE FAIL: could not load renderer: ${error.message}`),
    );
});

async function checkLyrics() {
  try {
    for (let i = 0; i < 40; i++) {
      const opened = await window.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('.lyrics-toggle');
        if (!button) return false;
        button.click(); return true;
      })()`);
      if (opened) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (let i = 0; i < 40; i++) {
      if (rendererError)
        throw new Error("renderer error during lyrics transition");
      const text = await window.webContents.executeJavaScript(
        "document.body.innerText",
      );
      if (
        text.includes("First smoke lyric") &&
        text.includes("Second smoke lyric")
      ) {
        await window.webContents.executeJavaScript(
          "document.querySelector('.lyrics-panel').dispatchEvent(new WheelEvent('wheel', {bubbles:true,deltaY:100}))",
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        const canFollow = await window.webContents.executeJavaScript(`(() => {
          const button = document.querySelector('.lyrics-follow');
          if (!button) return false;
          button.click(); return true;
        })()`);
        if (!canFollow)
          throw new Error("manual scroll has no return-to-current-line action");
        await new Promise((resolve) => setTimeout(resolve, 100));
        for (const input of ["pointerdown", "keydown"]) {
          await window.webContents.executeJavaScript(`(() => {
            const panel = document.querySelector('.lyrics-panel');
            panel.focus();
            panel.dispatchEvent(${input === "pointerdown" ? "new PointerEvent('pointerdown', {bubbles:true})" : "new KeyboardEvent('keydown', {bubbles:true,key:'PageDown'})"});
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 100));
          const resumed = await window.webContents.executeJavaScript(`(() => {
            const button = document.querySelector('.lyrics-follow');
            if (!button) return false;
            button.click(); return true;
          })()`);
          if (!resumed) throw new Error(input + " did not pause lyric follow");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        smokeTrack.title = "Slow Track";
        window.webContents.send("now-playing:changed", { ...smokeTrack });
        await new Promise((resolve) => setTimeout(resolve, 100));
        smokeTrack.title = "Fast Track";
        window.webContents.send("now-playing:changed", { ...smokeTrack });
        await new Promise((resolve) => setTimeout(resolve, 700));
        const finalText = await window.webContents.executeJavaScript(
          "document.body.innerText",
        );
        if (
          rendererError ||
          !finalText.includes("Fast Track lyrics") ||
          finalText.includes("Slow Track lyrics")
        ) {
          throw new Error("stale lyrics overwrote the current track");
        }
        const rightSide = await window.webContents.executeJavaScript(`(() => {
          const sidebar = document.querySelector('.lyrics-sidebar').getBoundingClientRect();
          const content = document.querySelector('.companion-content').getBoundingClientRect();
          return sidebar.width > 0 && sidebar.left >= content.right - 1;
        })()`);
        if (!rightSide)
          throw new Error("lyrics did not open beside the main content");
        await window.webContents.executeJavaScript(
          "document.querySelector('.lyrics-close').click()",
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        const closed = await window.webContents.executeJavaScript(`(() => {
          const sidebar = document.querySelector('.lyrics-sidebar');
          return sidebar.inert && sidebar.getBoundingClientRect().width === 0 && document.activeElement === document.querySelector('.lyrics-toggle');
        })()`);
        if (!closed)
          throw new Error("lyrics sidebar did not collapse or restore focus");
        return finish(
          0,
          "LYRICS SMOKE PASS: loading → synced; rapid track changes reject stale lyrics",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("synced lyrics never rendered");
  } catch (error) {
    finish(1, `LYRICS SMOKE FAIL: ${error.message}`);
  }
}

function pollContent(attempt) {
  if (rendererError) return finish(1, "SMOKE FAIL: uncaught renderer error");

  window.webContents
    .executeJavaScript(
      `JSON.stringify({
        children: document.getElementById('root')?.children.length || 0,
        text: (document.body?.innerText || '').trim()
      })`,
    )
    .then((raw) => {
      const { children, text } = JSON.parse(raw);
      if (children > 0 && text.length > 0) {
        return finish(
          0,
          `SMOKE PASS: renderer mounted ${children} root child(ren), "${text.slice(0, 60)}..."`,
        );
      }
      if (attempt >= 30) {
        return finish(
          1,
          `SMOKE FAIL: #root stayed empty after ${attempt + 1} polls`,
        );
      }
      setTimeout(() => pollContent(attempt + 1), 100);
    })
    .catch((error) =>
      finish(1, `SMOKE FAIL: evaluate error: ${error.message}`),
    );
}

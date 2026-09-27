import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
  APPLE_MUSIC_CONTROL_SCRIPTS,
  APPLE_MUSIC_NOW_PLAYING_SCRIPT,
  APPLE_MUSIC_SEEK_SCRIPT,
  SPOTIFY_CONTROL_SCRIPTS,
  SPOTIFY_NOW_PLAYING_SCRIPT,
  SPOTIFY_SEEK_SCRIPT,
  createAppleMusicProvider,
  createNowPlayingService,
  createSpotifyProvider,
  type NowPlayingTrack,
  type PlaybackAction,
  type ScriptRunner,
} from "@linerfy/now-playing";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  nativeImage,
  net,
  safeStorage,
  screen,
  shell,
  Tray,
} from "electron";

import type { LoginState, SignInResult } from "./auth-state";
import { ContextEngine } from "./context-engine";
import { createContextClient } from "./context-client";
import type { ContextState } from "./context-state";
import {
  InvalidRefreshTokenError,
  performOAuthFlow,
  refreshSession,
  type SupabaseSession,
} from "./oauth";
import { fetchLyrics } from "./lyrics";
import { createWindowOptions } from "./security";
import {
  createTokenStore,
  type SafeCrypto,
  type TokenStore,
} from "./token-store";
import { TRAY_ICON_DATA_URL } from "./tray-icon";
import {
  collapseLyricsBounds,
  defaultWindowState,
  expandForLyrics,
  LYRICS_SIDEBAR_WIDTH,
  loadWindowState,
  saveWindowState,
  type WindowState,
} from "./window-state";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
declare const __LINERFY_BUILD_SUPABASE_URL__: string;
declare const __LINERFY_BUILD_SUPABASE_PUBLISHABLE_KEY__: string;
declare const __LINERFY_BUILD_API_URL__: string;

const execFileAsync = promisify(execFile);
const allowedScripts = new Set([
  SPOTIFY_NOW_PLAYING_SCRIPT,
  APPLE_MUSIC_NOW_PLAYING_SCRIPT,
  ...Object.values(SPOTIFY_CONTROL_SCRIPTS),
  ...Object.values(APPLE_MUSIC_CONTROL_SCRIPTS),
  SPOTIFY_SEEK_SCRIPT,
  APPLE_MUSIC_SEEK_SCRIPT,
]);

const runFixedJxa: ScriptRunner = async (script, args = []) => {
  if (!allowedScripts.has(script))
    throw new Error("Only bundled automation programs may run");
  const { stdout } = await execFileAsync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script, ...args],
    { timeout: 5_000, killSignal: "SIGKILL" },
  );
  return stdout;
};

const nowPlaying = createNowPlayingService([
  createSpotifyProvider(runFixedJxa),
  createAppleMusicProvider(runFixedJxa),
]);

const POLL_INTERVAL_MS = 2500;
const CONTEXT_REQUEST_TIMEOUT_MS = 8_000;
const CONTEXT_POLL_INTERVAL_MS = 2500;
const CONTEXT_MAX_RETRIES = 1;
const TOGGLE_SHORTCUT = "CommandOrControl+Shift+L";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let state: WindowState = defaultWindowState();
let isQuitting = false;
let pollTimer: NodeJS.Timeout | null = null;
let nowPlayingPollInFlight = false;
// Bumped on every start/stop so a now-playing read that resolves after the
// window was hidden can tell it is stale and must not restart the context poll.
let pollEpoch = 0;

const stateFile = () => `${app.getPath("userData")}/window-state.json`;
const tokenFile = () => `${app.getPath("userData")}/session-token.json`;

// Encrypt the session token with the OS secure storage (Keychain on macOS).
const safeCrypto: SafeCrypto = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
  decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, "base64")),
};

let tokenStore: TokenStore | null = null;

// The session is persisted as a single encrypted blob: a JSON string of the
// access/refresh tokens. `load()` decrypts it; this parses it back.
function loadSession(): SupabaseSession | null {
  const raw = tokenStore?.load();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SupabaseSession;
    return parsed.access_token && parsed.refresh_token ? parsed : null;
  } catch {
    return null;
  }
}

function isSessionExpired(session: SupabaseSession): boolean {
  return Boolean(session.expires_at && session.expires_at * 1000 <= Date.now());
}

function loginState(): LoginState {
  const session = loadSession();
  return session && !isSessionExpired(session)
    ? { status: "signed-in" }
    : { status: "signed-out" };
}

function oauthConfig() {
  const url = process.env.SUPABASE_URL || __LINERFY_BUILD_SUPABASE_URL__;
  const anonKey =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    __LINERFY_BUILD_SUPABASE_PUBLISHABLE_KEY__;
  if (!url || !anonKey) return null;
  const redirectPort = Number(
    process.env.LINERFY_OAUTH_REDIRECT_PORT ?? "4862",
  );
  return {
    url,
    anonKey,
    provider: "github" as const,
    redirectPort: Number.isFinite(redirectPort) ? redirectPort : 4862,
  };
}

function sendAuthState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("auth:state", loginState());
  }
}

// Refresh the persisted session with its refresh token. Clears it and signs out
// only when the refresh token is definitively rejected (revoked/expired); a
// transient network or 5xx failure leaves the stored session intact. Returns
// the fresh session, or null when there is nothing usable right now.
let refreshInFlight: Promise<SupabaseSession | null> | null = null;

async function refreshOrClear(): Promise<SupabaseSession | null> {
  const session = loadSession();
  if (!session) return null;
  // Single-flight: concurrent callers share one refresh so a rotated refresh
  // token is never overwritten by a second, stale refresh.
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh(session);
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function doRefresh(
  session: SupabaseSession,
): Promise<SupabaseSession | null> {
  const config = oauthConfig();
  if (!config) {
    tokenStore?.clear();
    sendAuthState();
    return null;
  }
  try {
    const refreshed = await refreshSession(
      config,
      session.refresh_token,
      net.fetch,
    );
    if (loadSession()?.refresh_token !== session.refresh_token)
      return loadSession();
    tokenStore?.save(JSON.stringify(refreshed));
    sendAuthState();
    return refreshed;
  } catch (error) {
    if (error instanceof InvalidRefreshTokenError) {
      if (loadSession()?.refresh_token === session.refresh_token)
        tokenStore?.clear();
      sendAuthState();
      return null;
    }
    throw error;
  }
}

// Return a non-expired session, refreshing it first when it is within 60s of
// expiry (or already past it). Never returns an expired token to a caller.
async function ensureFreshSession(): Promise<SupabaseSession | null> {
  const session = loadSession();
  if (!session) return null;
  if (session.expires_at && session.expires_at * 1000 > Date.now() + 60_000) {
    return session;
  }
  return refreshOrClear();
}

// The authenticated API base (e.g. the Vercel deployment). Context fetching is
// disabled until it and a session are both present.
const apiUrl = process.env.LINERFY_API_URL || __LINERFY_BUILD_API_URL__;

function sendContext(state: ContextState) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("context:changed", state);
  }
}

const fetchContextOutcome = createContextClient({
  apiUrl,
  fetcher: net.fetch,
  getSession: ensureFreshSession,
  refreshSession: refreshOrClear,
  onUnauthorized: () => {
    tokenStore?.clear();
    sendAuthState();
  },
});

const contextEngine = new ContextEngine({
  fetch: fetchContextOutcome,
  send: sendContext,
  pollIntervalMs: CONTEXT_POLL_INTERVAL_MS,
  requestTimeoutMs: CONTEXT_REQUEST_TIMEOUT_MS,
  maxRetries: CONTEXT_MAX_RETRIES,
});

function windowStyle() {
  return {
    width: state.width,
    height: state.height,
    ...(state.x !== undefined ? { x: state.x } : {}),
    ...(state.y !== undefined ? { y: state.y } : {}),
  };
}

function loadRenderer(window: BrowserWindow) {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

function captureWindowBounds(window: BrowserWindow) {
  const bounds = window.getBounds();
  state = lyricsGeometry
    ? collapseLyricsBounds(
        lyricsGeometry.base,
        lyricsGeometry.expanded,
        bounds,
        screen.getDisplayMatching(bounds).workArea,
        lyricsGeometry.minimumSize[0],
      )
    : bounds;
}

let lyricsGeometry: {
  base: Electron.Rectangle;
  expanded: Electron.Rectangle;
  minimumSize: [number, number];
} | null = null;
ipcMain.handle("lyrics:set-open", (event, open: unknown) => {
  if (
    typeof open !== "boolean" ||
    !mainWindow ||
    event.sender !== mainWindow.webContents
  )
    return;
  if (open && !lyricsGeometry) {
    const base = mainWindow.getBounds();
    const area = screen.getDisplayMatching(base).workArea;
    const [minimumWidth = 360, minimumHeight = 560] =
      mainWindow.getMinimumSize();
    const geometry = {
      base,
      expanded: expandForLyrics(base, area),
      minimumSize: [minimumWidth, minimumHeight] as [number, number],
    };
    lyricsGeometry = geometry;
    mainWindow.setMinimumSize(
      Math.min(area.width, minimumWidth + LYRICS_SIDEBAR_WIDTH),
      minimumHeight,
    );
    mainWindow.setBounds(geometry.expanded);
    geometry.expanded = mainWindow.getBounds();
  } else if (!open && lyricsGeometry) {
    captureWindowBounds(mainWindow);
    const minimumSize = lyricsGeometry.minimumSize;
    lyricsGeometry = null;
    mainWindow.setMinimumSize(...minimumSize);
    mainWindow.setBounds(windowStyle());
  }
});

function sendNowPlaying() {
  if (nowPlayingPollInFlight || !mainWindow || mainWindow.isDestroyed()) return;
  const epoch = pollEpoch;
  nowPlayingPollInFlight = true;
  void nowPlaying
    .getNowPlaying()
    .then((track) => {
      if (epoch !== pollEpoch) return; // polling stopped while this read was in flight
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("now-playing:changed", track);
      }
      contextEngine.onTrack(track);
    })
    .catch(() => undefined)
    .finally(() => {
      nowPlayingPollInFlight = false;
    });
}

function startPolling() {
  if (pollTimer) return;
  pollEpoch += 1;
  sendNowPlaying();
  pollTimer = setInterval(sendNowPlaying, POLL_INTERVAL_MS);
}

function stopPolling() {
  pollEpoch += 1;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  contextEngine.stop();
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
    stopPolling();
  } else {
    showWindow();
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  app.focus({ steal: true });
  startPolling();
}

function createWindow() {
  const preload = path.join(__dirname, "preload.js");
  const window = new BrowserWindow(
    createWindowOptions(preload, {
      ...windowStyle(),
      show: false,
    }),
  );

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  window.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      captureWindowBounds(window);
      void saveWindowState(stateFile(), state);
      stopPolling();
      window.hide();
    }
  });
  window.on("moved", () => captureWindowBounds(window));
  window.on("resized", () => captureWindowBounds(window));

  mainWindow = window;
  window.once("ready-to-show", showWindow);
  loadRenderer(window);
}

function createTray() {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Linerfy");
  tray.on("click", () => toggleWindow());
}

ipcMain.handle("now-playing:get", async () => {
  if (process.platform !== "darwin") return null;
  return nowPlaying.getNowPlaying();
});

ipcMain.handle("playback:control", async (_event, action: PlaybackAction) => {
  if (process.platform !== "darwin") return;
  // `action` is a fixed enum value, validated by the bridge; the bundled
  // program for that action runs, nothing else.
  await nowPlaying.control(action);
  sendNowPlaying();
});

ipcMain.handle("playback:seek", async (_event, positionMs: unknown) => {
  if (process.platform !== "darwin") return;
  if (
    typeof positionMs !== "number" ||
    !Number.isFinite(positionMs) ||
    positionMs < 0
  ) {
    return; // reject non-finite or negative input
  }
  const track = await nowPlaying.getNowPlaying();
  const durationMs = track?.durationMs;
  if (durationMs === undefined || durationMs <= 0) return;
  // Bound the seek to the current song's duration; the value crosses the bridge
  // as a number and is passed to the player as a separate argv, never spliced
  // into a program string or a shell.
  await nowPlaying.seek(Math.min(positionMs, durationMs));
  sendNowPlaying();
});

ipcMain.handle("auth:get-state", () => loginState());

// Re-request the current album without a track change, sign-out, or app
// restart. Used by the renderer's retry button after a failed fetch. `rearm`
// bypasses the active-track-key guard so the same album re-enters the
// requestable state.
ipcMain.handle("context:retry", async () => {
  if (process.platform !== "darwin") return;
  const track = await nowPlaying.getNowPlaying();
  contextEngine.rearm(track, true);
});

// Fetch lyrics for the current track from LRCLIB (the only allowed source).
// The main process reads its own current track; the renderer never passes a
// URL or a key. The result carries the track key so the renderer can discard a
// stale response after a track change.
let lyricsRequest: AbortController | null = null;
ipcMain.handle("lyrics:get", async () => {
  lyricsRequest?.abort();
  const request = new AbortController();
  lyricsRequest = request;
  try {
    if (process.platform !== "darwin") {
      return { status: "unavailable", trackKey: "" };
    }
    const track = await nowPlaying.getNowPlaying();
    if (!track) {
      return { status: "unavailable", trackKey: "" };
    }
    return await fetchLyrics(net.fetch, track, request.signal);
  } finally {
    if (lyricsRequest === request) lyricsRequest = null;
  }
});

ipcMain.handle("auth:sign-out", () => {
  tokenStore?.clear();
  contextEngine.stop();
  sendContext({ status: "idle" });
  sendAuthState();
});

ipcMain.handle("auth:sign-in", async (): Promise<SignInResult> => {
  const config = oauthConfig();
  if (!config) {
    return {
      status: "error",
      message: "OAuth 未配置：缺少 SUPABASE_URL 或 SUPABASE_PUBLISHABLE_KEY",
    };
  }
  try {
    const session = await performOAuthFlow(
      config,
      (url) => shell.openExternal(url),
      net.fetch,
    );
    tokenStore?.save(JSON.stringify(session));
    sendAuthState();
    // Re-request the current album now that a session exists; `rearm` bypasses
    // the active-track-key guard so a signed-out poll doesn't block the request.
    void nowPlaying.getNowPlaying().then((track) => contextEngine.rearm(track));
    return loginState();
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
});

const isPrimaryInstance = app.requestSingleInstanceLock();

if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  void app.whenReady().then(async () => {
    // App-local DNS: avoid incorrect answers from the system resolver without
    // pinning a CDN address or changing macOS network/proxy preferences.
    if (process.env.LINERFY_USE_SYSTEM_DNS !== "1") {
      app.configureHostResolver({
        secureDnsMode: "secure",
        secureDnsServers: [
          "https://1.1.1.1/dns-query",
          "https://1.0.0.1/dns-query",
        ],
      });
    }
    state = await loadWindowState(stateFile());
    tokenStore = createTokenStore(tokenFile(), safeCrypto);
    createTray();
    createWindow();
    globalShortcut.register(TOGGLE_SHORTCUT, () => toggleWindow());
    app.on("activate", showWindow);
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  stopPolling();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

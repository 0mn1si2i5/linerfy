import { MusicContextCard } from "@linerfy/ui";
import type { NowPlayingTrack } from "@linerfy/now-playing";
import {
  ChevronLeft,
  Disc3,
  ListMusic,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { StrictMode, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";

import type { LoginState } from "./auth-state";
import {
  contextStatusLabel,
  trackKey,
  type ContextState,
} from "./context-state";
import { lyricsTrackKey, type LyricsResult } from "./lyrics";
import { LyricsPanel } from "./lyrics-panel";
import "./renderer.css";

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "no-playback" }
  | { kind: "playing"; track: NowPlayingTrack };

function DesktopApp() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [auth, setAuth] = useState<LoginState>({ status: "signed-out" });
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [context, setContext] = useState<ContextState>({ status: "idle" });
  const [scrubPosition, setScrubPosition] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyrics, setLyrics] = useState<{
    key: string;
    result: LyricsResult;
  } | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsRetry, setLyricsRetry] = useState(0);
  useEffect(() => {
    void window.linerfy
      .setLyricsOpen(lyricsOpen)
      .catch(() => setLyricsOpen(false));
  }, [lyricsOpen]);

  useEffect(() => {
    let mounted = true;

    // Initial read, then the main process pushes updates while the window is open.
    void window.linerfy
      .getNowPlaying()
      .then((track) => {
        if (mounted)
          setView(track ? { kind: "playing", track } : { kind: "no-playback" });
      })
      .catch(() => {
        if (mounted) setView({ kind: "error" });
      });
    const stopNowPlaying = window.linerfy.onNowPlayingChanged((track) => {
      setView(track ? { kind: "playing", track } : { kind: "no-playback" });
    });

    void window.linerfy.getAuthState().then((state) => {
      if (mounted) setAuth(state);
    });
    const stopAuthState = window.linerfy.onAuthStateChanged((state) =>
      setAuth(state),
    );

    const stopContext = window.linerfy.onContextChanged((state) =>
      setContext(state),
    );

    return () => {
      mounted = false;
      stopNowPlaying();
      stopAuthState();
      stopContext();
    };
  }, []);

  async function handleSignIn() {
    setSigningIn(true);
    setAuthError(null);
    const result = await window.linerfy.signIn();
    setSigningIn(false);
    if (result.status === "error") setAuthError(result.message);
    // On success the main process broadcasts auth:state, which updates `auth`.
  }

  const playingTrack = view.kind === "playing" ? view.track : null;
  // `failed` still carries whatever was published before the failure; show it
  // rather than dropping already-delivered content.
  const contentContext =
    context.status === "ready" || context.status === "partial"
      ? context.context
      : (context.status === "failed" ||
            context.status === "error" ||
            context.status === "retrying") &&
          context.context
        ? context.context
        : null;
  const releaseYear = contentContext?.release.year ?? null;
  const contextLabel = playingTrack
    ? contextStatusLabel(auth.status, context)
    : null;
  const isFailed = context.status === "failed" || context.status === "error";
  const waiting =
    auth.status === "signed-in" &&
    playingTrack !== null &&
    (context.status === "loading" ||
      context.status === "retrying" ||
      ((context.status === "queued" ||
        context.status === "running" ||
        context.status === "partial") &&
        !context.paused));
  const albumKey = playingTrack ? trackKey(playingTrack) : null;
  const [waitSeconds, setWaitSeconds] = useState(0);
  useEffect(() => {
    setWaitSeconds(0);
    if (!waiting) return;
    const started = Date.now();
    const timer = window.setInterval(
      () => setWaitSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [waiting, albumKey]);
  const statusMessage =
    isFailed && contentContext
      ? `${contextLabel}，已保留已加载内容`
      : contextLabel;

  const durationMs = playingTrack?.durationMs;
  const positionMs = playingTrack?.positionMs;
  const showProgress = durationMs !== undefined && positionMs !== undefined;
  const scrubValue = scrubPosition ?? positionMs ?? 0;
  const seekPercent =
    showProgress && durationMs !== undefined && durationMs > 0
      ? Math.min(100, Math.max(0, (scrubValue / durationMs) * 100))
      : 0;

  // A stable *track* identity (not album) so an uncommitted seek drag is cleared
  // the moment the track changes, while a now-playing poll for the same track
  // does not wipe it.
  const trackId = playingTrack
    ? `${playingTrack.provider}\u0000${playingTrack.artist}\u0000${playingTrack.title}`
    : null;
  useEffect(() => {
    setScrubPosition(null);
  }, [trackId]);

  // Load lyrics on first expand and re-request when the track changes while
  // expanded. Reuse the current result; a stale response for a previous track is
  // discarded by its track key.
  const lyricsKey = playingTrack ? lyricsTrackKey(playingTrack) : null;
  useEffect(() => {
    if (!lyricsOpen || !lyricsKey) {
      setLyricsLoading(false);
      return;
    }
    if (lyrics?.key === lyricsKey && lyrics.result.status !== "error") {
      setLyricsLoading(false);
      return;
    }
    let cancelled = false;
    setLyricsLoading(true);
    void window.linerfy
      .getLyrics()
      .then((result) => {
        if (cancelled) return;
        if (result.trackKey === lyricsKey) {
          setLyrics({ key: result.trackKey, result });
        } else {
          setLyrics({
            key: lyricsKey,
            result: {
              status: "error",
              trackKey: lyricsKey,
              message: "曲目已变化，请重试",
            },
          });
        }
      })
      .catch(() => {
        if (!cancelled)
          setLyrics({
            key: lyricsKey,
            result: {
              status: "error",
              trackKey: lyricsKey,
              message: "歌词请求未完成",
            },
          });
      })
      .finally(() => {
        if (!cancelled) setLyricsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lyricsOpen, lyricsKey, lyricsRetry]);

  async function handleRetry() {
    setRetrying(true);
    try {
      await window.linerfy.retryContext();
    } finally {
      setRetrying(false);
    }
  }

  // A brief failure note for playback/seek; consecutive clicks are only
  // suppressed by the promise, no player state machine is introduced.
  async function runControl(action: () => Promise<void>, label: string) {
    setPlaybackError(null);
    try {
      await action();
    } catch {
      setPlaybackError(`${label}失败`);
    }
  }

  async function commitSeek() {
    if (scrubPosition === null) return;
    const target = scrubPosition;
    setScrubPosition(null);
    setPlaybackError(null);
    try {
      await window.linerfy.seekTo(target);
    } catch {
      setPlaybackError("跳转失败");
    }
  }

  const retryButton = (
    <button
      className="retry-button"
      type="button"
      disabled={retrying}
      onClick={() => void handleRetry()}
    >
      {retrying ? "重试中…" : "重试"}
    </button>
  );

  return (
    <main className="companion">
      <header className="companion-header">
        <span className="brand">Linerfy</span>
        <div className="header-actions">
          {auth.status === "signed-in" ? (
            <>
              <button
                className="auth-toggle"
                type="button"
                title="已登录 · 退出登录"
                onClick={() => void window.linerfy.signOut()}
              >
                退出登录
              </button>
            </>
          ) : (
            <button
              className="auth-toggle"
              type="button"
              title="使用 GitHub 登录"
              disabled={signingIn}
              onClick={() => void handleSignIn()}
            >
              {signingIn ? "登录中…" : "登录"}
            </button>
          )}
        </div>
      </header>

      <div className={`companion-workspace${lyricsOpen ? " lyrics-open" : ""}`}>
        <div className="companion-content">
          {authError ? (
            <p className="auth-error" role="alert">
              {authError}
            </p>
          ) : null}

          {view.kind === "loading" ? (
            <p className="now-playing muted">读取当前播放…</p>
          ) : view.kind === "error" ? (
            <p className="now-playing muted">无法读取当前播放</p>
          ) : view.kind === "no-playback" ? (
            <p className="now-playing muted">未检测到正在播放的音乐</p>
          ) : playingTrack ? (
            <>
              <section className="album-context" aria-label="当前专辑">
                <span className="album-artwork-frame">
                  <Disc3
                    className="album-artwork-placeholder"
                    strokeWidth={1}
                    aria-hidden="true"
                  />
                  {playingTrack.artworkUrl ? (
                    <img
                      key={playingTrack.artworkUrl}
                      className="album-artwork"
                      src={playingTrack.artworkUrl}
                      alt={`${playingTrack.album} 封面`}
                      referrerPolicy="no-referrer"
                      onError={(event) => {
                        event.currentTarget.style.opacity = "0";
                      }}
                      onLoad={(event) => {
                        event.currentTarget.style.opacity = "1";
                      }}
                    />
                  ) : null}
                </span>
                <div className="album-copy">
                  <h1 className="track-title" title={playingTrack.title}>
                    {playingTrack.title}
                  </h1>
                  <p className="album-meta">{playingTrack.artist}</p>
                  <p className="album-title">
                    {playingTrack.album}
                    {releaseYear ? ` · ${releaseYear}` : ""}
                  </p>
                </div>
              </section>
              <section className="current-track" aria-label="播放控制">
                {showProgress ? (
                  <div className="playback-row">
                    <span className="track-time">{formatTime(scrubValue)}</span>
                    <input
                      className="seek-bar"
                      type="range"
                      min={0}
                      max={durationMs}
                      value={scrubValue}
                      style={
                        {
                          "--seek-fill": `${seekPercent}%`,
                        } as CSSProperties
                      }
                      onChange={(event) =>
                        setScrubPosition(Number(event.target.value))
                      }
                      onPointerUp={() => void commitSeek()}
                      onKeyUp={() => void commitSeek()}
                      aria-label="播放进度"
                    />
                    <span className="track-time">{formatTime(durationMs)}</span>
                  </div>
                ) : null}
                <div className="transport">
                  <button
                    className="transport-button"
                    type="button"
                    aria-label="上一首"
                    onClick={() =>
                      void runControl(() => window.linerfy.previous(), "上一首")
                    }
                  >
                    <SkipBack aria-hidden="true" />
                  </button>
                  <button
                    className="transport-button primary"
                    type="button"
                    aria-label={
                      playingTrack.state === "playing" ? "暂停" : "播放"
                    }
                    onClick={() =>
                      void runControl(
                        () => window.linerfy.togglePlayback(),
                        "播放/暂停",
                      )
                    }
                  >
                    {playingTrack.state === "playing" ? (
                      <Pause aria-hidden="true" />
                    ) : (
                      <Play aria-hidden="true" />
                    )}
                  </button>
                  <button
                    className="transport-button"
                    type="button"
                    aria-label="下一首"
                    onClick={() =>
                      void runControl(() => window.linerfy.next(), "下一首")
                    }
                  >
                    <SkipForward aria-hidden="true" />
                  </button>
                  <button
                    className="lyrics-toggle icon-button"
                    type="button"
                    aria-label={lyricsOpen ? "收起歌词" : "展开歌词"}
                    title={lyricsOpen ? "收起歌词" : "歌词"}
                    aria-expanded={lyricsOpen}
                    aria-controls="lyrics-sidebar"
                    onClick={() => setLyricsOpen((open) => !open)}
                  >
                    <ListMusic size={19} aria-hidden="true" />
                  </button>
                </div>
                {playbackError ? (
                  <p className="playback-error" role="status">
                    {playbackError}
                  </p>
                ) : null}
              </section>
            </>
          ) : null}

          {statusMessage ? (
            <div className="context-status-wrap">
              {waiting ? (
                <progress
                  className="context-activity"
                  aria-label="乐评处理中"
                />
              ) : null}
              <div className="context-status-copy">
                <p
                  className={`context-status ${isFailed ? "error" : "muted"}`}
                  role="status"
                >
                  {statusMessage}
                </p>
                {waiting ? (
                  <p className="context-wait">
                    已等待 {waitSeconds} 秒
                    {waitSeconds >= 60 ? " · 服务响应较慢" : ""}
                  </p>
                ) : null}
              </div>
              {isFailed ? retryButton : null}
            </div>
          ) : null}
          {auth.status === "signed-in" && contentContext ? (
            <div className="context">
              <MusicContextCard
                context={contentContext}
                showReleaseHeader={false}
              />
            </div>
          ) : null}
        </div>
        <aside
          id="lyrics-sidebar"
          className="lyrics-sidebar"
          aria-label="歌词"
          aria-hidden={!lyricsOpen}
          inert={!lyricsOpen}
        >
          <div className="lyrics-sidebar-inner">
            <div className="lyrics-sidebar-header">
              <h2>歌词</h2>
              <button
                className="icon-button lyrics-close"
                type="button"
                aria-label="收起歌词"
                title="收起歌词"
                onClick={() => {
                  setLyricsOpen(false);
                  document
                    .querySelector<HTMLButtonElement>(".lyrics-toggle")
                    ?.focus();
                }}
              >
                <ChevronLeft size={19} aria-hidden="true" />
              </button>
            </div>
            {lyricsOpen ? (
              <>
                <LyricsPanel
                  track={playingTrack}
                  result={lyrics?.key === lyricsKey ? lyrics.result : null}
                  loading={lyricsLoading}
                />
                {!playingTrack ? (
                  <p className="lyrics-note muted">未检测到正在播放的音乐</p>
                ) : null}
                {!lyricsLoading &&
                lyrics?.key === lyricsKey &&
                lyrics.result.status === "error" ? (
                  <button
                    type="button"
                    className="retry-button"
                    onClick={() => setLyricsRetry((value) => value + 1)}
                  >
                    重试歌词
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </aside>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing desktop root element");
createRoot(root).render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
);

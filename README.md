# Linerfy

个人音乐实验：自己使用，最多与室友分享安装方式；没有商用计划，也不以商用审核、应用商店发布或企业级运维束缚开发。保留必要的登录和密钥保护，是为了保护个人测试账户；应用不限制模型消费，真实费用由模型服务商计费。

A personal music experiment for the author and occasional roommate testing. There is no commercial roadmap, store-release process or enterprise-operations requirement. Basic login and secret protection protect the personal account; the app does not cap model usage, and the model provider bills the real cost.

> 依附于正在播放的音乐的 macOS 乐评 companion。不打断听歌，只在你想了解时出现。
>
> A macOS music-criticism companion that sits next to what is playing. It never interrupts listening; it surfaces context only when you want it.

Linerfy 在你用 Spotify 或 Apple Music 听歌时识别当前曲目，并在一个轻量的菜单栏窗口里展示曲风、相关标签、来源评分、单来源中文总结、跨来源综合观点和原文链接。只有你想深入了解时才离开 Linerfy 前往原始来源。

Linerfy identifies the current track while you listen on Spotify or Apple Music, and shows genres, tags, source ratings, per-source Chinese summaries, cross-source consensus, and original links in a lightweight menu-bar window. You leave Linerfy for the original source only when you want to go deeper.

v1 不建设搜索、内容首页、推荐、收藏、社交、评论、播放历史或独立音乐浏览体验。

v1 ships no search, content home, recommendations, favorites, social features, comments, play history, or standalone music browsing.

## 形态 / Shape

- **macOS companion**（`apps/desktop`）：菜单栏与快捷键打开可移动、可缩放窗口，读取当前播放、登录、控制播放并展示专辑语境。Movable, resizable desktop window for login, current playback, playback controls and album context.
- **Vercel API**（`apps/web`）：`POST /api/context` 负责认证后的任务创建、状态读取与显式重试；`/`、`/login`、`/auth/callback` 仅用于登录。Authenticated context API and login pages only.
- **采集**（`ingest`）：独立 Vercel Python Function `/api/enrichment`，处理实体、来源和总结。新任务异步唤醒 worker，Supabase Cron 每分钟补偿；客户端轮询只读取状态。Separate Python worker, asynchronously woken for new jobs with cron recovery; desktop polling reads progress.
- **存储**（`supabase/migrations`）：catalog、enrichment jobs 与行级权限。

## 正式数据来源 / Authorized sources

v1 默认启用的来源仅包括：MusicBrainz、Wikidata、CritiqueBrainz、Wikipedia（仅 MediaWiki API 的 Reception / Critical reception 内容）。

The only v1 sources are MusicBrainz, Wikidata, CritiqueBrainz, and Wikipedia (Reception via the MediaWiki API).

Guardian、Pitchfork、Album of the Year、Metacritic、Rate Your Music、Reddit 等没有适当自动化授权或许可不清晰的来源不属于正式 v1：不开发绕过限制的抓取器；旧 Guardian adapter 仅作参考保留并默认关闭，不进入生产流水线。

Guardian, Pitchfork, AOTY, Metacritic, RYM, Reddit, and other unlicensed or unauthorized sources are not part of v1: no bypass scrapers, and the legacy Guardian adapter is kept reference-only and disabled by default.

## 产品边界 / Product boundaries

内容展示层级（从上到下）：当前播放与封面 → 曲风 → 相关标签 → 综合观点 → 各来源卡片 → 原文链接。Display order: now-playing + cover → genres → related tags → consensus → source cards → original links.

桌面界面不展示机械截断的摘录或“许可与署名”折叠区；来源链接与后端文档级溯源、许可数据仍保留。The desktop omits truncated excerpts and license disclosure panels; source links and backend document-level provenance/license metadata remain.

- 综合观点仅在至少两个许可证兼容的来源之间合成；单来源总结也按文档许可分池，未知许可不猜测。Consensus requires two compatible sources; source summaries also stay within document-level license pools, with no assumed permission for unknown licenses.
- 曲风、评分和已发布来源可先于总结显示。一个来源失败不清空已有内容，显式重试恢复原任务，不创建重复队列。Metadata, ratings and published sources appear progressively; failures preserve content and explicit retries resume the existing job.
- 每条公开 claim 必须能追溯到已保存的 review document；全文永不公开，仅元数据、短摘录/转述与原文链接进入公开输出。Every public claim traces to a stored review document; full text is never public.
- 评分保留原始量表与票数（少于 5 票标「样本较少」），不生成 Linerfy 自有综合分。Ratings keep their original scale and vote count; no Linerfy composite score.
- track 无独立乐评时优先展示所属专辑资料并标「专辑乐评」；无法可靠匹配时显示原元数据与「无法可靠匹配」，不猜测、不写污染实体。Tracks without their own reviews fall back to album material labelled "album review"; unverifiable matches show the raw metadata and "unable to match" rather than guessing.
- 模型用于翻译、归纳与压缩，不是事实来源；部署时只激活一个模型，不提供用户模型选择，也不自动跨模型 fallback。The model summarizes and compresses; it is not a source of facts. One model is active at a time with no automatic fallback.

## 认证与隐私 / Auth & privacy

- 登录使用 Supabase Auth 的 GitHub OAuth，并以 GitHub 数字用户 ID 校验 Vercel 环境变量白名单。
- catalog 与内容 API 仅允许已登录且在白名单内的用户访问；取消匿名 Supabase catalog 读取。
- macOS 登录完成后把 session/refresh token 存入 Keychain；renderer 只得到最小登录状态，不接触长期令牌或服务端密钥。
- service-role、来源 API key、模型 key 只存在于服务端或 ingestion/worker 环境。
- 不保存连续播放历史；日志只记录任务 ID、阶段、耗时、provider、token usage、错误分类和时间，不含全文、prompt、密钥或播放历史。

Auth uses Supabase Auth GitHub OAuth, gated by a numeric GitHub ID whitelist in Vercel env. Catalog and content APIs are available only to logged-in, whitelisted users; anonymous catalog reads are removed. The macOS app stores session/refresh tokens in Keychain; the renderer only sees minimal login state. No continuous play history is kept, and logs never contain full text, prompts, secrets, or play history.

## 本地运行 / Local setup

需要 Node.js 24、pnpm 11、Python 3.12 和 uv。Requires Node.js 24, pnpm 11, Python 3.12, and uv.

```bash
pnpm install
pnpm --filter @linerfy/desktop dev   # macOS companion
pnpm --filter @linerfy/web dev       # API + OAuth + smoke
```

打包并打开桌面版：

```bash
pnpm package:desktop
open "apps/desktop/out/Linerfy-darwin-arm64/Linerfy.app"
```

桌面构建会把 Supabase URL、publishable key 和 Web API URL 作为公开客户端配置写入应用；service-role、模型 key 和 worker secret 永不进入桌面包。打开后点菜单栏里的 Linerfy 图标，或按 `⌘⇧L`。网页不会也不能直接读取 macOS 播放器。

Build and open the desktop app with the commands above. The build embeds only public client configuration (Supabase URL, publishable key, and Web API URL); server and model secrets never enter the app. Open it from the menu bar or press `⌘⇧L`. The website does not read macOS playback directly.

第一次读取 Spotify 或 Music 时，macOS 会请求 Automation 权限。应用只通过最小 preload bridge 接收当前曲目的元数据，播放器元数据始终视为不可信输入。

macOS requests Automation permission on first access. Only current-track metadata crosses the narrow preload bridge; player metadata is always treated as untrusted input.

## 采集与运行命令 / Ingestion & admin

无参数运行只显示帮助并退出，绝不写数据库。Running with no arguments prints help and exits, never writing.

```bash
cd ingest
python -m linerfy_ingest --run-enrichment   # 运行一个 worker tick
python -m linerfy_ingest --pause            # 全局暂停模型生成
python -m linerfy_ingest --resume           # 恢复模型生成
python -m linerfy_ingest --jobs             # 列出 enrichment 队列
python -m linerfy_ingest --retry-failed     # 重新入队失败任务
python -m linerfy_ingest --purge            # 清理过期私有正文
```

## 验证 / Verification

```bash
pnpm check
pnpm --filter @linerfy/desktop package   # 生成本地 Electron 包
cd ingest
uv run ruff check .
uv run pytest
```

未签名 Electron 包输出到 `apps/desktop/out/`，仅用于手动分享与边界验证。公开分发需要 Apple 签名与 notarization（v1 不实现）。

The unsigned Electron package is written to `apps/desktop/out/` for manual sharing and boundary verification. Public distribution requires Apple signing and notarization (not in v1).

## 当前状态 / Status

当前流水线为 `resolve_entity → fetch_sources → build_source_summaries → build_consensus`，按来源和许可池原子发布。来源覆盖仍有限：Wikipedia 是背景资料，CritiqueBrainz 是社区评论，不能替代专业媒体乐评。缺少内容时不让模型补写。

The four-stage pipeline publishes atomically per source/license pool. Coverage remains limited: Wikipedia provides background and CritiqueBrainz community reviews, not professional media coverage. Missing reviews are never fabricated.

本地测试通过不代表生产验收：发布时需分别核对迁移、Web/worker 实际部署、桌面包和真实登录/播放会话。Docker/Postgres 仅为可选的隔离测试环境，不是用户安装依赖。

Local checks do not establish production readiness: verify migrations, both deployments, the packaged app and a real session separately. Docker/Postgres are optional isolated test tools, not installation requirements.

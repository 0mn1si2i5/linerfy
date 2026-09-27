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

## 当前数据来源 / Current sources

乐评链路接入 MusicBrainz、Wikidata、CritiqueBrainz、Wikipedia（Reception / Critical reception），并沿已核对专辑页面的引用获取 Pitchfork 原文。Pitchfork 再核对结构化数据中的艺人、专辑、URL 和正文；没有引用或无法确认时留空，不伪造评分。

Review inputs include MusicBrainz, Wikidata, CritiqueBrainz, Wikipedia Reception and Pitchfork reviews linked by verified album pages. Pitchfork independently checks artist, album, URL and review body in structured data. Missing references or unverified content remain absent; missing scores are not invented.

这不是来源审批白名单。新增实验来源根据实际获取质量与维护成本选择，不要求先完成商用授权流程。Guardian 旧适配器目前未接入自动流水线；Pitchfork 依赖可发现的引用，不能保证每张专辑都有覆盖。

This is not a source-approval whitelist. Experimental additions are evaluated for data quality and maintenance cost, not commercial clearance. The legacy Guardian adapter is not wired into the automatic pipeline; Pitchfork discovery depends on available references and does not guarantee coverage.

歌词使用 LRCLIB，按需在右侧展开，逐句同步或回退普通文本，不经过模型或乐评队列。手动滚动暂停跟随，点击“回到当前句”恢复；收起归还侧栏宽度，保留用户移动、缩放后的窗口。

LRCLIB lyrics load on demand in a right-side panel, with synchronized lines or plain-text fallback, independently of the review queue/model. Manual scrolling suspends following; returning to the current line resumes it. Closing removes only the panel width and preserves user window movement/resizing.

## 产品边界 / Product boundaries

内容展示层级（从上到下）：当前播放与封面 → 曲风 → 相关标签 → 综合观点 → 各来源卡片 → 原文链接。Display order: now-playing + cover → genres → related tags → consensus → source cards → original links.

桌面界面不展示机械截断的摘录或“许可与署名”折叠区；来源链接与后端文档级溯源、许可数据仍保留。The desktop omits truncated excerpts and license disclosure panels; source links and backend document-level provenance/license metadata remain.

- 现有生成器按来源和许可字段分组，综合观点要求至少两个独立评论来源；Wikipedia 的转述不作为额外评论者重复计数。分池是历史实现，不是项目的合规目标。The generator groups by source/license metadata and requires two independent review sources for consensus; Wikipedia quotations do not count as an extra critic. Pooling is a legacy implementation, not a compliance objective.
- 总结优先解释声音、演唱、编曲、歌词及评论者的具体判断，不用销量、榜单凑数；无正文时不拿标题代替。Cards prioritize direct media, then community, then background. Summaries focus on musical detail and attributed judgments, not sales/chart filler; missing bodies are never replaced with titles.
- 曲风、评分和已发布来源可先于总结显示。一个来源失败不清空已有内容，显式重试恢复原任务，不创建重复队列。Metadata, ratings and published sources appear progressively; failures preserve content and explicit retries resume the existing job.
- 每条总结必须能追溯到已保存的 review document；乐评全文不进入界面，歌词独立按需显示。Every claim traces to a stored review document; the UI omits full reviews and loads lyrics independently on demand.
- 评分保留原始量表与票数（少于 5 票标「样本较少」），不生成 Linerfy 自有综合分。Ratings keep their original scale and vote count; no Linerfy composite score.
- 乐评资料对应当前曲目所属专辑，专辑名保留在曲目头；无法可靠匹配时显示原元数据与明确状态，不猜测、不写污染实体。Reviews refer to the current track's album, named in the track header; unverifiable matches retain player metadata and an explicit status rather than guessing.
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

桌面默认在应用内使用 Cloudflare 加密 DNS，作为网络解析选择；不修改 macOS DNS/代理，也不固定服务端 IP。若特殊网络依赖系统 DNS、代理或局域网分流，应优先用 `LINERFY_USE_SYSTEM_DNS=1` 启动排查。网络请求单次最多 8 秒，自动重试一次并显示重连状态；网络、服务端错误与权限错误分别说明，已有乐评不会被清空。

The desktop uses app-local Cloudflare DNS-over-HTTPS as a resolver choice without changing macOS DNS/proxy settings or pinning service IPs. If a special network depends on system DNS, a proxy, or split-horizon resolution, start with `LINERFY_USE_SYSTEM_DNS=1` when troubleshooting. Each context request is bounded to eight seconds with one visible retry; connection, server and permission errors stay distinct, and delivered content is preserved.

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

Forge 默认输出到 `apps/desktop/out/`，当前可用测试包复制到仓库根 `Linerfy.app`（Git 忽略）。临时构建优先放系统临时目录，过期包进入废纸篓，不在 Zen 下累积备份文件夹。开发包临时签名变化可能触发 Keychain 再次确认，用户已选择保留加密自动登录。

Forge defaults to `apps/desktop/out/`; the current test app is copied to root `Linerfy.app` and ignored by Git. Build in system temporary directories where practical and trash obsolete packages instead of accumulating Zen backup folders. Changing ad-hoc signatures can trigger Keychain authorization again; encrypted automatic login remains intentional.

## 当前状态 / Status

当前流水线为 `resolve_entity → fetch_sources → build_source_summaries → build_consensus`，按来源和许可池原子发布。Wikipedia 是背景资料，CritiqueBrainz 是社区评论，Pitchfork 为直接获取的专业乐评；来源覆盖仍有限，缺少内容时不让模型补写。

来源总结每次最多两路并行，完成一路便发布一路；重新处理任务时，总结缓存同时核对语料、模型与提示词版本，不主动批量刷新旧任务。Source summaries run at most two at a time and publish independently. Reprocessed jobs match corpus, model and prompt version before reusing summaries; existing jobs are not bulk-refreshed automatically.

The four-stage pipeline publishes atomically per source/license pool. Wikipedia provides background, CritiqueBrainz community reviews, and Pitchfork directly retrieved criticism. Coverage remains limited; missing reviews are never fabricated.

本地测试通过不代表生产验收：发布时需分别核对迁移、Web/worker 实际部署、桌面包和真实登录/播放会话。Docker/Postgres 仅为可选的隔离测试环境，不是用户安装依赖。

Local checks do not establish production readiness: verify migrations, both deployments, the packaged app and a real session separately. Docker/Postgres are optional isolated test tools, not installation requirements.

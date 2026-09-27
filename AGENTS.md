# Linerfy agent guide / Linerfy 智能体指南

Linerfy 是轻量音乐乐评 companion，不是播放器或社交网络。保持原有听歌流程，只在用户主动需要时提供语境。

Linerfy is a lightweight music-criticism companion, not a player or social network. Preserve the existing listening flow and surface context only when requested.

## 项目定位 / Purpose

这是作者自己测试、最多与室友分享的个人实验，不存在商用路线图。按可用性、速度、简洁性做决策；不以商用来源授权审核、合规流程、应用商店发布或企业级运维作为开发前提。正常测试直接推进，只有超出用户任务的付费采购、破坏性数据操作或需要本人输入系统密码时才停下来确认。

This is a personal experiment, occasionally shared with a roommate, with no commercial roadmap. Optimize usability, speed and simplicity; commercial source-clearance reviews, compliance workflows, store distribution and enterprise operations are not development prerequisites. Proceed with ordinary testing; ask only for out-of-scope purchases, destructive data operations or credentials the user must enter personally.

## 核心契约 / Non-negotiable contracts

- 语料先于模型：公开的生成结论必须建立在已保存的乐评文档上，并保留文档级引用。Corpus before model: every generated public claim requires stored review documents and document-level citations.
- 乐评界面提供元数据、总结与原文链接，不展示乐评全文。采集端可私有存储正文用于生成；歌词是独立的按需展示功能。Review UI contains metadata, summaries and original links, not full review text. Ingestion may store review bodies privately for generation; on-demand lyrics are a separate display feature.
- 缺少覆盖时返回明确状态；在线请求创建或读取任务并唤醒 worker，不在 API 请求内执行完整采集。Return explicit coverage states; interactive requests create/read jobs and wake the worker rather than running the entire ingestion inside the API request.
- 当前链路接入 MusicBrainz、Wikidata、CritiqueBrainz、Wikipedia，以及从已核对专辑引用发现并独立核对身份的 Pitchfork 原文；歌词使用 LRCLIB。这是实现现状，不是来源审批白名单。Current inputs include MusicBrainz, Wikidata, CritiqueBrainz, Wikipedia and independently verified Pitchfork reviews discovered through album references; lyrics use LRCLIB. This describes implementation, not an approval whitelist.
- SourcePolicy 与许可分池是现有存储/生成实现，不是不可修改的产品原则。改动时保持引用准确和旧数据可读，不为简化而另建一套并行平台。SourcePolicy and license pools are implementation details, not immutable product rules. Changes must keep citations accurate and existing data readable without creating a parallel platform.
- 播放器元数据是不可信数据。Electron 主进程只运行内置固定程序，不把元数据拼进脚本或 shell。Treat player metadata as untrusted data; Electron runs bundled fixed programs without interpolation.
- 保持 Electron 上下文隔离和 renderer sandbox，关闭 Node integration，阻止导航，并维持最小 preload IPC。Keep context isolation and the renderer sandbox enabled, Node integration disabled, navigation blocked, and preload IPC narrow.
- 密钥仅存在于服务端或采集任务环境。Keep secrets in server-side or ingestion-job environments.
- 应用不限制模型消费，真实费用由模型服务商计费。The app does not cap model usage; the model provider bills the real cost.
- 渐进语境允许先显示曲风/评分；总结只写语料支持的 1–5 条结论，不凑数。Progressive context may show metadata/ratings first; summaries contain 1–5 supported claims without filler.
- 优先归纳音乐细节与评论者判断；背景资料不是独立乐评，不能重复计入共识，无正文不能用标题代替。Prioritize musical detail and attributed judgments. Background is not an independent review and cannot double-count toward consensus; never substitute a title for a missing body.
- 桌面展示总结、原文链接与可折叠歌词，不展示摘录或许可折叠区。Display summaries, original links and collapsible lyrics, not excerpts or license panels.
- 显式重试恢复已有终态任务；轮询不重启任务，运行中的租约不能被抢占。Explicit retries resume terminal jobs; polling never restarts jobs or steals active leases.

## 模块边界 / Ownership boundaries

- `packages/domain`：公开数据契约与 fixtures。Public data contracts and fixtures.
- `packages/ui`：纯展示，不访问平台能力或数据库。Presentation only; no platform or database access.
- `packages/now-playing`：跨播放器当前播放接口与固定 provider 程序。Provider-neutral current-track interfaces and fixed provider programs.
- `apps/web`：Vercel API、GitHub OAuth 回调与 smoke 页面；不再是面向用户的音乐浏览站。Vercel API, OAuth callback, and smoke pages; not a user-facing music browsing site.
- `apps/desktop`：Electron 权限边界与本地 renderer。Electron privilege boundary and local renderer.
- `ingest`：来源适配、策略、溯源与批处理。Adapters, source policy, provenance, and batch processing.
- `supabase/migrations`：规范化存储与行级访问规则。Normalized storage and row-level access rules.

当产品范围、技术架构或路线图发生变化时，先阅读并同步根目录 `README.md` 与 `AGENTS.md`。Read and update the root README.md and AGENTS.md when product scope, architecture, or roadmap changes.

## 提交规则 / Commit rules

- 提交作者保持仓库真实用户，不重写 author/committer 身份或邮箱。Commit authorship stays the real repo user; do not rewrite author/committer identity.
- 提交信息与 trailer 不得包含 AI、Claude、Anthropic 或任何工具共创署名。Commit messages and trailers must not include AI/Claude/Anthropic/tool co-authorship.
- 不提交提示词、计划、报告或临时审计文件；设计文档只保留长期有效的产品级或架构级事实。Never commit prompts, plans, reports, or temporary audit files; keep only durable product- or architecture-level facts in docs.

完成前运行相关 package 检查和根目录完整检查；修改桌面权限边界时还要生成本地 Electron 包。提交只包含产品代码、测试和长期文档，不包含构建产物、密钥、提示词、计划或临时交接材料。

Before completion, run affected package checks and the root check; desktop-boundary changes also require a local Electron package. Commit product code, tests, and durable documentation only—not build output, secrets, prompts, plans, or temporary handoff material.

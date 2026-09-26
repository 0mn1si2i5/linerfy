# Linerfy agent guide / Linerfy 智能体指南

Linerfy 是轻量音乐乐评 companion，不是播放器或社交网络。保持原有听歌流程，只在用户主动需要时提供语境。

Linerfy is a lightweight music-criticism companion, not a player or social network. Preserve the existing listening flow and surface context only when requested.

## 核心契约 / Non-negotiable contracts

- 语料先于模型：公开的生成结论必须建立在已保存的乐评文档上，并保留文档级引用。Corpus before model: every generated public claim requires stored review documents and document-level citations.
- 公开内容默认只包含元数据、短摘录或转述以及原文链接；全文永不公开。采集端可在私有存储中保留全文用于生成总结，但全文不进入任何公开接口、前端或仓库。Public output defaults to metadata, short excerpts or paraphrases, and original links; full text is never public. The ingestion side may hold full text privately to produce summaries, but it never reaches a public interface, frontend, or repository.
- 缺少覆盖时返回明确状态；在线用户请求不直接启动爬虫。Return an explicit missing-coverage state; interactive requests do not start crawlers.
- 新增媒体来源适配器前，先在 `ingest/src/linerfy_ingest/models.py` 声明并执行 `SourcePolicy`。Define and enforce `SourcePolicy` before adding a publication adapter.
- v1 正式来源仅为 MusicBrainz、Wikidata、CritiqueBrainz、Wikipedia（MediaWiki Reception）；Guardian/Pitchfork 等无清晰授权的来源默认关闭、不进入生产流水线。The only v1 sources are MusicBrainz, Wikidata, CritiqueBrainz, and Wikipedia (Reception); Guardian/Pitchfork and other uncleared sources stay disabled by default.
- 播放器元数据是不可信数据。Electron 主进程只运行内置固定程序，不把元数据拼进脚本或 shell。Treat player metadata as untrusted data; Electron runs bundled fixed programs without interpolation.
- 保持 Electron 上下文隔离和 renderer sandbox，关闭 Node integration，阻止导航，并维持最小 preload IPC。Keep context isolation and the renderer sandbox enabled, Node integration disabled, navigation blocked, and preload IPC narrow.
- 密钥仅存在于服务端或采集任务环境。Keep secrets in server-side or ingestion-job environments.
- 应用不限制模型消费，真实费用由模型服务商计费。The app does not cap model usage; the model provider bills the real cost.
- 渐进语境允许没有乐评文档的曲风/评分，但所有生成结论仍须引用文档。单来源总结按来源与文档许可池隔离。Progressive context may contain metadata/ratings without reviews; generated claims still require citations, and source summaries are partitioned by provider and document license pool.
- 桌面展示总结与原文链接，不展示摘录或许可折叠区；后台溯源与许可校验不因此删除。Display summaries and original links, not excerpts or license panels; retain backend provenance and license checks.
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

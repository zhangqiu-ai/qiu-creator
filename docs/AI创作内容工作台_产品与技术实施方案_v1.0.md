# AI 创作内容工作台｜产品与技术实施方案 v1.0

**方案基线：2026-11-15**  
**定位：** 供个人使用的 Mac + iPhone + iPad 内容创作、素材管理、AI 优化和跨平台预览系统。第一阶段不开发自动发布，但从架构上预留 Browser Agent 发布模块。

## 1. 已确认需求与边界

1. **平台：** 只支持 macOS、iPhone、iPad；暂不考虑 App Store 上架与对外商业化。
2. **素材存放：** 原始 Markdown（`.md`）、图片、视频主要保存在持续开机的 Mac 上，Finder 可直接访问。Mac 是唯一权威内容源。
3. **三端能力：** Mac、iPhone、iPad 都能浏览、搜索、编辑、预览；在线时修改同步回 Mac，断网时允许缓存和待同步草稿。
4. **四个平台：** 小红书、微信公众号、抖音、微信视频号；提供按平台模拟的图文/视频预览和独立发布版本，但不承诺像素级还原官方 App。
5. **AI 创作：** 标题、摘要/简介、标签、改写、跨平台版本；云端与本地模型可切换。视频理解优先使用 Gemini API 直接上传视频，不要求本地先分离字幕或抽帧。
6. **统一内容接入：** 支持 AI Agent/外部工具通过 API 提交 Markdown、上传文件、提交下载 URL；支持本地文件夹监控。可以增加 CLI/MCP 适配器，但对内共用一套导入服务。
7. **发布：** 现阶段不开发自动发布。第二阶段研究 Mac 本地 Browser Agent 辅助发布，不使用平台官方发布 API；以平台允许范围和人工最终确认作为默认边界。
8. **费用：** 本地开源组件可以免费使用；Gemini 等云端 AI API、网络或第三方基础设施可能有额外费用。

## 2. 总体技术选型

| 层级 | 选型 | 原则 |
|---|---|---|
| Mac 桌面客户端 | Electron + React + Vite + TypeScript | 负责桌面文件管理、编辑、工作台体验 |
| iPhone / iPad 客户端 | React Native + Expo + TypeScript | 原生导航、素材浏览、视频播放、文件选择；iPad 响应式双栏 |
| Mac 后台服务 | Node.js + Fastify | 独立于 Electron 运行；提供 HTTP API、AI 任务、同步接口 |
| 数据库存储 | SQLite（WAL 模式，按需 FTS5） | 仅存索引、元数据、任务和版本记录，媒体文件仍在文件系统 |
| 素材与原稿 | macOS 普通目录 | 已有作品夹采用“挂载/索引”，AI 导入内容写入托管目录 |
| Markdown 编辑 | MDXEditor（桌面 Web）+ WebView 编辑页（React Native） | 第一轮优先验证中文输入、图片粘贴与 Markdown 往返保存；不可直接当原生 RN 组件 |
| 移动视频播放 | expo-video | iOS 原生播放器；Mac 可用 HTML5 视频播放 |
| 图片/目录处理 | Sharp、Chokidar | 缩略图与文件变化发现 |
| 视频元信息 | ffprobe（按许可与打包约束集成） | 时长、尺寸、编码等；不作为 Gemini 视频理解前置条件 |
| 远程访问 | Tailscale 私有网络 + 应用层鉴权 | 不把 Mac API 直接暴露到公网 |
| AI 服务 | Gemini 视频理解 + 可插拔 GPT/Claude/Gemini/本地模型 | 服务端管理密钥、任务与成本；用户主动触发远端处理 |
| 大文件导入 | 可续传上传协议（如 tus，或实现等效分块协议） | 断点续传，防止大视频掉线全部重传 |
| 项目组织 | pnpm Monorepo | 共享 TypeScript 类型、API SDK、业务规则 |

**架构拓扑：** Mac 文件目录 + SQLite ←→ Mac Fastify 常驻服务 ←→ Electron（本机）；Mac Fastify 常驻服务 ←Tailscale→ iPhone / iPad（React Native）。AI 模型由 Mac 服务端调用；云端 AI 不应默认直接访问 Mac 私网服务。

### 长期运行保障

Fastify 独立进程通过 macOS `launchd` 启动和恢复，关闭 Electron 窗口不应使手机断线。Mac 必须持续联网且不能进入阻断后台服务的睡眠状态；尤其是 MacBook 合盖场景，要实机验证而不能只依赖“长期开机”的设置。

## 3. 内容和素材的数据模型

核心实体（第一阶段即可确定 schema，避免后期迁移）：

- **Work（作品）**：`id`、`title`、`type`（article/image/video/mixed）、`status`、`tags`、`source`、`created_at`、`updated_at`。
- **Asset（素材）**：`id`、`kind`、`path`、`sha256`、`mime_type`、`bytes`、`duration`、`width`、`height`、`origin`。媒体始终是磁盘文件，而不是数据库 BLOB。
- **WorkAsset（关联）**：作品到素材的多对多关联、用途（封面/正文/视频）和顺序。
- **PlatformVariant（平台版本）**：`work_id`、`platform`、`title`、`body`、`cover_asset_id`、`tags`、`revision`。同一作品对四个平台可有不同版本。
- **Revision（版本）**：`work_id`、`revision_id`、`parent_revision_id`、`content_hash`、`created_at`、`source`，保存可恢复的历史快照。
- **ImportJob（导入任务）**：`id`、`method`、`status`、`progress`、`retry_count`、`error`、`idempotency_key`。
- **AIJob（分析任务）**：`id`、`model`、`action`、`source_revision`、`status`、`result`、`usage/cost_estimate`（如可得）、`error`。

### 本地目录策略

```text
~/CreatorHub/
  library/                  # 系统托管的 AI 导入作品
    works/<work-id>/
      source.md
      assets/
      revisions/
  cache/                    # 缩略图、波形、转码缓存，可重建
  data/                     # SQLite 数据库、导入作业记录
```

已有的外部 `.md` 文件夹采用**外部目录挂载模式**：直接索引、不强行移动。新导入作品采用**托管模式**：进入 `library/`。两种模式的 UI 一致，但文件删除/重命名/外部修改的处理需要区别对待。写回外部 `.md` 文件前进行版本核对、保留历史快照，并采用临时文件 + 原子替换避免写坏原稿。

## 4. 统一内容接入中心

### 四类入口

1. **Markdown 文本导入：** AI 工具直接提交标题、`markdown`、标签、来源和可选图片引用，后台创建作品。
2. **文件上传：** 图片、音频、视频及 `.md` 直接上传；大文件采用可续传协议。
3. **URL 导入：** 接收生成工具返回的文件下载 URL，由 Mac 发起异步下载、校验文件、保存到托管目录。
4. **本地目录监控：** 监听允许的创作文件夹、检测新增或变更；必要时先进入待确认列表，避免外部工具写一半就被重复入库。

### API 草案（示例路径，开发时可细化）

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/v1/works` | 创建 Markdown/图文作品 |
| `GET` | `/api/v1/works` | 列表、筛选、搜索、分页 |
| `GET/PATCH` | `/api/v1/works/:id` | 读取、编辑作品，附带 revision 校验 |
| `POST` | `/api/v1/assets/uploads` | 上传普通文件；大文件走续传协商 |
| `POST` | `/api/v1/imports/urls` | 提交下载 URL，返回 job ID |
| `POST` | `/api/v1/imports/folders` | 配置许可的本地监控目录（仅 Mac 管理端） |
| `GET` | `/api/v1/jobs/:id` | 查看进度、失败、重试状态 |
| `GET` | `/api/v1/assets/:id/stream` | 支持 HTTP Range 的安全视频流 |
| `GET/POST` | `/api/v1/works/:id/variants` | 获取/生成平台版本 |
| `POST` | `/api/v1/ai/jobs` | 发起 AI 改写、视频理解等任务 |
| `GET` | `/api/v1/works/:id/revisions` | 查看和恢复历史版本 |

**对 AI Agent 的对接方式：** 首先发布 OpenAPI 文档和 TypeScript 客户端 SDK；再做一个很薄的 `creatorhub` CLI 与 MCP Server 适配器，使外部 Agent 只调用现成的导入 API，避免第二套存储逻辑。为不同 Agent 分发可撤销的最小权限令牌。

**云端 AI 结果获取：** Mac 主动轮询/拉取生成结果或下载 URL；不要为了接入 Webhook 就默认公开 Mac API。URL 下载严格阻止访问回环、内网和特殊地址，设置文件大小、超时、重定向和内容类型限制，避免 SSRF 与磁盘耗尽。

### 导入完成条件

文件校验通过、持久化成功、SQLite 索引写入、素材缩略图/元数据任务入队并发出变更事件，才算导入成功。重复请求带幂等键，避免同一 AI 任务生成多份无意义副本。

## 5. 三端编辑与同步机制

- **Mac 为权威：** iPhone/iPad 通过鉴权 API 读写，不直接操作 Mac 文件系统路径。
- **在线更新：** 采用 WebSocket 或 SSE 通知内容变化；变更时移动端增量拉取。不要承诺固定毫秒级“实时”，以网络可达性为前提。
- **离线草稿：** 移动端本地保存待同步修改；恢复网络后提交，不自动覆盖更高版本。
- **冲突控制：** 每次保存传递 `base_revision` 或 `If-Match`，服务端检测冲突并返回 `409`，客户端展示“查看差异/保留双方/手动合并”。
- **原稿保护：** AI 改写先生成候选版本 + diff，用户确认后才成为新版本；始终可恢复历史。
- **文件观察：** 外部编辑器直接修改 `.md` 时，自动刷新索引；避免监听器把应用自己的保存反复回写。
- **传输：** 私有 Tailscale 网络 + 设备令牌/会话；视频接口支持 Range；移动端只缓存被查看的必要素材。

## 6. 产品页面设计

### Mac 桌面端

左侧导航：**作品库、素材库、导入任务、AI 工作台、平台预览、发布中心（第二阶段）、设置**。

- **作品库：** 列表/网格、类型筛选、标签、搜索、创作中/待审核/待发布/已发布状态、来源追踪。
- **编辑页：** Markdown 可视化/源码切换、文件关联、自动保存、版本历史、AI 建议/差异确认。
- **平台预览：** 选择小红书/公众号/抖音/视频号及对应平台版本，模拟图文版式、封面、图片顺序、长短文案及视频卡片。
- **导入任务：** 进度、来源、失败原因、重试、去重、文件去向。
- **AI 工作台：** 提示词模板、模型选择、视频直接理解、文案建议及成本/调用日志。

### iPhone / iPad

- iPhone：作品列表、搜索、编辑、移动端平台预览、视频播放、AI 操作、上传本机素材。
- iPad：同一 React Native + Expo 工程，采用双栏/大屏布局，方便文章排版和审阅。
- Markdown：将同一 Web 编辑器编译成可嵌入的编辑页面，在 RN WebView 中运行；RN 负责顶部导航、文件选择、状态栏和其他原生体验。Web 与原生通过受控消息桥连接。可后续评估 Expo DOM Components，但不把其兼容性当成未验证的前提。

### Markdown 兼容性警戒线

必须专门测试中文输入法组合输入、光标与撤销、长文章性能、代码块/表格/链接/图片、外部相对路径图片，以及 **Markdown 读入 → 编辑 → 写回 → 再读入** 的语义保持；可能改变特殊语法的文件需要源码模式或原文保护。

## 7. AI 功能

1. **标题/简介/标签推荐：** 支持四个平台分别生成候选，用户选择后写入独立平台版本。
2. **文章改写：** 润色、缩写、扩写、语气调整；展示差异，不能自动覆盖原 `.md`。
3. **Gemini 原生视频理解：** 用户在任意设备选中 Mac 已存视频后发起任务，Mac 将原始视频按 Gemini API 当前支持的上传方式送到 Google；返回摘要、重要内容时间点、拟议标题/简介/封面建议。时间戳与转写可能有误，需要允许人工核验。失败可重试并记录费用或用量信息（如接口可返回）。
4. **多模型路由：** 文案模型可切换 Claude/GPT/Gemini/本地实现；视频默认 Gemini。密钥只保存在 Mac 安全存储中，绝不下发 iPhone/iPad。
5. **重复分析控制：** 按视频文件哈希、任务类型、模型配置形成缓存键，确认是否复用先前结果或重新计费分析。

使用云端模型意味着相应文字、视频内容会发送到第三方服务；UI 需在首次使用时明确展示并提供模型选择。

## 8. 分阶段开发与可验收里程碑

**第一阶段：内容管理 + 三端编辑 + AI 创作 + 预览**（分四个内部里程碑）。

### M0｜技术可行性验证（先做，避免返工）

交付：可运行的 Mac Electron、Mac Fastify、iPhone/iPad Expo 最小工程；一个 `.md` 文件可以在三端打开、修改和写回；手机能通过 Tailscale 在外网访问 Mac；一个视频能以 Range 流方式播放。

**验收：** iPhone 中文输入、粘贴图片、撤销重做、长文滚动无阻断性故障；同一篇 Markdown 保存并重新打开后主要结构未丢失；关闭 Electron 窗口手机仍能访问服务；在 Mac 睡眠/断网时提示准确且数据不丢。

### M1｜本地素材库 + 统一接入中心

交付：目录挂载、托管素材目录、SQLite/搜索、版本记录、内容导入 API、上传/URL 导入/文件夹监控、任务列表、Agent SDK/CLI 基础入口。

**验收：** AI 请求创建 `.md` 能在 Finder 找到实体文件；URL 导入视频后能播放、生成缩略图；重复调用不会创建多份相同任务；下载失败有可读错误并可重试；外部目录原文件无无提示移动或删除。

### M2｜三端体验 + 平台模拟预览

交付：Mac 与 iPhone/iPad 完整作品管理和编辑；在线同步、断线草稿、冲突保护；四个平台的独立版本和预览模板。

**验收：** iPhone 修改标题，Mac 和 iPad 看到新版本；两端同时改同一作品会出现冲突提示而非静默覆盖；四个平台可以分别编辑标题/正文/封面，互不串改；预览明确标为模拟效果。

### M3｜AI 创作 + Gemini 视频理解

交付：标题/简介/标签、文章 diff 改写、Gemini 视频理解、分析历史记录、失败重试、成本记录；三端发起与查看任务。

**验收：** 选择一个视频可直接提交 Gemini（无需本地预先拆字幕），返回并保存可复用分析结果；AI 建议不会覆盖原文；同一分析有合理防重复机制；能查看任务状态与失败原因。

**第二阶段：Browser Agent 辅助发布（M4，暂不施工）**。

预留 `PublicationTask`/`PlatformAdapter` 数据接口。未来由 Mac 本地 Playwright + Stagehand 在允许范围内打开创作页、填写内容、上传文件、生成截图供确认；默认由用户执行最终发布动作。是否允许无人值守必须另行逐平台确认规则，不以“技术可行”替代合规判断。

## 9. 工程结构草案

```text
creator-hub/
  apps/
    mac/                  # Electron + React
    mobile/               # React Native + Expo（iPhone/iPad）
  services/
    mac-server/           # Fastify、SQLite、文件系统、任务、AI
  packages/
    contracts/            # DTO、Zod 校验、OpenAPI 类型
    api-client/           # 统一请求与同步客户端
    domain/               # 作品、素材、版本等领域逻辑
    markdown-editor-web/  # MDXEditor Web 组件与 RN WebView 嵌入页
    platform-preview/     # 平台模拟模板及共享数据模型
    agent-sdk/            # Agent CLI、可选 MCP 适配层
  docs/
    prd.md
    architecture.md
    api-contract.md
    acceptance-tests.md
```

## 10. 质量、安全与发布准备

- **最低安全要求：** 不公开 Mac 服务端口；Tailscale ACL + 应用鉴权；API Key 存 macOS Keychain；外部 Agent 最小权限令牌；上传文件类型/大小校验；下载 URL 反 SSRF；操作与 AI 费用日志。
- **可靠性：** 崩溃恢复、失败重试、断点续传、原子写入、版本回退、SQLite 备份、缓存可重建。
- **隐私：** 默认本地存放；只有用户主动调用云 AI 时发送所需素材。可提供“仅本地模型”选项，但能力取决于已安装模型。
- **测试：** macOS 文件权限、Finder 外部改动、iPhone 远程弱网/断线、iPad 大屏、视频大文件、中文 IME、Markdown 语义保持、版本冲突、服务重启、API 幂等。
- **待确定但不阻塞 M0：** 软件名称和视觉风格、常用素材目录位置、默认本地模型提供者、四个平台模拟 UI 的设计细节。先以可替换配置与默认值实现，不锁死数据架构。

## 11. 给开发 Agent 的执行原则

1. 按 **M0 → M1 → M2 → M3** 顺序交付，不提前进入 M4。
2. 优先复用成熟开源模块；必须记录许可证、依赖版本及替代方案。
3. 每个里程碑交付可启动程序、自动测试、操作说明、截图/录屏和验收记录；未验证项目明确标为 `NOT_VERIFIED`。
4. 严禁 AI 直接覆盖用户 `.md` 原文，必须有版本历史与冲突处理。
5. 保证 Mac 常驻服务与 Electron UI 解耦；不能因关闭窗口导致移动端断开。
6. 第一批先跑通**“外部 Agent API 导入 Markdown → Mac 存为实体文件 → iPhone 编辑 → Mac 更新并保留历史版本”**这一条端到端主链路。

---

**最终技术基线：** Electron + React（Mac）／React Native + Expo（iPhone、iPad）／Fastify + SQLite（Mac 后台）／本地文件目录 + 统一导入 API／Tailscale 远程访问／Gemini 原生视频理解。第一阶段完成内容管理、编辑、预览、AI；Browser Agent 发布明确延后。

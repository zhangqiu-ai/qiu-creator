# 架構說明

本文件描述已實作的架構，隨程式碼更新。產品基線見 [實施方案](AI创作内容工作台_产品与技术实施方案_v1.0.md)，階段調整見 [決策記錄](decisions.md)（第一期只做 Mac）。

## 拓撲

```text
            ┌────────────────────────── Mac ──────────────────────────┐
            │                                                          │
 Electron ──┼─HTTP──┐                                                  │
 (QC-002)   │       ▼                                                  │
 creatorhub ┼─HTTP─► mac-server（Fastify，launchd 常駐，127.0.0.1:7420）│
 CLI／Agent │         │            │                                   │
            │         ▼            ▼                                   │
            │   SQLite（WAL）   ~/CreatorHub/library/…（.md、素材、快照）│
            └──────────────────────────────────────────────────────────┘
 第二期：iPhone／iPad ──Tailscale + 權杖──► 同一個 HTTP API
```

- **Mac 是唯一權威內容源。** 所有用戶端（Electron、CLI、未來的 MCP 與行動端）只透過 HTTP API 讀寫，不直接開資料庫或寫內容檔案。
- **服務與 UI 解耦。** mac-server 是獨立 Node 行程，由 launchd 啟動與重啟（範本在 `deploy/launchd/`）；關掉 Electron 不影響 API。
- **預設只監聽 `127.0.0.1`。** 第二期透過 Tailscale 暴露時才調整 host，不對公網開放。

## 套件

| 路徑 | 內容 | 依賴 |
| --- | --- | --- |
| `packages/contracts` | Zod 4 契約：第三章全部實體（Work、Asset、WorkAsset、PlatformVariant、Revision、ImportJob、AIJob）與第四章 API DTO、統一錯誤格式、平台列舉 | zod |
| `packages/domain` | 純函式：sha256 內容雜湊、revision 衝突判定與 `If-Match` 解析、檔名／路徑安全、HTTP Range 解析 | 無 |
| `packages/api-client` | 型別安全的 fetch 用戶端（base URL + Bearer 權杖），回應以契約驗證；409 時帶出 `currentRevision` | contracts |
| `packages/agent-sdk` | `creatorhub` CLI（`works create`、`works list`），只走 api-client；`mcp/` 預留 | api-client、commander |
| `services/mac-server` | Fastify 服務、SQLite、檔案系統、OpenAPI | contracts、domain |

共用套件不依賴 Electron 或 Node 專屬 UI；`domain` 的路徑工具用到 `node:path`，第二期若要在 React Native 使用需再拆分（目前行動端不使用）。

各套件目前直接匯出 TypeScript 原始碼（`exports` 指向 `src/index.ts`），由 tsx／Vitest 執行；尚無建置產物。

## 資料目錄

```text
$CREATORHUB_HOME（預設 ~/CreatorHub；開發與測試一律用臨時目錄）
  library/works/<work-id>/
    source.md                  # 目前內容，Finder 可直接打開
    revisions/<revision-id>.md # 每個 revision 的不可變快照
    assets/<asset-id>.<ext>    # 托管素材
  cache/                       # 可重建（尚未使用）
  data/
    creatorhub.sqlite          # WAL 模式
    api-token                  # 自動產生的權杖（0600），未設 CREATORHUB_TOKEN 時使用
```

SQLite 只存索引、中繼資料、任務與版本記錄；媒體永遠是磁碟檔案。資料庫裡的路徑都相對於 `CREATORHUB_HOME`。

## SQLite schema

遷移在 `services/mac-server/src/db/migrations.ts`，**只能新增**：執行器記錄每個遷移的 sha256，已套用的遷移內容被改動、或資料庫有本版本不認得的遷移時，服務拒絕啟動。

`0001_initial_schema` 建立：`works`、`revisions`、`assets`、`work_assets`、`platform_variants`（每作品每平台唯一）、`import_jobs`（`idempotency_key` 唯一）、`ai_jobs`（含 `cache_key`），以及 FTS5 虛擬表 `works_fts`（title、tags、body，`trigram` 分詞器）。搜尋 3 字以上走 FTS（支援中文子字串），1–2 字退回 `LIKE`。

`works` 比方案多了 `storage_mode`（managed／external）、`source_path`、`current_revision_id`，以便區分托管與外部掛載並快速核對版本。

## API（M0）

完整定義以 `/docs`（Swagger UI）與 `/docs/json`（OpenAPI 3）為準。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/health` | 不需權杖 |
| POST | `/api/v1/works` | 建立托管作品，回 201 與 `ETag` |
| GET | `/api/v1/works` | 列表；`q`、`type`、`status`、`tag`、`limit`、`offset` |
| GET | `/api/v1/works/:id` | 讀取（含 Markdown），回 `ETag: "<revision>"` |
| PATCH | `/api/v1/works/:id` | 修改；需要 `base_revision` 或 `If-Match` |
| GET | `/api/v1/works/:id/revisions` | 版本歷史 |
| GET | `/api/v1/assets/:id/stream` | 素材串流，支援 Range |

- **鑑權：** `/api/*` 一律要 `Authorization: Bearer <token>`，常數時間比對；失敗回 401。
- **錯誤格式：** `{"error":{"code","message","details?"}}`，`code` 見 contracts 的 `ErrorCodeSchema`。
- **衝突：** `base_revision`／`If-Match` 與目前 revision 不同 → 409，`details.current_revision` 帶目前版本，不寫入任何東西。兩者都沒帶 → 428。`If-Match: *` 不被接受為前置條件。
- **Range：** 單一區段 `bytes=a-b`、`a-`、`-n` 回 206 與 `Content-Range`；超出範圍回 416 與 `Content-Range: bytes */size`；多區段與格式錯誤依 RFC 回整檔 200。

## 寫入資料流（M0 主鏈路）

建立作品：

1. 建 `library/works/<id>/{revisions,assets}`。
2. 寫入快照 `revisions/<rev>.md`（`wx`，不可覆蓋）。
3. 原子寫入 `source.md`。
4. 同一個 SQLite 交易寫 `works`、`revisions`、`works_fts`。任何一步失敗就刪掉整個作品目錄。

修改作品（PATCH）：

1. **外部修改對帳：** 讀 `source.md` 算 sha256，與目前 revision 的 `content_hash` 不同（例如 Finder 或其他編輯器改過），先把磁碟內容記成 `external` revision。拿舊 revision 的用戶端因此得到 409，而不是覆蓋外部修改。
2. 核對 base revision，不符回 409。
3. 寫入新快照。
4. 內容有變時原子寫入 `source.md`。
5. SQLite 交易更新 `works`、新增 `revisions`、更新 FTS。失敗時把 `source.md` 還原並刪掉新快照。

整個流程是同步的（better-sqlite3 + 同步 fs），同一行程內的並發請求無法在「核對」與「寫入」之間交錯。

**原子寫入**（`src/fs/atomic.ts`）：同目錄暫存檔 → 寫入 → `fsync` → `rename` 覆蓋 → 目錄 `fsync`。任一步失敗就刪暫存檔並拋錯，原檔不變（測試以注入失敗的 fs 操作模擬寫一半當機與 rename 前斷電）。

**路徑安全：** 檔名不得含分隔符、控制字元、`..`；相對路徑先做字面檢查，再以 `realpath` 確認沒有經由符號連結逃出 `CREATORHUB_HOME`，否則回 403 `path_rejected`。

## 設定

| 環境變數 | 預設 | 說明 |
| --- | --- | --- |
| `CREATORHUB_HOME` | `~/CreatorHub` | 資料根目錄。`pnpm dev` 沒設定就拒絕啟動 |
| `CREATORHUB_HOST` | `127.0.0.1` | 監聽位址 |
| `CREATORHUB_PORT` | `7420` | 監聽埠；測試用 `0` |
| `CREATORHUB_TOKEN` | （自動產生） | 至少 16 字元；未設定時使用 `data/api-token` |
| `CREATORHUB_LOG_LEVEL` | `info` | Fastify／pino 日誌等級 |

## 尚未實作（依里程碑）

- M1：匯入中心（上傳續傳、URL 匯入與 SSRF 防護、資料夾監控）、外部目錄掛載、冪等鍵、縮圖與 ffprobe、SSE 變更事件、Agent 最小權限權杖。
- M2：平台版本 API、版本恢復、Electron／外部編輯器／Agent 三方衝突的完整驗收。
- M3：AI 任務、Keychain 金鑰、Gemini 視頻理解（測試只用假服務）。
- 生產可用：launchd 實機安裝、崩潰恢復、SQLite 備份與還原（QC-004）。

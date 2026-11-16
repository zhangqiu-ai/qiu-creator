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
| `apps/mac` | Electron Mac App（見下節） | api-client、contracts、design-tokens、markdown-editor-web |
| `packages/markdown-editor-web` | MDXEditor 視覺模式 + `<textarea>` 原始碼模式；可能有損語法偵測與原文保護；不依賴 Electron，第二期可嵌進 WebView | @mdxeditor/editor、mdast 工具 |
| `packages/design-tokens` | DESIGN.md 視覺基線（PT-20261116-001「暖白克制」）的語義 token：淺色／深色色彩、陰影、字型堆疊、字級、間距、圓角、尺寸、斷點、動效；輸出 CSS 變數，第二期 React Native 直接讀值 | 無 |
| `packages/platform-preview` | 四平台預覽的型別與空範本（M2 實作畫面） | contracts |

共用套件不依賴 Electron 或 Node 專屬 UI；`domain` 的路徑工具用到 `node:path`，第二期若要在 React Native 使用需再拆分（目前行動端不使用）。

各套件目前直接匯出 TypeScript 原始碼（`exports` 指向 `src/index.ts`），由 tsx／Vitest 執行；尚無建置產物。

## Mac App（apps/mac）

```text
renderer（React，sandbox，無 Node）
  └─ api-client（fetch 由 bridge 提供）
       └─ window.creatorhub.request ──IPC──► main process
                                              └─ fetch http://127.0.0.1:7420/{health,api/v1/*}
```

- **只走 HTTP API。** App 不開 SQLite、不寫內容檔；所有讀寫都經 api-client 到 mac-server。
- **權杖。** 主程序每次連線時讀 `CREATORHUB_TOKEN` 或 `$CREATORHUB_HOME/data/api-token`，經 preload 的 `contextBridge` 交給 renderer。開發模式沒設 `CREATORHUB_HOME` 就不連線（顯示「未設定 CREATORHUB_HOME」），只有打包後才預設 `~/CreatorHub`。
- **為什麼經主程序轉送請求。** renderer 的來源是 `http://localhost:5180`（開發）或 `file://`（建置），直接 fetch `127.0.0.1:7420` 會被 CORS 擋下，而服務沒有開 CORS。主程序轉送時只允許設定的服務來源、`/health` 與 `/api/v1/*`、固定的方法與標頭、8 MB 以內的內容，不跟隨重新導向，並只接受自家頁面送來的 IPC。
- **視窗安全。** `contextIsolation`、`sandbox` 開啟，`nodeIntegration` 關閉；CSP 在開發模式由回應標頭提供、建置後以 meta 標籤寫入；禁止頁內導航、拒絕所有權限請求、只有 `https:` 連結交給系統瀏覽器開啟。
- **服務沒啟動時。** App 不啟動也不關閉服務（服務由 launchd 管）。連不上就顯示「服務未運行」與重試；關閉視窗或結束 App 不影響服務（`docs/evidence/qc002-close-window.txt`）。
- **儲存。** 每個打開的作品有一個 `WorkSession`：停止輸入 0.8 秒自動儲存，⌘S 立即儲存；輸入法組字期間不儲存也不觸發快捷鍵；PATCH 一律帶 `base_revision`，同時只送一個請求。
- **衝突（409）。** 停止自動儲存，草稿留著，開啟衝突對話框（背景 `inert`）。對話框裡可以：
  - 並排看「你的修改」和伺服器版本，只列出不同的段落（行級 diff 分組成「處」）。
  - 查看差異。
  - 保留雙方：草稿另存成「（我的修改）」新作品，原作品改顯示伺服器版本。
  - 手動合併：逐處選我的或伺服器，也可以直接改結果。合併結果以對話框比對的那個伺服器 revision 為 `base_revision` 寫入；伺服器若又被改過，會再收到 409 並重新載入比對，不會靜默覆蓋。
- **版面。** 照已核准原型 PT-20261116-001：左側導航、作品庫（網格／列表、類型與狀態篩選）、編輯頁（閱讀欄、儲存狀態、`r{n}`、字數、歷史面板）。

## 資料目錄

```text
$CREATORHUB_HOME（預設 ~/CreatorHub；開發與測試一律用臨時目錄）
  library/works/<work-id>/
    source.md                  # 目前內容，Finder 可直接打開
    revisions/<revision-id>.md # 每個 revision 的不可變快照
    assets/<asset-id>.<ext>    # M0 開發腳本登記的素材（register-asset）
  library/assets/<asset-id>/
    <原檔名>.<依內容判定的副檔名>  # 上傳的素材，Finder 可直接打開；以 sha256 去重，多個作品共用
  cache/                       # 可整個刪除，需要時重建
    thumbnails/<asset-id>.webp # 圖片縮圖（最長邊 512px）
  data/
    creatorhub.sqlite          # WAL 模式
    api-token                  # 自動產生的權杖（0600），未設 CREATORHUB_TOKEN 時使用
    uploads/                   # 進行中的 tus 上傳（<id> 與 <id>.json）；不是快取，刪除會失去未完成的上傳
    incoming/                  # 直傳的暫存檔，校驗後移入素材庫或刪除
```

素材獨立於作品存放：同一個檔案可以同時是 A 作品的封面、B 作品的正文圖，關聯記在 `work_assets`。

SQLite 只存索引、中繼資料、任務與版本記錄；媒體永遠是磁碟檔案。資料庫裡的路徑都相對於 `CREATORHUB_HOME`。

## SQLite schema

遷移在 `services/mac-server/src/db/migrations.ts`，**只能新增**：執行器記錄每個遷移的 sha256，已套用的遷移內容被改動、或資料庫有本版本不認得的遷移時，服務拒絕啟動。

`0001_initial_schema` 建立：`works`、`revisions`、`assets`、`work_assets`、`platform_variants`（每作品每平台唯一）、`import_jobs`（`idempotency_key` 唯一）、`ai_jobs`（含 `cache_key`），以及 FTS5 虛擬表 `works_fts`（title、tags、body，`trigram` 分詞器）。搜尋 3 字以上走 FTS（支援中文子字串），1–2 字退回 `LIKE`。

`0002_assets_jobs_change_log`：

- `assets` 增加 `original_name`、`codec`、`metadata_status`（none／pending／ready／unavailable／failed）、`thumbnail_status`（none／pending／ready／failed）、`updated_at`。
- `background_jobs`：縮圖、ffprobe 等背景任務（見下文「背景任務」）。
- `change_log`：只追加的變更記錄，`seq` 自增，作為 SSE 事件 id 與日後增量同步的游標。

`0003_url_imports_tokens_idempotency`：`import_jobs` 增加 `url`、`filename`、`error_code`、`result_asset_id`、`link_work_id`、`link_role`、`created_by`；新增 `api_tokens`（只存雜湊）與 `idempotency_records`。`import_jobs.idempotency_key` 存成 `<權杖 id>:<鍵>`，API 只回傳鍵本身。

`works` 比方案多了 `storage_mode`（managed／external）、`source_path`、`current_revision_id`，以便區分托管與外部掛載並快速核對版本。

## API

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
| POST | `/api/v1/assets/uploads?filename=` | 直傳（`application/octet-stream`，≤ 32 MiB）；新素材 201、重複內容 200 並帶 `deduplicated: true` |
| POST／HEAD／PATCH | `/api/v1/assets/uploads/tus[/:id]` | tus 1.0.0 可續傳上傳；最後一塊 PATCH 回 200 與素材 JSON |
| GET | `/api/v1/assets` | 素材庫列表；`kind`、`q`（原檔名）、`limit`、`offset` |
| GET | `/api/v1/assets/:id` | 素材詳情（含縮圖、元資料狀態） |
| GET | `/api/v1/assets/:id/thumbnail` | WebP 縮圖；`cache/` 被刪時即時重建 |
| GET | `/api/v1/works/:id/assets` | 作品的素材，依用途與順序 |
| POST | `/api/v1/works/:id/assets` | 關聯素材（`cover`／`body`／`video`，可指定位置；重複關聯即移動） |
| DELETE | `/api/v1/works/:id/assets/:assetId?role=` | 移除關聯，順序自動補齊 |
| PUT | `/api/v1/works/:id/assets/order` | 重排某個用途的全部素材 |
| GET | `/api/v1/events` | SSE 變更事件 |
| POST | `/api/v1/imports/urls` | URL 匯入，回 202 與匯入任務；支援 `Idempotency-Key` |
| GET | `/api/v1/jobs` | 匯入任務列表；`status`、`method`、`limit`、`offset` |
| GET | `/api/v1/jobs/:id` | 匯入任務狀態、錯誤碼、結果素材 |
| POST | `/api/v1/jobs/:id/retry` | 重跑失敗的匯入任務（非 failed 回 409） |
| POST／GET | `/api/v1/tokens` | 建立／列出 Agent 權杖（只限主權杖） |
| DELETE | `/api/v1/tokens/:id` | 撤銷 Agent 權杖，立即失效 |

- **鑑權：** `/api/*` 一律要 `Authorization: Bearer <token>`，可以是主權杖（使用者自己、Electron）或 Agent 權杖；無效或已撤銷回 401，權限不足回 403 `forbidden`。詳見下文「Agent 權杖與權限」。
- **錯誤格式：** `{"error":{"code","message","details?"}}`，`code` 見 contracts 的 `ErrorCodeSchema`。
- **衝突：** `base_revision`／`If-Match` 與目前 revision 不同 → 409，`details.current_revision` 帶目前版本，不寫入任何東西。兩者都沒帶 → 428。`If-Match: *` 不被接受為前置條件。
- **Range：** 單一區段 `bytes=a-b`、`a-`、`-n` 回 206 與 `Content-Range`；超出範圍回 416 與 `Content-Range: bytes */size`；多區段與格式錯誤依 RFC 回整檔 200。

## 上傳與素材

1. **接收**：小檔走直傳，邊收邊計數，超過 32 MiB 立即中止並回 413；大檔走 tus，進行中的資料在 `data/uploads/`，斷線後 `HEAD` 取得 offset 從斷點續傳。tus 建立時就拒絕超過所有類型上限的 `Upload-Length`。tus PATCH 連續 60 秒收不到任何位元組（用戶端無聲消失、連線未關）時，伺服器關閉該連線、保存已收資料並釋放該上傳的鎖，用戶端可立即 `HEAD` 後續傳；慢但持續傳送的上傳不受影響（QC-008）。
2. **校驗**（`src/media/detect.ts`）：以 magic bytes 判斷類型並對白名單；副檔名不作數（例如名為 `.mp4` 的 PNG 會被存成 `.png`；改名成 `.jpg` 的 ZIP 回 415）。再依類型檢查大小上限：圖片 50 MiB、音訊 1 GiB、視頻 20 GiB、Markdown 5 MiB。
3. **去重**：算 sha256；已有相同內容就刪掉暫存檔，回原素材與 `deduplicated: true`。
4. **入庫**：暫存檔 `rename` 到 `library/assets/<id>/`，同一個 SQLite 交易寫 `assets`、`change_log`，並為圖片排縮圖任務、為視頻／音訊排 ffprobe 任務。

## Agent 權杖與權限

- **主權杖**（`CREATORHUB_TOKEN` 或 `data/api-token`）擁有全部權限，也是唯一能管理 Agent 權杖的權杖。
- **Agent 權杖**由 `POST /api/v1/tokens` 建立，格式 `chk_<43 字元>`，明文只在建立時回傳一次。資料庫 `api_tokens` 只存 sha256 雜湊與前 12 字元的前綴（列表顯示用）；撤銷後立即回 401。
  - 權杖是 256-bit 隨機值，所以用 sha256 雜湊即可，不需要密碼雜湊演算法。
- **權限範圍**（`src/auth/scopes.ts`，依路由樣式判定）：
  - `read`：所有 GET（作品、素材、任務、SSE 事件）。
  - `import`：建立作品、上傳（直傳與 tus）、URL 匯入、重跑匯入任務，以及查看**自己建立的**匯入任務（`GET /api/v1/jobs/:id`；別人的任務回 404，不洩漏網址）。
  - `write`：修改作品、作品與素材的關聯與排序。
  - 未列出的 `/api` 路由（包括之後新增的）預設只有主權杖能用，不會在無意間開放給 Agent。

## 冪等鍵

`POST /api/v1/works` 與 `POST /api/v1/imports/urls` 接受 `Idempotency-Key` header（8–200 個可見 ASCII 字元）。

- Agent 權杖在這兩個端點**必須**帶冪等鍵，否則回 428；主權杖可省略（Electron 介面由使用者操作）。
- 同一個權杖、同一個端點、同一個鍵：回原本的結果並加上 `Idempotent-Replayed: true`，不會重建作品或重新下載。URL 匯入的重送回的是任務的**目前**狀態。
- 同一個鍵配不同的請求內容（依排序後的 JSON 計算雜湊）回 422 `idempotency_key_reused`，不會悄悄回舊結果。
- 鍵依權杖分開，兩個 Agent 用到同一個字串不會互相干擾。記錄存在 `idempotency_records`；查核、建立、記錄在同一個同步區段內完成，同一行程內不會重複建立。

## URL 匯入與 SSRF 防護

`POST /api/v1/imports/urls` `{url, filename?, work_id?, role?}` 先做便宜的檢查（只限 http／https、不得含帳密、`localhost` 與私網 IP 字面值直接 400 `url_rejected`），然後建立 `import_jobs` 列並交給背景任務佇列（`import.url`）。下載由 `src/net/safe-download.ts` 執行：

1. **每一跳**（含重定向）都重新解析主機名稱。所有解析結果都必須是公網位址，只要有一個落在封鎖範圍就整個拒絕（`blocked_address`）。
2. **釘住 IP**：連線用剛檢查過的位址（自訂 `lookup`），不再讓系統二次解析，DNS 重綁定無法把連線導向內網。TLS 的 SNI 與憑證驗證仍使用原主機名稱。
3. **封鎖範圍**（`src/net/ip-policy.ts`）：回環、0.0.0.0/8、RFC 1918 私網、鏈路本地（含雲端 metadata 169.254.169.254）、CGNAT 100.64/10（含 Tailscale）、多播、文件／測試／保留位址、廣播；IPv6 的回環、ULA、鏈路本地、多播、文件位址，以及會內嵌或轉送到 IPv4 的 NAT64、6to4、Teredo。IPv4 對映的 IPv6（`::ffff:127.0.0.1`、`::ffff:7f00:1`）會先轉回 IPv4 再檢查。
4. **重定向**最多 5 次，每次都回到第 1 步重新檢查；`Location` 指向回環或內網名稱都會被擋。
5. **內容類型白名單**：`image/*`、`video/*`、`audio/*`、`text/markdown`、`text/plain`、`application/octet-stream`（沒有 Content-Type 時放行，交給 magic bytes 判斷）；`text/html`、`application/json` 等直接失敗。
6. **大小**：先看 `Content-Length`，再數實際串流的位元組，超過就中止並刪掉暫存檔。
7. **逾時**：連線 10 秒、無資料 60 秒、整體 30 分鐘。
8. 不送 cookie 或任何憑證，要求 `Accept-Encoding: identity`，讓位元組數就是實際大小。

下載完成後走與上傳相同的 `AssetService.ingest`：magic bytes、各類型大小上限、sha256 去重、縮圖或 ffprobe 任務。指定 `work_id` 時會自動關聯（`role` 預設依類型：視頻為 `video`，其他為 `body`）。

**失敗與重試**：網路錯誤、逾時、5xx、408、429 視為暫時性錯誤，由佇列以指數退避自動重試（共 3 次）；SSRF 封鎖、4xx、類型或大小不符視為永久錯誤，立即標成 `failed`，並記錄 `error_code`（見 contracts 的 `ImportErrorCodeSchema`）。失敗的任務可用 `POST /api/v1/jobs/:id/retry` 手動重跑，`retry_count` 加 1。匯入任務的狀態變化以 `job.*` 事件（`data.type = "import"`）推送到 SSE。

## 背景任務

`src/jobs/job-queue.ts`：任務是 `background_jobs` 的資料列，與觸發它的寫入在同一個交易中入列。

- 單一 worker 依序執行；入列時立即喚醒，閒置時每秒輪詢。
- 服務重啟時，上次留在 `running` 的任務改回 `queued` 續跑，所以當機或關機不會遺失任務。
- 失敗以指數退避重試，最多 3 次，之後標成 `failed` 並寫入 `last_error`；同一素材同類任務未完成時不重複入列。
- `asset.thumbnail`：sharp 產生 WebP 縮圖並記錄寬高。
- `asset.probe`：ffprobe 取時長、寬高、編碼。找不到 ffprobe 時任務照常成功，素材記為 `unavailable`，不報錯。

## 變更事件（SSE）

`GET /api/v1/events` 回 `text/event-stream`：`id` 是 `change_log.seq`，`event` 是動作名，`data` 是 `ChangeEvent` JSON。動作包括 `work.created`、`work.updated`、`work.external_revision`（外部編輯器改了 `source.md`）、`work.assets_changed`、`asset.created`、`asset.updated`、`job.queued`、`job.running`、`job.succeeded`、`job.failed`。

- 和其他 `/api` 路由一樣要 Bearer 權杖。瀏覽器的 `EventSource` 不能帶 header，所以 api-client 用 fetch 讀串流（`client.events.subscribe`）；權杖不接受放在 URL。
- 事件先寫進 `change_log` 再推送：在寫入方的交易提交後才發出，交易回滾的變更不會被推送。
- 斷線重連帶 `Last-Event-ID`（或 `?since=`）即可補發錯過的事件；每 15 秒送 `: ping` 保活。
- 事件只帶提示（例如 `revision_id`、狀態），用戶端收到後再呼叫 API 取完整資料。

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
| `CREATORHUB_FFPROBE` | （自動尋找） | ffprobe 路徑；設為空字串停用。找不到時降級，不報錯 |

## 尚未實作（依里程碑）

- M1 其餘部分：外部目錄掛載與資料夾監控（QC-007）。視頻縮圖（需 ffmpeg）尚未做。
- Mac App（QC-002 之後）：圖片顯示（相對路徑與托管素材要對應到 `/api/v1/assets/:id/stream`）、版本恢復、作品狀態與標籤編輯、訂閱變更事件（主程序訂閱 SSE 再經 IPC 推給 renderer，用於外部修改提示與列表即時刷新）。
- M2：平台版本 API、版本恢復、Electron／外部編輯器／Agent 三方衝突的完整驗收。
- M3：AI 任務、Keychain 金鑰、Gemini 視頻理解（測試只用假服務）。
- 生產可用：launchd 實機安裝、崩潰恢復、SQLite 備份與還原（QC-004）。

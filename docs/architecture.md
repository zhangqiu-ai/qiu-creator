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
| `packages/platform-preview` | 四平台模擬預覽：純 TS 的模板與 view model（主入口），DOM 模板在 `./react`、樣式在 `./style.css` | contracts（react 為 peer） |

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
- **為什麼經主程序轉送請求。** renderer 的來源是 `http://localhost:5180`（開發）或 `qc-app://renderer`（建置，QC-031），直接 fetch `127.0.0.1:7420` 會被 CORS 擋下，而服務沒有開 CORS。主程序轉送時只允許設定的服務來源、`/health` 與 `/api/v1/*`、固定的方法與標頭、8 MB 以內的內容，不跟隨重新導向，並只接受自家頁面送來的 IPC。
- **視窗安全。** `contextIsolation`、`sandbox` 開啟，`nodeIntegration` 關閉；CSP 一律由回應標頭提供，依實際的服務位址（`CREATORHUB_HOST`／`CREATORHUB_PORT`）產生：開發模式由 `onHeadersReceived` 加上，建置後主程序以 `qc-app://renderer/` 提供 `dist/`（只服務 `dist` 內的檔案），每個回應都帶 CSP。建置產物不再寫入 meta 標籤，因為 meta 與標頭兩條政策會同時生效，寫死 `127.0.0.1:7420` 的 meta 會擋掉改埠後的服務圖片（QC-031）；禁止頁內導航、拒絕所有權限請求、只有 `https:` 連結交給系統瀏覽器開啟。
- **服務沒啟動時。** App 不啟動也不關閉服務（服務由 launchd 管）。連不上就顯示「服務未運行」與重試；關閉視窗或結束 App 不影響服務（`docs/evidence/qc002-close-window.txt`）。
- **儲存。** 每個打開的作品有一個 `WorkSession`：停止輸入 0.8 秒自動儲存，⌘S 立即儲存；輸入法組字期間不儲存也不觸發快捷鍵；PATCH 一律帶 `base_revision`，同時只送一個請求。
- **衝突（409）。** 停止自動儲存，草稿留著，開啟衝突對話框（背景 `inert`）。對話框裡可以：
  - 並排看「你的修改」和伺服器版本，只列出不同的段落（行級 diff 分組成「處」）。
  - 查看差異。
  - 保留雙方：草稿另存成「（我的修改）」新作品，原作品改顯示伺服器版本。
  - 手動合併：逐處選我的或伺服器，也可以直接改結果。合併結果以對話框比對的那個伺服器 revision 為 `base_revision` 寫入；伺服器若又被改過，會再收到 409 並重新載入比對，不會靜默覆蓋。
- **版面。** 照已核准原型 PT-20261116-001：左側導航、作品庫（網格／列表、類型與狀態篩選）、編輯頁（閱讀欄、儲存狀態、`r{n}`、字數、歷史面板）。
- **變更事件（共用通道，QC-012）。** 主程序只開一條 SSE（`src/main/sse.ts`、`event-relay.ts`），用服務的 `: connected seq=N` 當起點，斷線後依退避（0.5–30 秒）重連並帶 `Last-Event-ID`，同一個 `seq` 只轉發一次；45 秒收不到任何位元組（服務每 15 秒 ping）就視為斷線，涵蓋睡眠喚醒。事件與連線狀態以 IPC 廣播給所有視窗。renderer 只聽不連：`useChangeEvents`、`useEventStatus`、`useRefreshOn(entities, refresh)`（`src/renderer/events.ts`），後者對指定實體的事件做去抖刷新，並在重連成功時再刷新一次。之後作品列表與外部修改提示（QC-011）沿用同一組 hook。
- **上傳（QC-012）。** 由主程序的 `UploadManager`（`src/main/uploads.ts`）執行，直接從磁碟讀檔，大影片不經 renderer、不整檔進記憶體：32 MB 以內走單次上傳，更大走 tus，每塊 8 MB，用 `fh.read` 依偏移讀取。上傳網址留在記憶體，取消或斷線後「繼續」會先 HEAD 取得已確認的偏移再續傳；服務拒收（類型、大小）就丟掉上傳網址，重試時從頭開始。同時最多 2 個。檔案來源只有兩種：主程序的系統檔案選擇器，或拖放的 `File` 物件（preload 用 `webUtils.getPathForFile` 取路徑），renderer 無法自己指定路徑。上傳清單只存在這次 App 執行期間，與服務端的匯入任務合併顯示在「匯入任務」。
- **縮圖與媒體（QC-012）。** `qc-asset://thumbnail/<id>` 與 `qc-asset://stream/<id>` 由主程序的 protocol handler 帶上權杖向服務取得；串流只轉送單一 `bytes=` Range、不緩衝，影片可以跳轉。只接受 UUID 形式的 id，CSP 的 `img-src` 與 `media-src` 加上 `qc-asset:`。renderer 一律透過 `assetMediaUrl()` 取得媒體 URL，QC-010 改用簽名 URL 時只換這個函式。
- **在 Finder 顯示、資料夾選擇、剪貼簿。** renderer 只傳素材或掛載的 id，主程序向服務查出路徑再顯示（素材路徑必須在 `CREATORHUB_HOME` 內）；掛載資料夾用系統資料夾選擇器；複製雜湊與權杖走主程序的 `clipboard`（renderer 的權限請求一律拒絕）。
- **頁面（QC-012）。** 素材庫（網格、類型篩選、檔名搜尋、檢視器、拖放上傳）、匯入任務（URL 匯入任務加本次上傳，依狀態篩選，在原列重試／取消／繼續，重複內容標「已存在」並可沿用原素材；右欄 Agent 權杖，明文只在建立後顯示一次，撤銷前確認）、設定（服務狀態與即時更新連線、托管目錄、外部掛載的新增、重新掃描、卸載與重新掛載）。設定頁不放服務啟停、備份、AI 金鑰、Tailscale 與裝置配對：前兩者沒有 API，AI 金鑰是 M3，後兩者是第二期。
- **平台預覽（QC-013）。**
  - **套件。** `@qiu-creator/platform-preview` 的主入口沒有 DOM 或 Electron 依賴：`buildPreviewModel()` 依 contracts 的 `PLATFORM_LIMITS` 算出平台會顯示的標題（超限截斷加…）、正文（公眾號為 Markdown 區塊，其他為純文字）、標籤、圖片（超出張數的不顯示）與警告。Mac 用 `./react` 的 `PlatformPreview` 加手機框；第二期移動端可以用同一個 model 畫原生畫面，或在 WebView 用 DOM 模板。畫面固定中性配色、不跟 App 主題，不用平台標誌，平台名稱只用文字，每個畫面都有「模擬」標籤。
  - **頁面。** 從編輯頁「預覽」（⌘P，先存檔）或導航「平台預覽」（開最後編輯的作品，沒有則先選作品）進入。四個分頁各自一個 `VariantSession`，有自己的 revision：自動儲存帶 `base_revision`，組字時不存；封面、圖片順序與標籤立即儲存。409 不覆蓋，草稿留在視窗，使用者選「載入最新版本」或「以我的修改覆蓋」（以最新 revision 為基準明確寫入，若又被改則再 409）。SSE `work.variant_*` 事件：視窗沒有未儲存修改就直接更新，有則轉為同樣的選擇。分頁上以圓點標示超出上限（橘）與衝突（紅）。
  - **超限（PT-20261117-001）。** 輸入時直接呼叫 `checkVariantLimits()`：表單頂部「N 項超出上限・不影響儲存」、計數變警告色、輸入框警告邊框、欄位下方「超出 N 字，預覽已截斷」、圖片「12/9 張」並把多出的縮圖變淡加虛線框。上限是 contracts 的參考值（抖音標題 30、視頻號 16，與原型示意值不同，以 contracts 為準）。
  - **草稿。** 「從原稿建立」「重新從原稿產生」（先確認，成為新 revision，舊版留在歷史）走 QC-009 的固定規則，不用 AI，原稿不變；「複製公眾號版本」先建立再寫入公眾號的欄位。縮圖與預覽圖片走 `qc-asset://thumbnail` 代理。
- **作品管理與編輯（QC-011）。**
  - **即時更新。** 作品庫、素材檢視器的「引用」與編輯頁都用 QC-012 的 SSE hook。編輯頁收到同一作品的 `work.updated`／`work.external_revision` 時交給 `WorkSession.remoteRevision`：沒有未儲存修改就直接載入新版本（編輯器以 `epoch` 重新掛載）；有未儲存修改或正在組字時，顯示「檔案已在外部修改」橫幅並暫停自動儲存，使用者選「比對並合併」（進入衝突對話框）或「捨棄我的修改並重新載入」。自己送出的 revision 會被記住，SSE 回聲（包括請求還在途中就先到的）不會被當成外部修改。重新連線後會再對一次最新 revision 與外部檔案狀態。
  - **狀態與標籤。** 也是草稿的一部分，和內文走同一個儲存佇列（每次 PATCH 都會產生 revision 並帶 `base_revision`），按下就立即儲存；標籤輸入在組字時按 Enter 不會新增。
  - **版本恢復。** 歷史面板可選任一版本，看它與目前版本的差異（刪除線／底線），「恢復此版本」後再確認一次「恢復 rN 為新版本 rM，歷史版本全部保留」。恢復前先存掉未儲存的修改；`base_revision` 過期時回 409，不覆蓋，改顯示外部修改提示。
  - **外部檔案遺失。** `external_state` 是 `missing` 或 `unmounted` 時作品唯讀：標題、內文、狀態、標籤、恢復都停用，橫幅顯示原檔路徑與「放回原處後自動恢復」，並可在 Finder 顯示資料夾。PATCH 回 409 `source_missing` 時同樣轉為唯讀，這個視窗的修改保留，檔案回來（`work.source_restored`）後恢復編輯並繼續儲存。作品庫以「檔案遺失」標籤與灰色封面標示。
  - **外部來源標示。** 作品庫網格與列表的來源欄寫「外部掛載 · 名稱」，列表標題旁有「外部」標籤（hover 顯示資料夾）；編輯頁標頭顯示「外部掛載 · ~/…」（hover 顯示完整檔案路徑）。路徑由主程序提供的 `userHome` 縮寫成 `~`。
  - **Markdown 圖片。** 用 QC-010 的簽名網址，不走 `qc-asset://` 代理：只有 `GET /works/:id/media` 知道相對路徑對應哪個檔案（托管的 `assets/…` 或掛載資料夾內），而且有些檔案沒有素材 id 可給代理使用。簽名網址短效、只對單一檔案有效，權杖仍不進 renderer，第二期 WebView 也能共用。MDXEditor 透過 `imagePreviewHandler` 只換顯示用的 `src`，Markdown 原文不變；網址在到期前 30 秒重新取得；新貼上的圖片會先儲存再解析。找不到、路徑不允許或格式不支援的圖片顯示中性佔位圖；`http(s)` 外部圖片不載入（不向第三方發請求），CSP 的 `img-src` 因此拿掉 `https:`，改為加上服務來源。素材庫檢視器仍用 `qc-asset://` 代理。
  - **素材檢視器的「引用」**（`GET /assets/:id/works`）列出作品與角色（封面／正文／影片），點擊開啟作品。掛載資料夾裡被引用的素材依掛載分組顯示，「在 Finder 顯示」會以掛載根目錄解析路徑。

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
    media-signing.key          # 簽名媒體網址的 HMAC 金鑰（0600，自動產生）；刪除後重啟即作廢所有已發出的網址
    uploads/                   # 進行中的 tus 上傳（<id> 與 <id>.json）；不是快取，刪除會失去未完成的上傳
    incoming/                  # 直傳的暫存檔，校驗後移入素材庫或刪除
    restore-pending.json       # 還原已接受、等服務重新開啟資料庫時才有（QC-030）
  backups/                     # SQLite 備份（QC-030）：<id>.sqlite 與 <id>.json（類型、時間、大小、完整性、schema 版本）
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

`0004_external_mounts`：新增 `mounts`（`root_path` 唯一、`status` 為 active／unavailable／removed）；`works` 增加 `mount_id`、`external_state`，並以 `(mount_id, source_path)` 建唯一索引。

`0005_external_assets`：`assets` 增加 `mount_id`、`file_mtime_ms`，並以 `(mount_id, path)` 建唯一索引。外部素材的 `path` 相對於掛載根目錄，檔案留在原地。

`0006_platform_variant_revisions`：`platform_variants` 增加 `image_asset_ids`（JSON 陣列，圖片順序）與 `source_work_revision_id`；新增只追加的 `platform_variant_revisions`，主鍵 `(variant_id, revision)`，每個版本存一份完整內容。

`0007_platform_variant_tombstones`：`platform_variants` 增加 `deleted_at`。刪除平台版本時留下墓碑列，不刪除資料列（QC-019）。

`0008_ai_foundation`：`ai_jobs` 增加 `provider`、`input`（重試時重送的請求）、`error_code`、`attempts`／`max_attempts`／`run_after`（退避重試）、`started_at`／`finished_at`、`usage_month`（用量算在哪個本地月份）、`estimate`（送出前估算）；新增 `ai_providers`（模型設定、首次使用告知確認、金鑰「是否已存」的時間——金鑰本身不在資料庫）與 `app_settings`（AI 月度提醒金額、價格覆寫）。

`0009_text_ai_tasks`：`ai_jobs` 增加 `task`（文字 AI 任務的種類與參數，JSON）、`accepted_revision_id`、`accepted_at`；`revisions` 增加 `ai_job_id`（`ai_accepted` 版本對應的 AI 任務）。

`0011_change_log_system_entity`：`change_log.entity` 允許 `system`（備份事件，QC-030）。SQLite 無法修改 CHECK，所以重建資料表，保留 `seq` 與 AUTOINCREMENT 的最高值，SSE 的 id 不會倒退。

`0010_ai_video_jobs`：`ai_jobs` 增加 `progress`（多步驟任務的公開進度）與 `remote_state`（可續傳上傳網址、遠端檔名，供重試續傳；不公開）。視頻分析的快取鍵存在 0001 就有的 `ai_jobs.cache_key`。

`works` 比方案多了 `storage_mode`（managed／external）、`source_path`、`current_revision_id`，以便區分托管與外部掛載並快速核對版本。

## API

完整定義以 `/docs`（Swagger UI）與 `/docs/json`（OpenAPI 3）為準。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/health` | 不需權杖；回 `version`、`commit`、`built_at`（從原始碼執行時後兩者為 null，QC-030） |
| POST | `/api/v1/works` | 建立托管作品，回 201 與 `ETag` |
| GET | `/api/v1/works` | 列表；`q`、`type`、`status`、`tag`、`limit`、`offset` |
| GET | `/api/v1/works/:id` | 讀取（含 Markdown），回 `ETag: "<revision>"` |
| PATCH | `/api/v1/works/:id` | 修改；需要 `base_revision` 或 `If-Match` |
| GET | `/api/v1/works/:id/revisions` | 版本歷史 |
| GET | `/api/v1/works/:id/revisions/:rid` | 單一歷史版本：標題與完整 Markdown 快照 |
| POST | `/api/v1/works/:id/revisions/:rid/restore` | 恢復某版本：追加一個 `restore` revision；需要 `base_revision` 或 `If-Match` |
| GET | `/api/v1/works/:id/media` | 解析 Markdown 引用的圖片／影音，回每項狀態與簽名網址；外部作品的引用登記成素材 |
| GET | `/api/v1/works/:id/files/*` | 以 Bearer 讀作品內的媒體檔，支援 Range（規則同簽名路由） |
| POST | `/api/v1/media/signed-urls` | 為素材（`stream`／`thumbnail`）簽發短期網址 |
| GET | `/media/v1/works/:id/files/*?exp&p&sig` | 簽名媒體檔，不需 Authorization，支援 Range |
| GET | `/media/v1/assets/:id/{stream,thumbnail}?exp&p&sig` | 簽名素材串流與縮圖 |
| GET | `/api/v1/assets/:id/stream` | 素材串流，支援 Range |
| POST | `/api/v1/assets/uploads?filename=` | 直傳（`application/octet-stream`，≤ 32 MiB）；新素材 201、重複內容 200 並帶 `deduplicated: true` |
| POST／HEAD／PATCH | `/api/v1/assets/uploads/tus[/:id]` | tus 1.0.0 可續傳上傳；最後一塊 PATCH 回 200 與素材 JSON |
| GET | `/api/v1/assets` | 素材庫列表；`kind`、`q`（原檔名）、`limit`、`offset` |
| GET | `/api/v1/assets/:id` | 素材詳情（含縮圖、元資料狀態） |
| GET | `/api/v1/assets/:id/thumbnail` | WebP 縮圖；`cache/` 被刪時即時重建 |
| GET | `/api/v1/assets/:id/works` | 反查使用此素材的作品：作品 id、標題、用途、位置，依作品更新時間新到舊 |
| GET | `/api/v1/works/:id/assets` | 作品的素材，依用途與順序 |
| POST | `/api/v1/works/:id/assets` | 關聯素材（`cover`／`body`／`video`，可指定位置；重複關聯即移動） |
| DELETE | `/api/v1/works/:id/assets/:assetId?role=` | 移除關聯，順序自動補齊 |
| PUT | `/api/v1/works/:id/assets/order` | 重排某個用途的全部素材 |
| GET | `/api/v1/works/:id/variants` | 作品的平台版本（依小紅書、公眾號、抖音、視頻號排序），每份帶 `warnings` |
| POST | `/api/v1/works/:id/variants` | 從原文以規則產生草稿（不呼叫 AI）；已有版本的平台略過並列在 `skipped` |
| GET | `/api/v1/works/:id/variants/:platform` | 單一平台版本，回 `ETag: "<revision>"` |
| PATCH | `/api/v1/works/:id/variants/:platform` | 修改標題、正文、封面、圖片順序、標籤；需要 `base_revision` 或 `If-Match` |
| POST | `/api/v1/works/:id/variants/:platform/draft` | 從目前原文重新產生草稿；不存在時建立（201），存在時需要 base，追加 `draft` 版本 |
| DELETE | `/api/v1/works/:id/variants/:platform` | 刪除該平台版本（留墓碑、保留歷史，版本號不回頭）；需要 `If-Match` |
| GET | `/api/v1/works/:id/variants/:platform/revisions[/:revision]` | 平台版本歷史（含完整內容） |
| GET | `/api/v1/events` | SSE 變更事件 |
| GET | `/api/v1/backups` | 備份列表（新的在前）、保留份數、資料夾、每日排程；只限主權杖 |
| POST | `/api/v1/backups` | 立即手動備份（201），含完整性檢查結果；只限主權杖 |
| POST | `/api/v1/backups/:id/restore` | 從備份還原（`confirm: true`，202）；先自動備份當前狀態，接著服務在行程內重新開啟；只限主權杖 |
| POST | `/api/v1/imports/urls` | URL 匯入，回 202 與匯入任務；支援 `Idempotency-Key` |
| GET | `/api/v1/jobs` | 匯入任務列表；`status`、`method`、`limit`、`offset` |
| GET | `/api/v1/jobs/:id` | 匯入任務狀態、錯誤碼、結果素材 |
| POST | `/api/v1/jobs/:id/retry` | 重跑失敗的匯入任務（非 failed 回 409） |
| POST | `/api/v1/mounts` | 掛載外部資料夾（只限主權杖）；索引在背景任務中進行 |
| GET | `/api/v1/mounts`、`/api/v1/mounts/:id` | 掛載列表與狀態、作品數 |
| POST | `/api/v1/mounts/:id/rescan` | 重新掃描（新增、變更、遺失） |
| DELETE | `/api/v1/mounts/:id` | 卸載；檔案不動，作品與歷史保留並標成 `unmounted` |
| GET | `/api/v1/ai/providers` | 供應商的金鑰狀態、模型、首次使用告知、確認狀態與 `ready` |
| PATCH | `/api/v1/ai/providers/:provider` | 設定文字模型（Gemini 另可設視頻模型） |
| PUT／DELETE | `/api/v1/ai/providers/:provider/key` | 存入／刪除 Keychain 憑證；New API 的 PUT 同時接收 `base_url` 與 `api_key`，兩欄都是唯寫 |
| POST／DELETE | `/api/v1/ai/providers/:provider/consent` | 確認／撤回使用告知；POST 須傳目前的 `notice_version`，New API 另須傳 `notice.credential_id` |
| GET／PATCH | `/api/v1/ai/settings` | 月度提醒金額、價格覆寫 |
| POST | `/api/v1/ai/estimate` | 送出前的費用估算與本月累計，不送出任何內容 |
| POST | `/api/v1/ai/jobs` | 建立 AI 任務（202），回估算與預算提醒；缺金鑰或未確認告知回 409；支援 `Idempotency-Key` |
| GET | `/api/v1/ai/jobs`、`/api/v1/ai/jobs/:id` | AI 任務列表與詳情（結果、用量、估算成本、失敗原因） |
| POST | `/api/v1/ai/jobs/:id/cancel`、`/retry` | 取消排隊或進行中的任務（中止供應商請求）；重跑失敗或已取消的任務 |
| GET | `/api/v1/ai/usage?month=YYYY-MM` | 各供應商的 token 與估算費用、本月提醒狀態 |
| POST | `/api/v1/works/:id/ai/suggestions` | 四平台標題／簡介／標籤候選（202，AI 任務）；不寫入任何東西；相同請求進行中回原任務（`in_progress: true`），支援 `Idempotency-Key` |
| POST | `/api/v1/works/:id/ai/rewrite` | 改寫候選：潤色、縮寫、擴寫、語氣、自訂指令；全文或選取範圍（202，AI 任務）；相同請求進行中回原任務（`in_progress: true`），支援 `Idempotency-Key` |
| POST | `/api/v1/assets/:id/ai/video-understanding/estimate` | 視頻送出前的上限檢查與費用估算，並告知有無可沿用的舊結果；不送出 |
| POST | `/api/v1/assets/:id/ai/video-understanding` | Gemini 視頻理解；命中快取回 200 `cached: true`（不送出、不計費），同樣分析進行中回 `in_progress: true`，否則 202 |
| POST | `/api/v1/works/:id/ai/jobs/:jobId/accept` | 採用改寫：送出前端組好的全文，以 `base_revision = source_revision` 寫成 `ai_accepted` 版本；原稿已變回 409 |
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

## 版本恢復（QC-010）

- `GET /works/:id/revisions/:rid` 讀快照檔，回該版本的標題與 Markdown。
- `POST …/restore` 走與 PATCH 相同的寫入流程：先對帳外部修改、核對 base（沒帶回 428，過期回 409 並帶 `current_revision`）、寫新快照、內容有變才原子寫入原稿、同一交易更新資料庫。新版本 `source: "restore"`，`parent_revision_id` 是恢復前的目前版本，Markdown 與標題複製自被恢復的版本；舊版本與快照完全不動，恢復本身也能再被恢復。
- 狀態、類型、標籤不屬於版本內容，恢復時保持現值。
- 外部作品恢復時寫回掛載資料夾的原檔；檔案遺失或未掛載回 409 `source_missing`，不重建檔案。
- 事件：`work.updated`，`data` 帶 `revision_id`、`source`（`edit`／`restore`）、`fields`，恢復時另帶 `restored_from`。

**PATCH 狀態與標籤：** `status` 只接受四種狀態；標籤會去掉首尾空白、去除重複（保留順序），每個 1–64 字、最多 64 個，格式不符回 400 且不寫入。只改中繼資料也會產生新 revision（標題記在 revision 上），同樣受 409 保護。

## Markdown 媒體解析與簽名網址（QC-010）

`GET /works/:id/media` 用與編輯器相同的 mdast + GFM + front matter 解析器，找出 `![](…)`、參照式圖片、HTML 中 `<img>`／`<video>`／`<audio>`／`<source>` 的 `src`（程式碼區塊與 front matter 不算），逐一分類：

| 狀態 | 意思 |
| --- | --- |
| `resolved` | 允許範圍內的圖片／影音檔，帶 `url`（簽名）、`kind`、`mime_type`、`bytes`、`asset_id` |
| `missing` | 路徑允許但檔案不存在，或外部作品的掛載不在 |
| `rejected` | 跳出根目錄、經過符號連結、絕對路徑、`file:` 等其他 scheme、無法解碼的 `%` 序列，或托管作品的 `assets/` 以外 |
| `unsupported` | 檔案存在但不是白名單內的圖片／影音（例如 SVG、HTML），或超過該類型大小上限 |
| `remote` | `http(s)://` 或 `//`；不下載，需要時走 URL 匯入 |
| `inline` | `data:` URI |

- **根目錄：** 托管作品以作品資料夾為根，只能讀 `assets/…`，`source.md`、`revisions/` 都讀不到。外部作品以掛載根目錄為根，引用相對於筆記所在資料夾解析，可以用 `../` 指到同一掛載的其他資料夾，但不能超出掛載根目錄。
- **路徑處理：** 去掉 `?query` 與 `#fragment`、做 `%` 解碼，再以 POSIX 規則正規化；含反斜線、NUL、絕對路徑一律拒絕。
- **不跟隨符號連結：** 根目錄以下逐段 `lstat`，任何一段是符號連結就拒絕；最後以 `O_NOFOLLOW` 開檔並比對 inode，防止檢查與開檔之間被換成連結。串流使用同一個檔案描述符。
- **類型：** 以 magic bytes 判斷，只服務上傳白名單內的圖片／影音／音訊。SVG 可能夾帶腳本，因此不服務。
- **外部圖片登記：** 外部作品引用到的檔案以 `origin: folder`、`mount_id`、`path`（相對掛載根）登記成素材，**不搬移、不複製**，並以 `body`（視頻為 `video`）關聯到作品；已經關聯過就不再動。大小或修改時間變了才重新算 sha256。縮圖與 ffprobe 直接讀原地檔案。上傳去重只比對托管素材，不會把上傳指到可能消失的外部檔案。
- **托管素材：** `assets/…` 若對應已登記的素材，回傳其 `asset_id`。

**素材檢視器（`<img>`／`<video>` 播放原檔）：** `POST /api/v1/media/signed-urls` 一次為多個素材簽發 `stream` 或 `thumbnail` 網址，得到 `/media/v1/assets/<id>/stream?exp&p&sig`。這是 `GET /api/v1/assets/:id/stream` 的簽名版，Range 行為相同：`bytes=0-`、`a-b`、`-n` 回 206，超出範圍回 416。Bearer 路由本身維持只認 header，不接受網址上的簽名，兩種憑證不混用。

**為什麼用簽名網址：** Electron renderer 的 `<img>`／`<video>` 不能帶 `Authorization` header。評估過三種做法：

1. **短期簽名網址（採用）。** 伺服器以 HMAC-SHA256 簽 `(principal, 到期時間, 正規化路徑)`，網址形如 `/media/v1/works/<id>/files/assets/a.png?exp=…&p=owner&sig=…`。
   - 一個網址只能開一個檔案；改路徑、延長到期、換 principal 都會 403。
   - 預設 1 小時到期（看長視頻與拖動進度夠用），過期重新呼叫 `/media` 即可。
   - 每次請求都重新確認簽發者仍有效：Agent 權杖撤銷或失去 `read` 後，它拿到的網址立刻失效。
   - 權杖本身不會出現在網址裡。日誌記錄網址時把 `sig` 遮掉。
   - 回應帶 `Cache-Control: private, max-age≤300`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: default-src 'none'; sandbox`。
   - 第二期的 iPhone／iPad WebView 可以直接沿用。
2. **主程序代理（自訂 protocol 轉發並加 header）。** 權杖也不進 renderer，但 Range、串流背壓、錯誤碼都要在主程序重做一次，而且只在 Electron 有效。
3. **Cookie 或網址帶長期權杖。** 前者要處理 CSRF 與跨來源，後者讓權杖進入歷史、日誌與 Referer。不採用。

**取捨：** 簽名網址在到期前等同對單一檔案的讀取憑證，複製出去的網址在到期前（且簽發者未撤銷時）都能讀到該檔。服務只聽本機或 Tailscale，風險可接受。要立即作廢全部網址，可刪除 `data/media-signing.key` 後重啟。

## 平台版本（QC-009）

每個作品在小紅書、公眾號、抖音、視頻號各最多一份平台版本（`UNIQUE (work_id, platform)`），欄位為標題、正文、封面素材、圖片順序、標籤。實作在 `src/variants/`，上限設定在 contracts 的 `PLATFORM_LIMITS`。

**存放方式：SQLite，加只追加的歷史表。** 不存成檔案，理由：

- 平台版本是從原文衍生的結構化資料（素材 id、圖片順序、標籤），不是使用者會在 Finder 打開的原稿。`source.md` 仍是唯一原稿；「媒體與 Markdown 原稿放磁碟」的原則針對原稿與媒體，不針對衍生版本。
- 一次修改同時動到正文、封面、圖片順序、標籤。放在同一個 SQLite 交易裡，一定全部成功或全部不變，不需要額外處理「檔案寫了、資料庫沒寫」的半途狀態。
- 版本號是整數，`UPDATE … WHERE revision = <base>` 一行就保證同一個 base 只會有一個寫入成功。
- 歷史快照存在 `platform_variant_revisions`，每版一份完整內容，量小（純文字加 id），比照原稿的不可變快照。之後要做「恢復某一版」可以直接讀它。

**版本與衝突：** 版本號從 1 起、每次修改加 1，也是 ETag（`"3"`）。PATCH、重新產生、刪除都要帶 `base_revision`（整數）或 `If-Match`：沒帶回 428，過期回 409 並在 `details.current_revision` 給目前版本號（整數；api-client 用 `ApiError.currentVariantRevision` 讀）。body 與 header 不一致視為衝突。每個平台各自計數，改一個平台不影響其他平台或原文。

**刪除與重建（QC-019）：** 同一作品同一平台的版本號只增不減，刪除後也不會回頭。

- 刪除把該列變成墓碑：內容清空、記下 `deleted_at`，並佔用下一個版本號（例如 r1 刪除後墓碑是 r2）。歷史表保留。
- 墓碑對讀取、列表、修改、歷史都回 404；產生草稿或單一平台重新產生時，把墓碑復活成新草稿，版本號從墓碑 +1 起算（上例為 r3），歷史接在原本的後面。
- 這樣，持有刪除前版本號的用戶端在重建後寫入一定回 409，不會靜默覆蓋新草稿。修正前重建會從 r1 重算，舊的 r1 寫入會成功。
- 墓碑本身不寫進歷史表（歷史的 `source` 仍只有 `draft`／`edit`，API 形狀不變），所以重建後的歷史會在墓碑處少一個號碼。

**規則草稿（不呼叫 AI）：**

- 標題、標籤：照抄作品。
- 正文：小紅書、抖音、視頻號不渲染 Markdown，轉成純文字——段落與標題各成一段，清單變成 `•`／`1.` 開頭的行，連結只留文字，圖片、HTML、front matter 去掉。公眾號保留 Markdown，只去掉 front matter。開頭若是與標題相同的 `# 標題` 會去掉，因為標題是獨立欄位。
- 圖片：Markdown 中已登記成素材的圖片（依文中順序，經 `/works/:id/media` 解析，外部作品的圖片會順便原地登記），再接上作品其他 `body` 用途的圖片素材。
- 封面：作品的第一個 `cover` 圖片，沒有就用第一張圖。
- 超出上限不截斷，只產生警告。

**上限與警告：** `PLATFORM_LIMITS` 標明「參考值、可調」，不爬平台網站。字數以 Unicode code point 計（中文字、英文字母、emoji 都算 1）。`checkVariantLimits()` 是純函式，伺服器在每次回應附上 `warnings`，前端也可以在輸入時即時呼叫同一個函式。超限一律照存。

| 平台 | 標題 | 正文 | 圖片 | 標籤 | 正文格式 |
| --- | --- | --- | --- | --- | --- |
| 小紅書 | 20 | 1000 | 18 | 10 | 純文字 |
| 微信公眾號 | 64 | 20000 | — | — | Markdown |
| 抖音 | 30 | 1000 | 35 | 5 | 純文字 |
| 微信視頻號 | 16 | 1000 | 9 | — | 純文字 |

**驗證：** 封面與圖片必須是存在的圖片素材，否則回 400 並列出 `invalid_asset_ids`；圖片不可重複；標籤去空白、去重。

**事件：** `work.variant_created`（含墓碑復活）、`work.variant_updated`、`work.variant_deleted`，`entity_id` 是作品 id，`data` 帶 `platform`、`revision`、`source`（`draft`／`edit`）；刪除事件的 `revision` 是墓碑的版本號。

## AI 基礎（QC-021）

使用者決策（2026-11-17）：文字 AI 接 Gemini、Claude、GPT 三家可切換，視頻用 Gemini；本地模型延後。實作在 `src/ai/`，契約在 contracts 的 `ai.ts`。這張只做基礎，具體 AI 動作在 QC-022（文字候選與改寫）、QC-023（Gemini 視頻理解）。

**供應商介面：** `AIProvider` 有 `generateText`（純文字或依 JSON Schema 的結構化輸出）與選用的 `uploadFile`（給 QC-023 的 Gemini 視頻）。各 adapter 都用官方 SDK，所有對外 HTTP 只在 adapter 內；base URL 可注入。本地模型日後只要實作同一個介面。

| 供應商 | SDK | 端點 | 結構化輸出 | 拒答／攔截 |
| --- | --- | --- | --- | --- |
| Claude | `@anthropic-ai/sdk` | `POST /v1/messages` | `output_config.format`（`json_schema`） | `stop_reason: "refusal"` |
| GPT | `openai` | `POST /v1/responses`（`store: false`） | `text.format`（`json_schema`, `strict`） | 內容項 `refusal`、`incomplete_details.reason: content_filter` |
| New API | `openai` | `POST /v1/chat/completions` | `response_format`（`json_schema`, `strict`） | `message.refusal`、`finish_reason: content_filter` |
| Gemini | `@google/genai` | `POST /v1/models/<m>:generateContent` | `responseMimeType` + `responseJsonSchema` | `promptFeedback.blockReason`、`finishReason` 為 SAFETY 等 |

- Claude 在支援的模型（Opus 5.5 等）啟用伺服器端拒答備援（`fallbacks: "default"`，beta `server-side-fallback-2026-07-01`）：被拒時由 API 在同一次呼叫改用備援模型，費用以回應中實際服務的模型計價。不要時可在 adapter 移除。
- Gemini 的思考 token 計入輸出用量。

**金鑰：** 存在 macOS Keychain（`@napi-rs/keyring`，服務名 `com.qiu-creator.creatorhub.ai`，帳號為供應商 id），不經過命令列參數。API 只能寫入與刪除，任何回應都不含金鑰；資料庫只記錄「何時存過」。金鑰只在任務執行前一刻讀取，傳給 adapter 後不保留。錯誤訊息會去掉看起來像金鑰或 Bearer 的字串，並把該次使用的金鑰全文替換成 `[REDACTED]`，長度上限 200 字。測試一律用記憶體實作，`KeychainSecretStore` 在測試執行器下會拒絕建立。

**首次使用告知：** 每個供應商有一段告知文字（內容會送到哪家公司、費用由誰付），帶版本號。使用者以目前版本確認後才能建立任務；沒存金鑰回 409 `ai_key_missing`，沒確認回 409 `ai_consent_required`。告知改版（版本號提高）時要重新確認。撤回確認或刪除金鑰後，已排隊的任務在送出前會再檢查一次，直接失敗（`consent_required`／`missing_key`），不會送出。

**權限：** `/api/v1/ai/*` 全部只限主權杖，連讀取也是；Agent 權杖不能管理金鑰，也不能花錢呼叫 AI。

**任務佇列：** AI 任務存在 `ai_jobs`，由獨立的執行器處理（預設同時 2 個），不佔用縮圖等背景任務的單一工作者。

- 狀態：`queued` → `running` → `succeeded`／`failed`／`cancelled`。服務重啟時，`running` 的任務回到 `queued`。
- 失敗原因（`error_code`）與處理：

| 代碼 | 來源 | 自動重試 |
| --- | --- | --- |
| `rate_limited` | 429 | 是 |
| `timeout` | 逾時（預設 120 秒） | 是 |
| `provider_unavailable` | 5xx、529 overloaded、連線失敗 | 是 |
| `invalid_key` | 401、403；Gemini 的 `API_KEY_INVALID` | 否 |
| `content_blocked` | 拒答或安全攔截 | 否 |
| `bad_request` | 400、404、422（模型名稱或參數錯） | 否 |
| `invalid_output` | 結構化輸出無法解析成 JSON | 否 |
| `missing_key`、`consent_required` | 排隊後金鑰被刪或告知被撤回 | 否 |

- 自動重試最多 3 次，間隔 5 秒起指數退避。SDK 自帶的重試全部關閉，避免重複計費與重試次數失控。
- 取消：排隊中直接取消；執行中會中止送往供應商的請求。重跑：失敗或已取消的任務重新排隊並重置次數。
- `Idempotency-Key`：同一個鍵重送，回傳原本的任務而不重複建立。
- 事件：`ai_job.queued`／`running`／`succeeded`／`failed`／`cancelled`，`entity` 是 `job`，`data` 只有 `status` 與 `provider`，不含內容。

**費用：**

- 價格表 `AI_PRICE_TABLE` 標明「參考價格、可調」，取自各家官方價格頁（2026-11-17），單位為每百萬 token 美元；可在設定中逐模型覆寫。Google 已公告 Gemini 價格在 2026-12-01 與 2027-01-01 調整，屆時要更新或覆寫。
- 送出前（`/ai/estimate`，以及建立任務的回應）：輸入 token 以字數粗估（中日韓字約 1 字 1 token，其他約 4 字 1 token），加上輸出上限，得出「最多」花費。
- 完成後：依供應商回報的 token 用量與價格表計算，記在 `cost_usd`，一律標為估算。結構化輸出解析失敗時，已花的 token 仍計入。
- 月度提醒：設定 `monthly_budget_usd` 後，本地月份的累計（含這次任務的最多估算）超過時，回應的 `budget.over_budget` 為 true，並帶中文提醒；任務照常送出。
- 沒有價格的模型照常執行，估算與成本為 `null`。

**預設模型**（可在設定中改）：Gemini `gemini-3.8-flash`（文字與視頻）、Claude `claude-opus-5-5`、GPT `gpt-5.5`、New API `gpt-4o-mini`。

### New API 中轉站

New API 是可選的文字供應商。mac-server 使用 [New API 的 Chat Completions 端點](https://github.com/QuantumNous/new-api-docs-v1/blob/main/content/docs/en/guide/feature-guide/user/api.mdx)，要求目前選定的上游模型支援嚴格結構化輸出。向使用者設定的 HTTPS Base URL（結尾為 `/v1`）送出請求，禁止重新導向。送出前可在 App 選擇供應商與模型。

Base URL 與金鑰一起存入 Keychain 的 `new-api` 項目。遷移 `0012_new_api_provider` 保留現有供應商設定，並讓 SQLite 記錄當前憑證與任務的識別碼。更換憑證須重新確認使用告知，仍在排隊的舊任務需要主動重試才能送往新設定。用量採中轉站回報的 token，只有該模型已設定價格覆寫時才顯示估算。

## 文字 AI：平台候選與改寫（QC-022）

建在 QC-021 的任務執行器上（`src/ai/text-tasks.ts`），兩種都是 AI 任務：建立後立即回 202，前端輪詢 `GET /api/v1/ai/jobs/:id` 或聽 `ai_job.*` 事件。金鑰、告知確認、費用估算與月度提醒、只限主權杖，全部沿用 QC-021。

**給前端（QC-024）的操作對應：**

| 操作 | API |
| --- | --- |
| 停止生成 | `POST /api/v1/ai/jobs/:id/cancel`（api-client 另有 `ai.stop`）：中止送往供應商的請求 |
| 重試 | `POST /api/v1/ai/jobs/:id/retry`：重送同一份提示詞，所以仍以原本的 `source_revision` 為準 |
| 重新產生（以目前原稿） | 再呼叫一次 `suggestions` 或 `rewrite`，得到新任務（前一個相同任務還在跑時，回的是那個任務，`in_progress: true`） |
| 這篇作品的 AI 紀錄 | `GET /api/v1/ai/jobs?work_id=` |
| 讀結果 | `job.result.json`；api-client 的 `suggestionsOf(job)`、`rewriteOf(job)` 直接回型別化結果 |

**平台候選：** 一次任務、一次供應商呼叫，涵蓋選定的平台與欄位（預設四平台 × 標題、簡介、標籤 × 3 個候選）。

- 提示詞依 `PLATFORM_LIMITS` 寫明各平台的字數與數量上限，並附平台風格提示（編輯建議，不是平台規則）；用各家原生的結構化輸出，Schema 只包含要求的平台與欄位。
- 結果整理：去頭尾空白、去重、裁到要求的數量；標籤去掉 `#`、去重、丟掉空的。每個候選附上 `PLATFORM_LIMITS` 的超限警告（簡介以平台正文上限檢查）。形狀不對時任務記 `invalid_output`。
- `task.variant_revisions` 記下產生當時各平台版本的版本號（沒有版本為 null），方便前端判斷候選是否根據較舊的狀態。
- 採用：前端把選中的候選用 `PATCH /api/v1/works/:id/variants/:platform` 寫入，帶該平台目前的 `base_revision`；服務端不會自動寫平台版本。

**改寫：** 模式為潤色、縮寫、擴寫、語氣調整（須給 `tone`）、自訂（須給 `instruction`）；其他模式也可加補充指令。

- 建立時以作品目前版本為 `source_revision`，提示詞與結果都根據這個版本。可只改寫選取範圍（UTF-16 位移）；空白範圍或超出全文回 400。
- 結果（`RewriteResult`）：改寫後的文字、取代的範圍、拼回去的全文 `full_markdown`。若供應商把輸出包在程式碼圍欄裡會去掉；選取範圍原本的前後空白會保留，拼接時不會黏行。
- 採用：前端送出最終全文（全部採用就送 `full_markdown`，部分採用或手動修改由前端組好），可同時改標題。服務端不合併，以 `base_revision = source_revision` 寫入；作品在這之後被改過就回 409 `revision_conflict`，什麼都不寫。成功時新版本 `source` 為 `ai_accepted`、`ai_job_id` 指向該任務，任務記下 `accepted_revision_id`，事件 `work.updated` 帶 `source: "ai_accepted"` 與 `ai_job_id`。和其他版本一樣可以恢復。
- 只有同一作品、已成功的改寫任務能採用，否則回 409 `ai_job_not_acceptable`。

**不重複送出（QC-029）：**

- 兩個端點回 `WorkAiJobResponse`：`job`、`budget`，加上 `in_progress`。
- 進行中去重：同一作品、相同參數（供應商、解析後的模型、模式與指令、選取範圍、平台與欄位等，也就是同一份提示詞與任務）、同一個 `source_revision`，已有排隊或進行中的任務時，直接回那個任務，`in_progress: true`，不再送出也不再計費；`budget` 是目前的本月狀態（不含新的估算）。已完成（成功、失敗、取消）的任務不算重複，使用者可以再生成一次。作品改過（新的 `source_revision`）或參數不同，就是新任務。判斷用 `ai_jobs.cache_key`（以上欄位的雜湊，前綴與視頻快取鍵不同），查核與建立在同一個同步區段內，同一行程內兩個並行請求不會都建立。
- `Idempotency-Key`：規則同「冪等鍵」一節，作品 id 也算在請求內容裡；重送回原任務的**目前**狀態並帶 `Idempotent-Replayed: true`，即使原任務已完成也一樣（要再生成一次請換新鍵）。同鍵不同請求回 422 `idempotency_key_reused`。

**提示詞與隱私：**

- 原文一律放在 `<原文>` 標籤內，並明說它是素材不是指令，以降低原文中夾帶指令的影響。要求不杜撰原文沒有的事實、沿用原文的語言與繁簡。
- 提示詞只含作品內容與使用者的指令，不含金鑰。服務端不記錄提示詞或原文；Fastify 日誌只有方法與路徑。
- 提示詞超過 50 萬字回 413，不送出。

## Gemini 視頻理解（QC-023）

選定素材庫裡的視頻（托管或外部掛載；只接受素材 id，不接受路徑），原檔直接經 Gemini Files API 上傳，不在本機轉檔、拆片或抽字幕。實作在 `src/ai/video-tasks.ts`（流程）與 `src/ai/providers/gemini-video.ts`（Files API 與 `generateContent`）。

**官方文件查證（2026-11-17，Gemini API 文件「Files API」「Video understanding」「Files API reference」，以及 `@google/genai` 3.4.0 原始碼）：**

| 項目 | 文件內容 | 本服務的做法 |
| --- | --- | --- |
| 單檔上限 | 2 GB | 超過回 413，訊息說明要先自行壓縮或剪短 |
| 專案總容量 | 20 GB | 分析成功、失敗或取消後刪掉遠端檔案，不佔容量 |
| 保留期 | 48 小時後自動刪除（`File.expirationTime`） | 結果存在本機；同一任務的重試與服務重啟後，未過期的遠端檔案會沿用（見下），不同任務之間不共用 |
| 檔案狀態 | `PROCESSING` → `ACTIVE`（可推論）或 `FAILED` | 每 3 秒查一次，最多等 10 分鐘（逾時視同可重試的逾時） |
| 影片長度 | 1M context 模型：預設解析度約 1 小時，低解析度約 3 小時 | 已知時長（ffprobe）超過就回 400，預設解析度時提示可改用低解析度 |
| token 計算 | 每秒取 1 格；預設約 300 token／秒，低解析度約 100 token／秒（含音訊 32 token／秒） | 送出前估算：時長 × 每秒 token；時長未知時以 5 Mbit/s 從檔案大小推估並標明 `size_guess` |
| 支援格式 | mp4、mpeg、mov、avi、x-flv、mpg、webm、wmv、3gpp | 素材的 `video/quicktime` 送成 `video/mov`、`video/x-m4v` 送成 `video/mp4`；其他回 415 |
| 上傳 | 可續傳協定：`start` 取得上傳網址，再以 `X-Goog-Upload-Offset` 分段上傳，最後一段 `upload, finalize` | 自行實作（理由見下），每段 8 MiB |

- **為什麼不用 `ai.files.upload`：** SDK 的上傳沒有進度回報，連線中斷就丟錯，無法續傳。因此上傳照文件的可續傳協定自己送，其餘（查狀態、刪除、`generateContent`）用 SDK。路徑沿用 SDK 的預設 API 版本 `/upload/v1/files`、`/v1/files/…`（REST 文件範例是 `/v1beta`）。
- **續傳：** 上傳網址存在任務的 `remote_state`。中斷後的重試先用協定的 `query` 命令問伺服器已收到多少，從那裡接著傳。`query` 出自 Google 通用的可續傳上傳協定（Photos、Street View 文件），Gemini 文件沒有列出；伺服器沒回答時就重新開始上傳，結果一樣正確，只是多傳一次。
- **檔案已上傳但分析失敗（例如 429）：** 重試直接沿用遠端檔案，不重新上傳。
- **服務重啟（QC-029）：** 關閉服務造成的中止不等於取消：不刪遠端檔案，也保留 `remote_state`（上傳網址或遠端檔名）。重啟後任務回到排隊，下一次執行先用 `files.get` 查留下的遠端檔：狀態是 `PROCESSING` 或 `ACTIVE`，而且離到期還有 1 小時以上（`expirationTime`；沒給時以上傳完成時間加 48 小時推算），就沿用，不重傳；查詢回不可重試的錯誤（視為檔案已不在，例如 404；403 也歸這類，金鑰真有問題時新的上傳會再報 `invalid_key`）、已是 `FAILED`、或即將或已經過期，就盡量刪掉舊檔後重新上傳。查詢遇到 429、5xx、逾時則保留狀態，照一般規則重試。還沒傳完的上傳同樣保留上傳網址，重啟後照上一點續傳。分析只送一次，費用只算一次。

**結構化結果**（`VideoUnderstandingResult`，api-client 的 `videoUnderstandingOf(job)`）：摘要、重要時間點（秒數、標籤、說明，依時間排序）、標題建議、簡介建議、封面建議（以時間點表示，由前端自行擷取畫面）。每個時間點都標 `needs_verification: true`；已知片長時，超出片長的時間點標 `within_duration: false`。結果附「時間點與內容由 AI 產生，可能有誤，需核驗」的提示。

**快取與防重複：**

- 快取鍵 = 檔案 sha256 + 任務類型 + 提示詞版本 + 模型 + 解析度。
- 有成功結果時回 200 `cached: true` 與舊任務，什麼都不送、不計費；使用者明確帶 `reanalyze: true` 才重新上傳分析並計費。
- 同一個快取鍵已有排隊或進行中的任務時，回該任務（`in_progress: true`），即使帶了 `reanalyze` 也不重複送出。
- 相同內容的檔案在素材庫會去重成同一個素材，所以也會命中快取。

**送出前確認：** `…/video-understanding/estimate` 回檔案大小、時長（來源）、模型、解析度、輸入 token 估算、最多花費、本月提醒狀態，以及可沿用的舊任務 id。

**進度、取消與重試：**

- `job.progress` 與 `ai_job.progress` 事件：`uploading`（每段一次，帶已上傳與總位元組）、`processing`（等 Gemini 處理）、`analyzing`（產生結果中）。
- 取消（`POST /api/v1/ai/jobs/:id/cancel`）會中止進行中的上傳或請求，並盡量刪掉已上傳的遠端檔案；只傳了一部分的上傳無法刪除，由 Google 依保留期清掉。關閉服務不算取消（見上方「服務重啟」）。
- 429、逾時、連線中斷照 QC-021 規則自動重試（事件 `ai_job.queued`），上傳會續傳。Gemini 處理失敗記 `file_processing_failed`、素材檔不見記 `source_unavailable`，都不自動重試，且會刪掉遠端檔案。
- 用量與費用照 QC-021 記錄（Gemini 回報的 token，依價格表估算）。

**權限與隱私：** 路由只限主權杖，需要 Gemini 金鑰與告知確認。金鑰只放在請求標頭，不進任何請求內容或日誌。

## 編輯器 AI 面板（QC-024）

編輯頁右側預設是 AI 面板，打開「歷史」時由版本歷史取代。邏輯在 `apps/mac/src/renderer/ai-session.ts`（不依賴 React，可直接對真實 mac-server 測試），畫面在 `AiPanel.tsx`。

- **供應商**：依 Claude → Gemini → GPT → New API 取第一個 `ready` 的供應商。多家已啟用時，可在編輯器 AI 面板為目前開啟的作品選擇文字供應商。沒有可用的供應商時，面板頂端顯示「尚未設定 AI 金鑰」或「尚未確認雲端 AI 使用告知」，加「前往設定」，不送出任何請求；送出時收到 409 `ai_key_missing`／`ai_consent_required` 也一樣處理。供應商的選擇介面與告知確認在 QC-025。
- **選取範圍**：`@qiu-creator/markdown-editor-web` 提供 `getSelectionRange()` 和 `onSelectionChange`。原始碼模式直接用 textarea 的位移；視覺模式以頂層區塊的文字對應 Markdown 區塊（`selection.ts`），並擴展成整段。沒有選取時改寫全文。
- **改寫**：生成前會先儲存這個視窗的修改，讓候選以最新版本為基準。結果依句子做 diff（`rewrite-diff.ts`，切分不遺漏字元）：一段連續修改中，句數相同就一句一處，否則合成一處。採用時由勾選的各處組成全文，經 `WorkSession.acceptAi` 送到 accept API；插入則是把候選全文加在選取段落之後。
- **衝突**：採用時回 409 `revision_conflict`（或這個視窗已收到遠端新版本），組好的全文會成為這個視窗的草稿，開啟既有的衝突對話框。伺服器上的內容不會被覆蓋。
- **復原**：把採用前的版本（`source_revision`）恢復成一個新版本（`restore`），歷史保留。復原後候選不再顯示，改為提示「原稿已變更，請重新生成」，因為它的基準版本已過時，再採用必定 409。
- **任務狀態**：收到 SSE `ai_job.*` 時重新讀取任務；另外每 3 秒輪詢一次，作為 SSE 中斷時的後備。「停止」呼叫 `ai.stop`。失敗的任務用 `ai.retry` 重跑；候選已顯示時按「重試」，則用同樣參數建立新任務。
- **標題候選**：一次 `suggestions` 任務（四平台，只要標題，每平台 3 個）。「寫入平台版本」逐平台以當下的 `revision` 為 `base_revision` 寫入；沒有版本的平台先用 `redraft` 從原稿建立。結果訊息寫明哪些平台是新建的。某平台 409 時只標示該平台失敗，不重試、不覆蓋。

## AI 工作台與設定頁 AI 服務（QC-025）

前端在 `apps/mac/src/renderer`：設定邏輯在 `ai-settings.ts`，畫面在 `AiSettingsSection.tsx`；工作台邏輯在 `ai-video.ts`，畫面在 `AiWorkbenchPage.tsx`。邏輯都不依賴 React，可以直接對真實 mac-server 測試。

**設定 → AI 服務**

- **金鑰**：用 password 欄位輸入，送出前就清空欄位，送出後只顯示「鑰匙圈 · 已啟用」或「待確認告知」。視窗狀態、DOM 和 web storage 都不保留金鑰；API 本來就不回傳金鑰。刪除前要二次確認。
- **告知**：有金鑰但還沒確認時，顯示該供應商的完整告知文字，寫明內容會送到哪家公司。按「我已了解，啟用」時，以畫面上顯示的版本號確認；已確認的可以撤回。
- **模型**：每家有文字模型，Gemini 另有視頻模型。選項來自價格表，再加上目前設定的模型。
- **每月提醒金額**：可以設定或清除，旁邊顯示本月的估算用量。超過只提醒，不會擋下任務。
- **其他**：「僅本地模型」與本地模型列都停用，註明延後提供。從編輯器或工作台按「前往設定」，會打開設定頁並聚焦「AI 服務」標題。

**AI 工作台**

- 只做 Gemini 視頻理解，因為 API 只有這一種視頻任務，一次回傳全部結果。Claude、GPT 標「不支援視頻」，本地模型標「延後提供」，都停用。
- 從素材庫選視頻。
  - 片長超過預設解析度的上限（約 1 小時）時，先改用低解析度再估算，因為服務端會以 400 拒絕預設解析度。
  - 估算顯示大小、時長和最多花費，金額都標「估算」；時長是依檔案大小推估時，會另外註明。
- 每次分析前都顯示確認對話框。
  - 還沒確認 Gemini 告知時，同一個對話框會顯示告知，按鈕寫「同意並上傳分析」，按下後先呼叫 consent，再送出。
  - 估算有可沿用的舊結果（`cached_job_id`）時，先問要「沿用結果」（免費）還是「重新分析」（帶 `reanalyze: true`，會再確認一次費用）。
- **進度**：只有上傳階段有可信的位元組，才顯示百分比；processing、analyzing 用不確定進度條加階段文字。另有取消；失敗時可以重試（沿用已上傳的遠端檔案），或查看這支視頻上次成功的結果。
- **結果**：摘要、時間點、封面建議、標題與簡介建議，標「待核驗」並附免責說明。
  - 超出片長的時間點標「超出片長」。
  - 封面建議直接把影片在該秒的畫面當縮圖（`qc-asset://stream` 載入 metadata 後跳到該秒），不另外擷取或存檔。
  - 點時間點或封面會打開素材檢視器，從該秒開始播放（素材頁路由多了 `startAt`）。
  - 標題和簡介用主程序的剪貼簿複製。
- **用量卡**：本月估算總額、各供應商小計、超額提醒，以及最近 20 個 AI 任務（狀態與費用）；點成功的視頻任務會載入它的結果。收到 SSE `ai_job.*` 時更新，`ai_job.progress` 只更新進度。

## 外部資料夾掛載

已有的 Markdown 資料夾用**掛載**的方式加入：就地索引，**不搬移、不改名、不刪除**任何檔案。實作在 `src/mounts/mount-service.ts` 與 `WorkService` 的外部作品部分。

- **掛載路徑檢查**：必須是絕對路徑、可讀的資料夾；以 `realpath` 解析（符號連結或 `..` 會先展開成真正位置再檢查）。拒絕：檔案系統根目錄、使用者家目錄本身、`CREATORHUB_HOME` 或其子資料夾、包含 `CREATORHUB_HOME` 的上層資料夾、與其他掛載重疊的資料夾；同一資料夾重複掛載回 409。卸載後再掛載同一路徑會沿用原掛載，作品與歷史自動接回。
- **掃描**：背景任務 `mount.scan` 遞迴列出 `.md`／`.markdown`（不超過 5 MiB）。略過隱藏檔與隱藏資料夾（含 `.obsidian`、編輯器暫存檔與本服務的原子寫入暫存檔）、`node_modules`、**所有符號連結**（不跟隨，掛載無法經由連結讀到資料夾外）。服務啟動時與每 10 分鐘會重掃一次，補上監控漏掉的變化。
- **外部作品**：`works.storage_mode = 'external'`、`mount_id`、`source_path`（相對於掛載根目錄）、`external_state`（`present`／`missing`／`unmounted`）。標題取第一個 Markdown 標題，沒有就用檔名。快照仍存在 `library/works/<id>/revisions/`，不寫進使用者的資料夾。
- **監控**（chokidar）：`awaitWriteFinish` 讓檔案停止變化一段時間（預設 2 秒）後才處理，寫一半的檔案不會進入資料庫；新增或變更走同一個對帳流程（見下）。chokidar 的 scheduler（時鐘與計時器）可經 `MountServiceOptions.scheduler` 注入，僅供測試用手動時鐘驗證穩定視窗（QC-020）；正式環境不傳，用 chokidar 預設的真實時鐘。
- **抑制回授**：對帳時比較磁碟內容的 sha256 與目前 revision；相同就不做事。App 自己寫回檔案時會先建立 revision，所以隨後監控看到的變化與目前 revision 相同，不會再產生 `external` revision。
- **刪除**：檔案消失只把 `external_state` 標成 `missing`，發 `work.source_missing` 事件；作品、revision 與快照全部保留，讀取時回傳最後一個快照的內容。外部作品在 `missing` 或 `unmounted` 狀態下 PATCH 回 409 `source_missing`，不會重建檔案。
- **改名／搬移**：同一掛載內出現新檔案、而內容雜湊等於某個 `missing` 作品的目前 revision 時，視為同一作品搬到新路徑：更新路徑、恢復 `present`、發 `work.source_restored`（`reason: "moved"`，帶 `from`／`to`），不會產生重複作品。檔案回到原路徑也會恢復 `present`。
- **寫回外部檔案**：與托管作品相同——先對帳（外部有新內容就先記成 `external` revision，舊 base 回 409）、寫入不可變快照、再以暫存檔＋`rename` 原子替換。原子替換會保留原檔的權限位元；暫存檔名以 `.` 開頭，監控會忽略。外部檔案只接受一般檔案：若原檔被換成符號連結，視為遺失，不會跟隨讀寫。
- **卸載**：停止監控，作品標成 `unmounted`，檔案不動。

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

## 建置產物、日誌與睡眠（QC-030）

- **建置產物**：`corepack pnpm --filter @qiu-creator/mac-server build` 產出 `services/mac-server/dist/`，內容是 `server.mjs`、`node_modules/`（原生模組等）、`bin/node`、`build-info.json`。整個資料夾複製到任何位置都能用 `bin/node server.mjs` 啟動，安裝位置是 `~/Library/Application Support/qiu-creator/server`。做法與理由見 `docs/dependencies.md`，安裝見 `deploy/launchd/README.md`。
- **主程式與行程內重載**：`src/main.ts` 用 `startHost`（`src/host.ts`）啟動服務。還原時，服務在同一個行程裡關閉並重建，`/health` 與 API 只會中斷片刻。重建失敗就結束行程，交給 launchd 重啟；重啟時會再套用一次待還原的備份。
- **日誌**：設了 `CREATORHUB_LOG_FILE`（launchd 範本有設）時，服務自己寫日誌檔：每檔 10 MB，保留 5 份舊檔（`src/log-file.ts`）。沒設時寫到 stdout。launchd 的 stderr 檔只收日誌系統以外的輸出，啟動時超過上限就清空。
- **防閒置睡眠**（`src/power/sleep-guard.ts`）：
  - 以下任一情況成立時，持有一個 `caffeinate -i -w <pid>`：
    - 有上傳請求正在接收位元組（直傳或 tus PATCH）。
    - `import_jobs` 或 `background_jobs` 有排隊或執行中的任務。
    - `ai_jobs` 有排隊或執行中的任務。
  - 狀態在任務事件與上傳開始、結束時立即重新判斷，另外每 5 秒檢查一次。全部結束 60 秒後釋放，涵蓋 tus 分段之間的空檔。
  - `-w` 讓服務被 SIGKILL 時斷言也跟著消失。
  - 只防閒置睡眠。合蓋時是否睡眠由系統決定（電池下仍會睡），留給 QC-033 實機驗證。
  - 喚醒後的續跑：中斷的請求會以逾時或連線錯誤失敗，由各自的任務佇列重試；tus 上傳由用戶端以 `HEAD` 取得 offset 續傳。
  - 斷言的提供者可以注入，測試一律用假實作（`noWakeLocks` 或記錄型）。
- **崩潰恢復**（SIGKILL）：`test/crash-recovery.test.ts` 用真的子行程驗證以下情況都能恢復：
  - 已回 201 的寫入都在（WAL）。
  - tus 上傳以 `HEAD` 拿到的 offset 續傳完成。
  - 下載到一半的 URL 匯入重新排隊並成功。
  - 等待供應商回應的 AI 任務重新送出一次並成功。
  - 結束後資料庫 `integrity_check` 為 `ok`。

## SQLite 備份與還原（QC-030）

實作在 `src/backups/backup-service.ts`，路由在 `src/routes/backups.ts`，契約在 `packages/contracts/src/backups.ts`。只限主權杖，Agent 權杖連 GET 都是 403。

- **備份**：
  - 用 better-sqlite3 的線上備份 API（`db.backup`）複製到 `<home>/backups/<id>.sqlite.partial`。服務不必停，寫入也不會被擋。
  - 複製完把副本改成單檔模式（`journal_mode = DELETE`），再用唯讀方式跑 `PRAGMA integrity_check`，然後原子改名，並寫旁註 `<id>.json`。目錄權限 0700，檔案權限 0600。
  - 備份一次只做一份，依序排隊。
  - `id` 的格式是 `<UTC 時間到毫秒>Z-<kind>`。
- **種類與保留**：`daily`、`manual`、`pre_restore` 三種，各保留最新 14 份。每次新增備份後，刪掉同種類較舊的。分開保留，是為了避免多次手動備份把每日備份擠掉。
- **每日**：
  - 服務啟動 1 分鐘後檢查一次，之後每小時檢查。最新的每日備份超過 24 小時就再做一份；MacBook 睡醒後的第一次檢查會補上。
  - 失敗時記下 `last_error`，並發 `backup.failed` 事件。
- **還原**（`POST /api/v1/backups/:id/restore`）：
  1. 重新檢查目標備份：要能通過完整性檢查，而且不能含有這個版本不認識的 migration（也就是較新版本的備份），否則回 409 `backup_not_restorable`。
  2. 備份當前狀態（`pre_restore`）。這份必須通過檢查，否則不還原。
  3. 在同一個交易裡記下 `backup.restore_started` 事件，並寫入 `data/restore-pending.json`。之後非 GET 請求一律回 503 `restoring`，避免寫進即將被替換的資料庫。
  4. 回 202 後，主程式關閉服務（任務佇列、AI、掛載、資料庫）再重建。重建開資料庫之前，先用備份替換資料庫：複製到暫存檔、fsync、刪掉舊的 `-wal`／`-shm`、改名覆蓋。舊 WAL 的內容已經在 `pre_restore` 備份裡。
  5. 開啟後跑 migration（較舊的備份會升級），把 `change_log` 的序號推到還原前的最大值之後，記下 `backup.restored`，刪除標記。用戶端帶 `Last-Event-ID` 重連時不會漏事件。收到 `backup.restored` 就應該重新取得所有資料。
  - 沒有能重載的主程式時（例如嵌入測試），回 `reload: restart_required`，標記在下次啟動時套用。
  - 標記指向的備份在啟動時已損壞，就取消還原，照原資料庫啟動。
- **範圍**：只備份 SQLite（索引、版本記錄、任務、設定、權杖雜湊）。`.md` 原稿、版本快照與媒體是磁碟檔案，不在備份裡，要靠 Time Machine。
  - 還原到較早的備份後，之後才建立的作品資料夾仍留在磁碟上，但資料庫不再引用它們。這些資料夾不會被刪除。
  - 版本快照是不可變檔案，所以舊資料庫引用的快照都還在。

## 變更事件（SSE）

`GET /api/v1/events` 回 `text/event-stream`：`id` 是 `change_log.seq`，`event` 是動作名，`data` 是 `ChangeEvent` JSON。動作包括 `ai_job.queued`／`running`／`progress`／`succeeded`／`failed`／`cancelled`（AI 任務）、`work.variant_created`／`work.variant_updated`／`work.variant_deleted`（平台版本）、`work.created`、`work.updated`（`data.source` 為 `edit` 或 `restore`）、`work.external_revision`（外部編輯器改了 `source.md`）、`work.assets_changed`、`asset.created`、`asset.updated`、`job.queued`、`job.running`、`job.succeeded`、`job.failed`，以及實體 `system`（`entity_id` 為 `database`）的 `backup.created`／`backup.failed`／`backup.restore_started`／`backup.restored`（QC-030）。

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
| （程式選項）`mounts.stabilityMs` | 2000 | 檔案停止變化多久才索引 |
| （程式選項）`mounts.rescanIntervalMs` | 600000 | 掛載的定期完整重掃；0 停用 |
| `CREATORHUB_FFPROBE` | （自動尋找） | ffprobe 路徑；設為空字串停用。找不到時降級，不報錯 |
| （程式選項）`ai.concurrency` | 2 | AI 任務同時執行數 |
| （程式選項）`ai.timeoutMs` | 120000 | 單次供應商請求逾時 |
| （程式選項）`ai.retryBaseMs` | 5000 | AI 任務自動重試的退避基數 |
| `CREATORHUB_LOG_FILE` | （無，寫 stdout） | 日誌檔；設定後依大小輪替（QC-030） |
| `CREATORHUB_LOG_MAX_BYTES` | 10485760 | 每個日誌檔上限；保留 5 份舊檔 |
| `CREATORHUB_STDERR_FILE` | （無） | launchd 的 stderr 檔；啟動時超過上限就清空 |
| （程式選項）`backups.checkMs` / `initialDelayMs` / `retention` | 1 小時 / 1 分鐘 / 14 | 每日備份的檢查間隔、首次檢查延遲、每種保留份數 |
| （程式選項）`sleep.provider` / `checkMs` / `lingerMs` | caffeinate / 5000 / 60000 | 防閒置睡眠的提供者（測試注入假實作）、檢查間隔、任務結束後延遲釋放 |

## 尚未實作（依里程碑）

- M1 已完成。視頻縮圖（需 ffmpeg）尚未做。外部圖片只在呼叫 `/works/:id/media` 時登記，掛載掃描不會主動登記。
- 素材庫還缺的服務端 API：匯入任務取消、素材刪除或移出索引、監控資料夾自動匯入（QC-015）。
- 平台版本尚無「恢復某一版」的 API（歷史已存好，可直接加）；草稿是固定規則，AI 產生平台版本屬 M3。
- M2：Electron／外部編輯器／Agent 三方衝突的完整驗收（QC-014）。
- M3：AI 基礎（QC-021）、文字候選與改寫（QC-022）、Gemini 視頻理解（QC-023）已完成；本地模型延後。
- 生產可用：launchd 實機安裝、崩潰恢復、SQLite 備份與還原（QC-004）。

# Done

## QC-019: 平台版本刪除後重建，版本號重用導致靜默覆蓋

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M2, backend

### 完成摘要

- 平台版本 revision 單調遞增：刪除留墓碑列並佔一個 revision、歷史保留，讀取與列表對墓碑回 404，重建從 max+1 起算；整數 If-Match 不變，前端不用改。
- 回歸測試加上 QC-014 的 `it.fails` 轉為一般通過測試。驗收：總監合併後複跑 441／0／441。合併 2026-11-17。

## QC-014: M2 三方衝突與平台版本驗收

**Priority:** P1 | **Assignee:** qc-bugfix | **Tags:** M2

### 完成摘要

- API 層持久測試 `m2-three-party.test.ts`：托管與外部掛載作品的三方矩陣、六種先後順序、10 個並行存檔恰好 1 勝、恢復舊 base 409、檔案消失 409 `source_missing`、四平台互不串改。
- Electron 實機 38／38（連跑 5 次），腳本 `docs/evidence/qc014-run.sh`，紀錄 `docs/evidence/qc014-acceptance.md`。發現唯一缺陷即 QC-019。NOT_VERIFIED：建置產物啟動、極小時間窗跨行程寫入、FSEvents 延遲量化。合併 2026-11-17。

## QC-016: SSE external_revision 測試在高負載下逾時

**Priority:** P2 | **Assignee:** qc-bugfix | **Tags:** M2, backend

### 完成摘要

- 根因：測試輔助 `collect` 訂閱 SSE 後只固定等 50 ms，高負載時連線晚於事件而漏收；伺服器行為正確未改。
- 修法：訂閱前取 `feed.latestSeq()` 當 Last-Event-ID、移除固定等待；新增延遲連線回歸測試（先紅後綠）。負載 25 對照：舊版 4／60 失敗、新版 0／60。證據 `docs/evidence/qc016-sse-external-flake.md`。合併 2026-11-17。

## QC-013: 四平台模擬預覽（M2 前端 3/3）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M2, frontend

### 完成摘要

- `packages/platform-preview`：純 TS 的 `buildPreviewModel()` 加四個模擬模板，畫面元件在 `./react`，不綁死 Electron；全部標「模擬」、無官方標誌。
- 平台預覽頁：各平台獨立 revision、自動儲存（組字中不存）、從原稿建立／重新產生（先確認）、即時超限警告；409 時由使用者選「載入最新」或明確「以我的修改覆蓋」（舊版留在歷史）。
- 驗收：總監合併後複跑 417／0／417（含 QC-016）；Electron 實機 20/20，證據 `docs/evidence/qc013-acceptance.md`。NOT_VERIFIED：實體輸入法、VoiceOver、雙實機視窗、上限是否符合真實平台、影片預覽、建置版。合併 2026-11-17。

## QC-009: 平台版本 API（M2 後端 2/2）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M2, backend

### 完成摘要

- 四平台 PlatformVariant 存 SQLite（只追加歷史表做快照，單一交易），整數 revision；寫入需 base_revision 或 If-Match（缺 428、過期 409 附目前版本）。
- 規則草稿（不呼叫 AI）、單平台重新產生、刪除；`PLATFORM_LIMITS` 參考值放 contracts，超限照存並回 `warnings`，`checkVariantLimits()` 純函式供前端共用；SSE 事件；`client.variants`。
- 測試涵蓋四平台互不串改與並發 409。驗收：總監合併後複跑 397／0／397。範圍外：平台版本恢復 API、AI 產生平台版本（M3）。合併 2026-11-17。

## QC-011: Mac 作品管理與編輯完整化（M2 前端 2/3）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M2, frontend

### 完成摘要

- 作品庫即時刷新；外部修改提示（有未存修改或組字中暫停自動儲存，可比對合併）；版本恢復（diff 加確認，409 不覆蓋）；狀態與標籤走同一儲存佇列；檔案遺失唯讀與自動恢復；外部來源標示；Markdown 圖片走簽名網址（不載入外部 http 圖片）；素材引用。
- 驗收：總監合併後複跑 397／0／397；Electron 實機 31/31，證據 `docs/evidence/qc011-acceptance.md`。NOT_VERIFIED：實體鍵盤輸入法、VoiceOver、Finder 實開、簽名網址實機換新、外接硬碟拔除、建置版啟動。合併 2026-11-17。

## QC-010: 版本恢復、作品中繼資料與 Markdown 圖片解析（M2 後端 1/2）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M2, backend

### 完成摘要

- 讀單一歷史版本、恢復為新 revision（帶 base_revision，衝突 409，不改寫歷史）；狀態與標籤 PATCH 補齊。
- `/works/:id/media` 解析托管與外部作品的相對圖片路徑（防穿越、不跟隨符號連結，外部圖片只登記不搬移）；`GET /assets/:id/works` 反查引用作品。
- `POST /api/v1/media/signed-urls`：HMAC 簽名網址綁定路徑、到期（1 小時）與權杖主體，撤銷權杖即失效；Bearer 路由不接受簽名，Range 行為一致。
- 驗收：總監合併後複跑 323／0／323。合併 2026-11-17。

## QC-012: Mac 素材庫、匯入任務與設定頁（M2 前端 1/3）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M2, frontend

### 完成摘要

- 素材庫（列表、檢視器、原圖與影音播放）、上傳（直傳與 tus）、URL 匯入、任務列表（進度、原列重試）、掛載管理、Agent 權杖（明文只顯示一次）；設定頁含服務狀態與托管目錄。
- 主程序 SSE 經 IPC 推給 renderer（共用通道）；媒體經 `assetMediaUrl()` 走主程序代理 `qc-asset://`（白名單 thumbnail／stream 加 UUID，Range 直通）。
- 原型中缺 API 的控制項不顯示，排入 QC-015、QC-004。驗收：總監合併 QC-010 後複跑 355／0／355；Electron 播放器實機 6/6。合併 2026-11-17。

## PT-20261117-001: M2 補充狀態（原型）

畫布第 31 版：外部檔案遺失、版本恢復確認、外部掛載來源標示、平台上限警告。總監依小型修改權限核准 2026-11-17；畫布實際渲染 NOT_VERIFIED。

## QC-007: 外部目錄掛載與資料夾監控（M1 後端 3/3）

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M1, backend

### 完成摘要

- `/api/v1/mounts`（管理限主權杖）與 CLI；外部 `.md` 只索引不搬移，拒絕 9 類不安全路徑（穿越、符號連結逃逸、CREATORHUB_HOME 等），符號連結一律不跟隨。
- Chokidar 監控（正式用 FSEvents，測試用 polling 後端避免系統事件延遲）；寫一半的檔案等寫完才索引；自身寫入不回授；啟動與每 10 分鐘重掃補漏。
- 改名以內容雜湊接回同一作品；刪除只標 missing（寫入回 409 `source_missing`），放回即恢復；卸載不動檔案。寫回外部檔前核對 revision，快照存在 library 內；原子寫入保留原檔權限位元。
- 驗收：總監合併後複跑全倉 276／0／276，typecheck、lint、format 通過；證據 `docs/evidence/qc007-mount-run.md`。範圍外：外部資料夾的圖片未索引；「檔案已遺失」介面待 M2。合併 2026-11-16。

## QC-006: URL 匯入、匯入任務與冪等（M1 後端 2/3）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M1, backend

### 完成摘要

- `POST /api/v1/imports/urls`、`GET /api/v1/jobs/:id`、`POST /api/v1/jobs/:id/retry`；下載完走 QC-005 素材登記。
- SSRF：每跳只解析一次且全部須為公網位址，連線釘在已檢查的 IP（防 DNS 重綁定）；重定向最多 5 次逐跳重驗；擋回環／私網／鏈路本地／CGNAT／IPv4 對映 IPv6／NAT64／6to4／Teredo；Content-Type 白名單、大小與三段逾時。
- 冪等鍵（`works` 建立與 URL 匯入，每權杖一組；同鍵異內容 422；Agent 權杖未帶 428）。Agent 權杖分 `read`／`import`／`write`，未列路由預設只限主權杖，只存 sha256；`import` 權杖可查自己的任務。CLI `import url`、`jobs get`。
- 驗收：總監合併後複跑 200／0／200，typecheck、lint 通過；證據 `docs/evidence/qc006-curl-run.md`（只用本機假上游）。合併 2026-11-16。

## QC-002: Electron Mac 最小工程與編輯器（M0 前端）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M0, frontend

### 完成摘要

- `apps/mac`（Electron + React + Vite，只走 api-client）、`packages/markdown-editor-web`（MDXEditor，可視／原始碼切換、IME 安全）、`packages/platform-preview` 骨架、`packages/design-tokens`（核准的「暖白克制」token，Inter 隨附）。
- 作品庫（網格／列表、篩選、窄視窗）、編輯器（自動儲存、revision、歷史）、409 衝突對話框（查看差異、保留雙方、手動合併）、服務離線與重連、深色模式；關窗後服務照常。
- 驗收：總監合併後複跑全倉 262／0／262（含 apps/mac 40、markdown-editor-web 15），typecheck、lint、format 通過；證據 `docs/evidence/qc002-acceptance.md` 與 18 張截圖。
- NOT_VERIFIED：實體鍵盤系統輸入法、圖片顯示（待素材 URL 對應）、VoiceOver、與畫布並排比對、打包後執行。合併 2026-11-16。

## QC-008: 追查 tus 續傳偶發卡死（QC-005 遺留）

**Priority:** P2 | **Assignee:** qc-bugfix | **Tags:** M1

### 完成摘要

- 原始卡死 270 次壓力嘗試未重現（NOT_VERIFIED，推論為 tsx watch 重啟或舊 FileStore 非同步 mkdir）。
- 另修無聲斷線佔鎖：tus PATCH 加 60 s socket 閒置逾時（`tusIdleTimeoutMs` 可調），先紅後綠回歸測試；壓力腳本 `scripts/tus-stress.ts`。
- 驗收：總監複跑 114／0／114。合併 2026-11-16。

## QC-005: 素材庫、上傳與變更事件（M1 後端 1/3）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M1, backend

### 完成摘要

- 素材 API；小檔直傳（≤32 MiB）與 tus 1.0 續傳；magic bytes 類型判斷、分類大小上限、sha256 去重；素材存 `library/assets/<id>/`，作品–素材關聯與排序。
- SQLite 持久任務佇列（重啟續跑、退避重試）：Sharp 縮圖（`cache/` 可重建）、ffprobe 元資料（缺席時降級，不打包 GPL 元件）。
- SSE `/api/v1/events`（header 鑑權、`Last-Event-ID` 補發）、FTS5 中文搜尋。
- 驗收：總監複跑 111／0／111，typecheck、lint 通過；curl 證據 `docs/evidence/qc005-curl-run.md`。偶發 tus 卡死未重現，另開 QC-008。合併 2026-11-16。

## PT-20261116-001: Mac 原型 v0.1 與視覺基線

使用者 2026-11-16 核准畫布第 24 版（8 張 Mac 畫板），視覺基線「暖白克制」已寫入 DESIGN.md。

## QC-001: 搭建 monorepo 骨架與 Mac 服務最小主鏈路（M0 後端）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M0, backend

### 完成摘要

- pnpm 12 workspace、TS 5.9（typescript-eslint 尚不支援 7.x）、ESLint／Prettier／Vitest；contracts（Zod 4，第三章全部實體與作品 API DTO）、domain、api-client、agent-sdk（`creatorhub works create/list`）。
- mac-server：Fastify 5 + better-sqlite3（WAL、FTS5 trigram），只新增式遷移；Bearer 權杖（未設時建立 0600 權杖檔）；作品建立／列表／讀取／修改，原子寫入、每版不可變快照、`base_revision`／`If-Match` 衝突回 409、外部修改自動記為 `external` 版本；Range 視頻流；`/docs` OpenAPI；launchd plist 範本（未安裝）。
- 驗收：總監複跑 typecheck、lint 通過，測試 69／0／69；curl 證據 `docs/evidence/qc001-curl-run.md`。冪等鍵只有資料表唯一鍵，M1 匯入中心再強制。合併 2026-11-16。


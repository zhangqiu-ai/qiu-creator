# Done

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


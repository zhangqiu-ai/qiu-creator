# In Progress

## QC-010: 版本恢復、作品中繼資料與 Markdown 圖片解析（M2 後端 1/2）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M2, backend

前端 QC-011 依賴本任務。讀取單一歷史版本內容；恢復某版本會產生新的 revision（`source: restore`，帶 `base_revision`，衝突回 409），不改寫歷史；作品狀態與標籤的 PATCH 和驗證（若已有，補齊測試與 SSE 事件）；Markdown 圖片解析：托管作品的 `./assets/…` 與外部掛載作品資料夾內的相對路徑，對應到可帶權杖的串流 URL（Range），禁止跳出作品或掛載根目錄；外部資料夾內被引用的圖片登記為素材關聯（只索引不搬移）。補：素材 → 作品反查；renderer 免 header 載入的做法同樣涵蓋 `GET /assets/:id/stream`。

### Plan

- revisions 加 `GET /works/:id/revisions/:rid` 與 `POST …/restore`；restore 走原子寫入與快照，SSE `work.updated`。
- 圖片解析 API（建議 `GET /works/:id/files/*path`），重用 safe-path 防穿越與符號連結逃逸，不跟隨連結。
- 測試全用臨時目錄；更新 architecture.md 與 contracts、api-client。

## QC-012: Mac 素材庫、匯入任務與設定頁（M2 前端 1/3）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M2, frontend

照已核准原型 PT-20261116-001 的「素材庫」「匯入任務」「設定」畫板，接上 M1 已完成的 API：素材列表與檢視器（縮圖、時長、尺寸、雜湊、引用作品）、上傳（小檔直傳與 tus 續傳）、URL 匯入、任務列表（進度、失敗原因、重試、重複沿用）、資料夾掛載管理與重掃、Agent 權杖建立與撤銷（明文只顯示一次）。設定頁第一期不做 Tailscale／裝置配對，只顯示「第二期」佔位或隱藏；AI 金鑰區留給 M3。

### Plan

- 以 api-client 的 `assets`、`imports`、`jobs`、`mounts`、`tokens` 接線；主程序訂閱 SSE 再經 IPC 推給 renderer，任務進度即時更新。
- 失敗狀態在原列重試；空狀態、載入、離線照 DESIGN.md。
- 自動測試加 Electron 實機截圖；IME 與 VoiceOver 照 DESIGN.md 驗收等級標示。

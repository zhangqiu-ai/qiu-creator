# Backlog

## QC-086: 公眾號正文支援公式、圖表與程式碼高亮

**Priority:** P4 | **Assignee:** qc-frontend ＋ qc-prototype | **Tags:** M3, frontend

使用者 2026-11-24 記入。參考 markdown-viewer/markdown-viewer-extension（GPL-3.0，只參考做法，不引入程式碼）：公眾號長文常含程式碼、LaTeX 公式與 Mermaid 圖表，目前預覽只顯示原文。評估以授權寬鬆的成熟套件（如 Shiki、KaTeX、Mermaid）接入公眾號正文的 `deriveVariantBody` 與預覽；同時確認貼到公眾號後台時的呈現（內聯樣式、圖表是否需轉成圖片）。新增依賴須記錄在 `docs/dependencies.md`；呈現方式改變要先出原型給使用者核准。

## QC-083: 視頻理解摘要作為 AI 標題素材

**Priority:** P3 | **Assignee:** qc-backend ＋ qc-frontend | **Tags:** M3

QC-076 前端建議：視頻作品在平台預覽生成標題時，以視頻理解摘要作為素材；後端 title suggestions 需加欄位。

## QC-080: 拼音搜尋在大量作品時變慢，評估預先計算讀音索引

**Priority:** P3 | **Assignee:** qc-backend | **Tags:** M3, backend

QC-079 沒有加拼音索引欄位，改為查詢時比對。量測（`docs/evidence/qc079-*`）：300 件 × 2000 字時查詢 ≤44ms；3000 件 × 3000 字時無命中或首字母查詢約 0.6–1.5 秒，即時搜尋會明顯卡頓。作品量接近千件前，評估預先計算讀音索引（可回滾 migration、只動索引）或背景 worker、輸入去抖與取消舊查詢。

## QC-058: 刪除素材前提示「也被最近刪除中的作品使用」

**Priority:** P3 | **Assignee:** qc-frontend | **Tags:** M3, frontend

QC-053 後，素材刪除／永久刪除的回應帶 `references.in_trash`。素材永久刪除時，最近刪除中作品對它的連結也會移除，作品之後還原就缺這個素材。刪除與永久刪除確認框要列出「也被 N 個在最近刪除中的作品使用」。

## QC-050: 視頻作品小修：用語與封面建議

**Priority:** P3 | **Assignee:** qc-frontend | **Tags:** M3, frontend

- 繁中文案「影片」與專案用語「視頻」不一致（例如 Gemini 確認框「影片會傳到 Google 處理」）；全面檢查 `packages/i18n` 繁中與简中用語，依 GLOSSARY 統一。
- 封面建議的時間點超出片長時（例如 0:12 而片長 0:08），「查看並採用」已停用但沒有標「超出片長」，比照重點時間點補上。
- 時間軸上的封面標記（原型有）：需要記錄封面來自哪一秒，評估是否要後端欄位。

## QC-028: 畫布同步已實作的 M3 狀態與既有差異

**Priority:** P3 | **Assignee:** qc-prototype | **Tags:** M3, prototype

- 把 QC-025 的 15 項補充與 3 項「與原型不同」照實作畫進 MacAI、MacSettings（來源 `docs/evidence/qc025-acceptance.md`）。
- 標題上限改照 contracts（抖音 30、視頻號 16）；編輯頁的狀態／標籤列、格式工具列、頂欄按鈕順序照實作。
- 側欄「發布中心（第二階段）」與「Agent API」列：實作沒有，先回報總監，不自行決定保留或刪除。
- 另補 QC-031 備份區 15 項已核准狀態（自動備份唯讀、清單加確認還原、三段後果說明等）。

## QC-004: Mac 生產可用驗收

**Priority:** P1 | **Assignee:** 未分配 | **Tags:** M3

第一期終點，拆成 QC-030（後端）、QC-031（前端）、QC-032（打包安裝）、QC-033（實機驗收），全部完成即關閉。launchd 安裝與開機自啟、崩潰恢復、SQLite 備份與還原、原稿保護、日常使用一輪無阻斷問題，由 qc-release 打包安裝。依賴 M0–M3 完成。

## QC-003: 第二期：Tailscale 遠端存取、裝置配對與 iPhone／iPad 工程

**Priority:** P3 | **Assignee:** 未分配 | **Tags:** mobile

使用者 2026-11-16 決定：Mac 生產可用（QC-004）通過後才開工。原 M0 的手機外網存取、iPhone 中文輸入、睡眠／斷網提示移到這裡。

## QC-015: 任務取消、素材移除與監控資料夾自動匯入

**Priority:** P2 | **Assignee:** 未分配 | **Tags:** M2, backend

QC-012 對照原型發現的 API 缺口：匯入任務取消（含取消後重試）；素材「移到回收」（可恢復，托管檔案移到 macOS 垃圾桶或 library 內回收區，外部檔案不動）與「移出索引」；監控資料夾自動匯入媒體（與 Markdown 掛載不同）。刪除類行為動工前先回報總監確認設計。

## QC-017: M2 零碎後續

**Priority:** P3 | **Assignee:** 未分配 | **Tags:** M2

- 平台版本「恢復某一版」API（歷史已存）。
- 版本記錄區分「改內文」與「只改狀態／標籤」（服務端加欄位，前端顯示）。
- 根目錄 `test` 腳本呼叫裸 `pnpm`，只有 corepack 的 shell 會失敗（QC-021 回報）。
- 建置版 CSP 寫死 `127.0.0.1:7420`，服務改埠時圖片被擋（移到 QC-031）。
- mounts 的 chokidar 選項用了已棄用的 `interval`，改為 `pollingInterval`（QC-020 回報）。
- 服務建置產物 220 MB（`bin/node` 128 MB），可評估較小的 Node 版本（QC-032 回報）。
- `corepack pnpm -r test` 在 PATH 沒有 pnpm 時子行程 exit 127（QC-032 回報）。
- electron-builder 首次在新 worktree 打包曾卡 6 分鐘無輸出，重跑約 20 秒完成，原因未查（QC-033 安裝回報）。
- 安裝器 bootout 超時訊息只說「舊版仍在原位」，但舊服務已收到 SIGTERM、可能已停；訊息應提示服務可能未運行（QC-036 審查）。
- 還原確認框說明「只倒回資料庫，`.md` 保持最新並以外部修改版本出現」（QC-033 觀察）。
- 還原期間用戶端遇到連線重置而非 503，App 是否重試未驗證（QC-033 觀察）。
- 上傳的 `filename` 查詢參數寫進服務日誌，應遮蔽（QC-033 觀察）。
- `mac-server.err.log` 權限 0644，應與主日誌一致為 0600（QC-033 觀察）。
- 升級時執行中的 App 被搬進 `app.prev` 繼續跑舊版，使用者不易察覺；安裝器應在換 .app 前要求或提示結束 App（QC-033 U0 發現）。
- .app 的 `CFBundleShortVersionString` 為 `0.0.0`，新舊版無法分辨；打包時應帶入版本與 commit（QC-033 U0 發現）。
- 可重試的 AI 供應商錯誤沒有記錄；成功後 `error_code` 清空，無法追查重試原因。應以 warn 記錄錯誤分類與 HTTP 狀態，不記內容（QC-033 U4，New API 任務 attempts=3）。

# Backlog

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

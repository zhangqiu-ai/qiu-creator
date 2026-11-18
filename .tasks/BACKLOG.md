# Backlog

## QC-028: 畫布同步已實作的 M3 狀態與既有差異

**Priority:** P3 | **Assignee:** qc-prototype | **Tags:** M3, prototype

- 把 QC-025 的 15 項補充與 3 項「與原型不同」照實作畫進 MacAI、MacSettings（來源 `docs/evidence/qc025-acceptance.md`）。
- 標題上限改照 contracts（抖音 30、視頻號 16）；編輯頁的狀態／標籤列、格式工具列、頂欄按鈕順序照實作。
- 側欄「發布中心（第二階段）」與「Agent API」列：實作沒有，先回報總監，不自行決定保留或刪除。
- 另補 QC-031 備份區 15 項已核准狀態（自動備份唯讀、清單加確認還原、三段後果說明等）。

## QC-032: 打包與安裝腳本

**Priority:** P1 | **Assignee:** qc-release | **Tags:** M3

QC-004 拆出。electron-builder 設定（未簽名 .app 裝 `/Applications`）；安裝／升級／解除安裝腳本：服務建置產物複製到 `~/Library/Application Support/qiu-creator/server`、渲染並載入 launchd plist、升級前自動備份、失敗可回到上一版。依賴記入 `docs/dependencies.md`。**試打包與真實安裝都要使用者明確要求後才做。**

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

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

## QC-020: mounts 「寫一半的檔案」測試依賴真實時間間隔

**Priority:** P3 | **Assignee:** qc-test | **Tags:** backend

QC-018 量測：外部負載 40 下 `mounts.test.ts`「indexes a new file only after it stops changing」10 輪失敗 3 次，是斷言失敗（寫檔間隔超過穩定視窗而被提早索引），屬時序假設。改為可控時鐘或事件驅動；不得加長逾時。

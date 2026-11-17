# Backlog

## QC-004: Mac 生產可用驗收

**Priority:** P1 | **Assignee:** 未分配 | **Tags:** M3

第一期終點。launchd 安裝與開機自啟、崩潰恢復、SQLite 備份與還原、原稿保護、日常使用一輪無阻斷問題，由 qc-release 打包安裝。依賴 M0–M3 完成。

## QC-003: 第二期：Tailscale 遠端存取、裝置配對與 iPhone／iPad 工程

**Priority:** P3 | **Assignee:** 未分配 | **Tags:** mobile

使用者 2026-11-16 決定：Mac 生產可用（QC-004）通過後才開工。原 M0 的手機外網存取、iPhone 中文輸入、睡眠／斷網提示移到這裡。

## QC-014: M2 三方衝突與平台版本驗收

**Priority:** P1 | **Assignee:** 未分配 | **Tags:** M2

依賴 QC-009–QC-013。實機驗收 Electron、外部編輯器、Agent API 三方同時修改同一作品：一律 409 或 external revision，不得靜默覆蓋；四平台分別編輯標題／正文／封面互不串改；預覽標為模擬。證據放 `docs/evidence/qc014-*`。

## QC-015: 任務取消、素材移除與監控資料夾自動匯入

**Priority:** P2 | **Assignee:** 未分配 | **Tags:** M2, backend

QC-012 對照原型發現的 API 缺口：匯入任務取消（含取消後重試）；素材「移到回收」（可恢復，托管檔案移到 macOS 垃圾桶或 library 內回收區，外部檔案不動）與「移出索引」；監控資料夾自動匯入媒體（與 Markdown 掛載不同）。刪除類行為動工前先回報總監確認設計。

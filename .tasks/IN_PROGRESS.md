## QC-116: 發版前檢查（QC-113、QC-114、QC-115）

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

使用者 2026-11-27 要求三張做完直接發版。對 main 全套檢查：根目錄 lint、typecheck、e2e tsc、format、全部單元測試，e2e 一般與 `QC_E2E_MOTION=on` 全套 0 failed；MCP 實測分組工具（臨時資料目錄、假服務）；遷移 0024 在一份舊資料庫副本上升級與回滾演練；打包版煙霧測試。通過後交 qc-release 備份並升級本機。證據 `docs/evidence/qc116-prerelease.md`。

**Started:** 2026-11-27

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據已合併到 main（`docs/evidence/qc033-*`）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。

## QC-043: 服務端產生的文字跟隨介面語言

**Priority:** P3 | **Assignee:** qc-backend | **Tags:** M3, backend

QC-042 遺留：AI 首次使用告知（`notice.text`）、本月預算提醒（`budget.warning`）、備份失敗細節、AI 任務錯誤細節由服務端產生，仍是繁體。改為回傳鍵與參數（或依語言提供告知版本），介面依語言組文案。另統一「字數」英文用語（編輯器 words、AI 面板 characters）。

**Started:** 2026-11-21（使用者「把 QC-043 也做了」）

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。剩 U1 重開機、U5 日常使用一輪，使用者之後抽空做。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。

## QC-042: 介面多語言（简体中文／繁體中文／English）

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend

使用者 2026-11-21 提出。範圍與規則見決策記錄 2026-11-21「介面多語言」。共用文案目錄套件、設定 → 外觀加語言選項（跟隨系統預設）、即時切換含原生選單、錯誤碼對應文案、`Intl` 格式化；三語鍵值完整性測試與「介面元件內不得寫死中文」檢查。

**Started:** 2026-11-21

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。剩 U1 重開機、U5 日常使用一輪，使用者之後抽空做。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。

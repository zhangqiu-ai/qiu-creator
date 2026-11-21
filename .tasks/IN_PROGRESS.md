## QC-043: 服務端產生的文字跟隨介面語言

**Priority:** P3 | **Assignee:** qc-backend | **Tags:** M3, backend

QC-042 遺留：AI 首次使用告知（`notice.text`）、本月預算提醒（`budget.warning`）、備份失敗細節、AI 任務錯誤細節由服務端產生，仍是繁體。改為回傳鍵與參數（或依語言提供告知版本），介面依語言組文案。另統一「字數」英文用語（編輯器 words、AI 面板 characters）。

**Started:** 2026-11-21（使用者「把 QC-043 也做了」）

### Plan

- **契約**：只增不改。
  - `notice` 加 `template`（`cloud_provider`／`relay`）與 `params`（`name`、`company`）。
  - `AiJobRecord` 加 `error_detail`（技術細節，已去除金鑰）。
  - 新增失敗碼 `credential_changed`。
  - 備份失敗加 `reason`（`disk_full`／`permission_denied`／`integrity_failed`／`io_error`／`unknown`），放在列表的 `last_error_reason`、錯誤的 `details.reason` 和事件 `data.reason`。
  - 預算提醒由介面用 `over_budget`、`projected_usd`／`spent_usd`、`budget_usd` 組文案。
- **相容性**：舊欄位 `notice.text`、`budget.warning`、`job.error`、`last_error`／`detail` 都保留（給 Agent 與舊用戶端），介面不再顯示它們。
- **i18n**：三語的告知（內容等價）、預算提醒、備份失敗類別、「技術細節」。英文字數一律用 characters。
- **apps/mac**：共用 `TechnicalDetails` 摺疊元件，顯示原文並再去除一次金鑰。AI 失敗卡和備份三處改用類別句加技術細節。
- **同意**：仍只綁版本與 `credential_id`，換語言不影響。
- **測試**：
  - 契約。
  - 服務端各路徑回傳的碼與參數。
  - 三語渲染、摺疊與去除金鑰。
  - 換語言後不再要求同意。
  - e2e：假供應商回 401，檢查英文與简体文案。

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。剩 U1 重開機、U5 日常使用一輪，使用者之後抽空做。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。

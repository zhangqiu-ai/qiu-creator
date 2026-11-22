## QC-073: 動效開啟時 7 個 e2e 失敗（發版阻擋）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M3, frontend

發版前檢查（main b723071）：一般模式全綠，但 `QC_E2E_MOTION=on` 全套有 7 個 spec 失敗、重跑一致。實際 App 預設開著動效，所以要當成使用者會遇到的缺陷處理。
- 上一版 18dff82 已存在（已安裝給使用者）：editor-tabs「關閉未存的分頁」；image-post「兩則提示上下堆疊」；library-actions「⌘A 後工具列」與「⌘⌫ 刪除時頁面已關閉」。
- 本版新增：(a) sidebar-logo-toggle：側欄過渡的靜態副本也是 `nav.sb`，locator 撞兩個；(b) ai-image-editor「有候選時關閉」：對話框淡出期間 EditorTabs 因 `[aria-modal]` 仍在而忽略 ⌘W；(c) library-paging：⌘A 後批量列「改狀態」選單打不開。
- 要求：逐一找出根因；產品問題修產品（例如淡出中的副本不應仍算 `aria-modal`、批量列選單在動效下可開），測試問題修測試（locator 排除 ghost），不准加長逾時、重試或放寬斷言。
- 閘門補強：之後交付與發版前檢查，e2e 一律跑兩遍：一般模式＋`QC_E2E_MOTION=on` 全套，兩遍都要 0 failed。寫進共用規則與 AGENTS 交付段。
- 修好前不發版。

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。

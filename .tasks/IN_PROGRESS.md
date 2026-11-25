## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據已合併到 main（`docs/evidence/qc033-*`）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。

## QC-097: Agent 即時狀態（介面與動效）

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend

依 QC-095 核准的原型與 QC-096 的 API，實作作品卡片、列表、編輯頁與側欄的 Agent 工作中動效與 Agent 名稱；支援減少動態效果；兩種 e2e 模式全綠。

**Started:** 2026-11-25（先做介面與動效，用假資料；QC-096 契約到位後接上）

## QC-098: Agent 回報的 done／error 也保留步驟文字

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

QC-096 只在 working 回報保留 `step`，偏離已核准原型 PT-20261125-001（done、error 也顯示結果文字）。所有回報狀態（working、done、needs_attention、error）保留清理過的 step，推導狀態仍為 null；補測試、更新 architecture.md 與 `agent_status_report` 說明。與 QC-097 同一版發。

**Started:** 2026-11-25

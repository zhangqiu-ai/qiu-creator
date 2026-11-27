## QC-113: 項目分組與系列（後端、API、MCP）

**Priority:** P2 | **Assignee:** qc-backend | **Tags:** backend

依已核准原型 PT-20261126-002（`docs/design/prototype/changes.json` 的 dataModel、`docs/decisions.md` 2026-11-27）實作：`project_groups` 表（name、ordered、sort_order、created_by、revision）、項目成員加 group_id 與 position；分組 CRUD 與 `POST /projects/:id/groups/assign`（If-Match／409）；系列集數自動重排不留空號；刪分組作品回未分組、刪項目連帶刪分組；變更事件；作品回應帶分組與集數供「全部作品」頁顯示。MCP 新增 `project_group_create`／`update`／`delete` 與 `works_assign_group`，`project_get` 帶分組，覆蓋測試要過。項目規則與新作品一律進未分組。

**Started:** 2026-11-27

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據已合併到 main（`docs/evidence/qc033-*`）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。

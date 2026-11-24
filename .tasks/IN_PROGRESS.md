## QC-033: Mac 生產可用實機驗收

## QC-087: MCP 基礎與唯讀工具

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

`packages/agent-sdk/mcp`：`creatorhub mcp`（stdio，官方 `@modelcontextprotocol/sdk`），`CREATORHUB_TOKEN` 帶 Agent 權杖，`--toolsets`；全部唯讀工具與 resources（`server_status`、`changes_since`、`works_search`、`work_get`、`work_revisions`、`work_diff`、`assets_search`、`asset_get`、`projects_list`、`project_get`、`variant_get`、`platform_rules`）；路由覆蓋測試（每個 `/api/v1` 路由對應工具或列入 `MCP_EXCLUDED` 並寫原因）與權限一致測試；Claude Code、Codex、Claude Desktop 設定範例；依賴記錄。見 `docs/mcp-plan.md` 第 3、4、6 節。

## QC-090: 原型：Agent 提案收件匣、權杖設定、項目描述與規則

**Priority:** P1 | **Assignee:** qc-prototype | **Tags:** M3, prototype

可與 QC-087 同時開始。Mac 畫面：提案收件匣與 diff 採用、權杖範圍／直接修改開關／限定項目、Agent 活動記錄、項目描述與歸屬規則編輯、作品上「由 Agent 歸入」與復原。先查設計參考庫（ai-chat、feedback）；給使用者核准。

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。

# Next

## QC-087: MCP 基礎與唯讀工具

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

`packages/agent-sdk/mcp`：`creatorhub mcp`（stdio，官方 `@modelcontextprotocol/sdk`），`CREATORHUB_TOKEN` 帶 Agent 權杖，`--toolsets`；全部唯讀工具與 resources（`server_status`、`changes_since`、`works_search`、`work_get`、`work_revisions`、`work_diff`、`assets_search`、`asset_get`、`projects_list`、`project_get`、`variant_get`、`platform_rules`）；路由覆蓋測試（每個 `/api/v1` 路由對應工具或列入 `MCP_EXCLUDED` 並寫原因）與權限一致測試；Claude Code、Codex、Claude Desktop 設定範例；依賴記錄。見 `docs/mcp-plan.md` 第 3、4、6 節。

## QC-088: MCP 匯入與寫入工具

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

依賴 QC-087。`work_create`、`asset_upload_file`（本機路徑，經 tus）、`asset_import_url`、`job_get`／`job_wait`、素材連結與排序、`work_update_meta`、`variant_update`、回收站與批量、`works_assign_projects`、`project_create`／`project_update`；409 與冪等鍵完整傳回；行程內 MCP client 情境測試。

## QC-089: Agent 提案、直接修改開關、活動記錄與權杖限定項目（後端）

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

依賴 QC-088。新增 `propose` 範圍與提案資料表／API（候選加 diff，採用後才成為新版本）；權杖「允許直接修改正文」開關（只限主權杖設定，預設關，寫入前留快照並標明 Agent）；`change_log` 記錄操作者權杖；權杖限定項目；MCP `work_propose_edit`、`work_update_body`。可回滾 migration。

## QC-090: 原型：Agent 提案收件匣、權杖設定、項目描述與規則

**Priority:** P1 | **Assignee:** qc-prototype | **Tags:** M3, prototype

可與 QC-087 同時開始。Mac 畫面：提案收件匣與 diff 採用、權杖範圍／直接修改開關／限定項目、Agent 活動記錄、項目描述與歸屬規則編輯、作品上「由 Agent 歸入」與復原。先查設計參考庫（ai-chat、feedback）；給使用者核准。

## QC-091: MCP 相關介面實作

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend

依賴 QC-089、QC-090 核准、QC-092。依原型實作。

## QC-092: 項目自動歸屬

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

依賴 QC-088。項目加 `description`、`rules`（可回滾 migration）；`projects_suggest` 以確定性規則評分，回候選、分數與原因，不呼叫雲端 AI；`work_create` 的 `auto_assign`（分數夠高才歸入，回應說明原因）；手動歸屬不被自動規則覆蓋。

## QC-093: MCP 驗收與發版

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

依賴 QC-087～QC-092。用真的 Claude Code 在臨時資料目錄連本機 MCP 跑一輪情境（新建文章、上傳素材、歸入項目、提案與直接修改、409、權限不足）；兩種 e2e 模式全綠；之後由 qc-release 發版。


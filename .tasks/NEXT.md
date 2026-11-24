# Next

## QC-091: MCP 相關介面實作

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend

依賴 QC-089、QC-090 核准、QC-092。依原型實作。

## QC-092: 項目自動歸屬

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

依賴 QC-088。項目加 `description`、`rules`（可回滾 migration）；`projects_suggest` 以確定性規則評分，回候選、分數與原因，不呼叫雲端 AI；`work_create` 的 `auto_assign`（分數夠高才歸入，回應說明原因）；手動歸屬不被自動規則覆蓋。

## QC-093: MCP 驗收與發版

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

依賴 QC-087～QC-092。用真的 Claude Code 在臨時資料目錄連本機 MCP 跑一輪情境（新建文章、上傳素材、歸入項目、提案與直接修改、409、權限不足）；兩種 e2e 模式全綠；之後由 qc-release 發版。


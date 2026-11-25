# Next

## QC-096: Agent 即時狀態（後端與 MCP）

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

依 QC-095 核准的原型。服務端依 Agent 權杖對作品的操作推導「工作中」狀態（最近操作時間加逾時），經 SSE 推送；新增讓 Agent 主動回報目前步驟與完成的路由與 MCP 工具（同步 `coverage.ts`）；作品列表與詳情帶目前的 Agent 狀態。

## QC-097: Agent 即時狀態（介面與動效）

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend

依 QC-095 核准的原型與 QC-096 的 API，實作作品卡片、列表、編輯頁與側欄的 Agent 工作中動效與 Agent 名稱；支援減少動態效果；兩種 e2e 模式全綠。


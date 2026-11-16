# In Progress

## QC-006: URL 匯入、匯入任務與冪等（M1 後端 2/3）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M1, backend

依賴 QC-005。`POST /api/v1/imports/urls`、`GET /api/v1/jobs/:id`、重試；防 SSRF（回環、內網、特殊位址、DNS 重綁定、重定向、大小、逾時、內容類型）；冪等鍵強制；Agent 最小權限可撤銷權杖；CLI 補 `creatorhub import url`。

## QC-002: Electron Mac 最小工程與編輯器（M0 前端）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M0, frontend

依賴 QC-001 合併。`apps/mac`（Electron + React + Vite，只透過 api-client 走 HTTP API）、`packages/markdown-editor-web`（MDXEditor，不綁死 Electron）、`packages/platform-preview` 骨架、共用語義 token 套件；在 Mac 打開、修改、寫回同一篇 `.md` 並保留歷史；Mac 中文輸入法與 Markdown 往返驗收；關閉視窗後服務照常可用。第一期不建 `apps/mobile`（使用者 2026-11-16 決定）。

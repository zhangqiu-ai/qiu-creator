# In Progress

## QC-002: Electron Mac 最小工程與編輯器（M0 前端）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M0, frontend

依賴 QC-001 合併。`apps/mac`（Electron + React + Vite，只透過 api-client 走 HTTP API）、`packages/markdown-editor-web`（MDXEditor，不綁死 Electron）、`packages/platform-preview` 骨架、共用語義 token 套件；在 Mac 打開、修改、寫回同一篇 `.md` 並保留歷史；Mac 中文輸入法與 Markdown 往返驗收；關閉視窗後服務照常可用。第一期不建 `apps/mobile`（使用者 2026-11-16 決定）。

# In Progress

## QC-005: 素材庫、上傳與變更事件（M1 後端 1/3）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M1, backend

### Plan

- 素材登記與 `GET/POST /api/v1/assets*`：上傳（小檔直傳、大檔可續傳分塊）、類型／大小校驗、sha256 去重、作品–素材關聯（封面／正文／視頻、順序）。
- 縮圖（Sharp）與視頻元資料（ffprobe，不存在時降級）任務佇列；`cache/` 可重建。
- 變更事件 SSE（作品、素材、任務），供 Electron 刷新；作品全文搜尋（FTS5）。

## QC-002: Electron Mac 最小工程與編輯器（M0 前端）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M0, frontend

依賴 QC-001 合併。`apps/mac`（Electron + React + Vite，只透過 api-client 走 HTTP API）、`packages/markdown-editor-web`（MDXEditor，不綁死 Electron）、`packages/platform-preview` 骨架、共用語義 token 套件；在 Mac 打開、修改、寫回同一篇 `.md` 並保留歷史；Mac 中文輸入法與 Markdown 往返驗收；關閉視窗後服務照常可用。第一期不建 `apps/mobile`（使用者 2026-11-16 決定）。

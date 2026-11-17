# In Progress

## QC-013: 四平台模擬預覽（M2 前端 3/3）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M2, frontend

依賴 QC-009。照原型 `MacPreview`：`packages/platform-preview` 實作小紅書、公眾號、抖音、視頻號四個模擬模板（不綁死 Electron，第二期移動端共用）；左側編輯平台版本（標題、正文、封面、圖片順序、標籤、字數上限提示）、右側手機框預覽；明確標「模擬」，不用官方標誌；四平台互不串改。

### Plan

- `packages/platform-preview` 四個模擬模板（不綁死 Electron），用 `checkVariantLimits()` 即時顯示超限警告。
- 平台預覽頁：左側編輯平台版本（走 `client.variants`，帶 base_revision，409 不覆蓋），右側手機框，標「模擬」、不用官方標誌。
- 從原文產生草稿；SSE 即時刷新。


## QC-016: SSE external_revision 測試在高負載下逾時

**Priority:** P2 | **Assignee:** qc-bugfix | **Tags:** M2, backend

`services/mac-server/test/events.test.ts`「emits work.external_revision when source.md was changed outside the app」在全倉依序跑、load average 約 20 時逾時（5000 ms）；單獨連跑 3 次通過。QC-011 前端也回報過高負載下 5 個逾時。先取得可靠重現與根因（推測為檔案監控事件延遲，同 QC-007），不得加長逾時或加重試。

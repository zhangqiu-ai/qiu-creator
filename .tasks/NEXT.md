# Next

## QC-018: markdown-editor-web 測試在高負載下逾時

**Priority:** P2 | **Assignee:** qc-bugfix | **Tags:** M2, frontend

`packages/markdown-editor-web/test/editor.test.tsx`「does not report a change just for opening a document」在全倉平行或高負載時 5000 ms 逾時，單獨跑通過。比照 QC-016：先取得可靠重現與根因，不得加長逾時、加重試或放寬斷言。順帶檢查 `apps/mac` 是否有「固定等待 SSE 連上」的同類寫法。

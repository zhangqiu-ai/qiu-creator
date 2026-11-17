# In Progress

## QC-014: M2 三方衝突與平台版本驗收

**Priority:** P1 | **Assignee:** qc-bugfix | **Tags:** M2

依賴 QC-009–QC-013。實機驗收 Electron、外部編輯器、Agent API 三方同時修改同一作品：一律 409 或 external revision，不得靜默覆蓋；四平台分別編輯標題／正文／封面互不串改；預覽標為模擬。證據放 `docs/evidence/qc014-*`。

### Plan

- 用臨時資料目錄和實機 Electron，同時從 App、外部編輯器（直接改檔）、Agent API（帶與不帶 base_revision）修改同一作品與同一平台版本。
- 每種組合記錄結果：409、external revision 或使用者明確選擇；不得出現靜默覆蓋或內容遺失。
- 四平台分別改標題／正文／封面互不串改；預覽標「模擬」。發現缺陷先回報總監，不在驗收分支修。


# In Progress

## QC-019: 平台版本刪除後重建，版本號重用導致靜默覆蓋

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M2, backend

QC-014 驗收發現：DELETE 平台版本再重新產生後 revision 從 1 起算，持有舊 revision 1 的用戶端 PATCH 回 200，靜默覆蓋新草稿。總監決定修法：同一作品同一平台的 revision 單調遞增、刪除後不回頭（刪除留墓碑列並佔一個 revision，重建從墓碑 +1 起算），維持整數 If-Match，不改 API 形狀。

### Plan

- 刪除改為墓碑（內容清空、標記 deleted），歷史保留；列表與讀取對墓碑回 404；重建以 max(revision)+1 起算。
- 回歸測試：刪除→重建→舊 revision 寫入回 409；移除 QC-014 `m2-three-party.test.ts` 的 `it.fails` 標記（QC-014 先合併時）。
- 更新 architecture.md 平台版本段落。

## QC-014: M2 三方衝突與平台版本驗收

**Priority:** P1 | **Assignee:** qc-bugfix | **Tags:** M2

依賴 QC-009–QC-013。實機驗收 Electron、外部編輯器、Agent API 三方同時修改同一作品：一律 409 或 external revision，不得靜默覆蓋；四平台分別編輯標題／正文／封面互不串改；預覽標為模擬。證據放 `docs/evidence/qc014-*`。

### Plan

- 用臨時資料目錄和實機 Electron，同時從 App、外部編輯器（直接改檔）、Agent API（帶與不帶 base_revision）修改同一作品與同一平台版本。
- 每種組合記錄結果：409、external revision 或使用者明確選擇；不得出現靜默覆蓋或內容遺失。
- 四平台分別改標題／正文／封面互不串改；預覽標「模擬」。發現缺陷先回報總監，不在驗收分支修。


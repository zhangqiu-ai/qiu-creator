# In Progress

## QC-022: 文字 AI：標題／簡介／標籤候選與文章改寫候選

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend | **依賴:** QC-021（已完成） | **Started:** 2026-11-17

- 四平台分別產生標題、簡介、標籤候選，套用平台上限（`PLATFORM_LIMITS`），結果存在任務裡；採用時走既有平台版本 API（帶 `base_revision`），不直接寫入。
- 改寫：潤色、縮寫、擴寫、語氣調整、補充指令。結果是候選，記住 `source_revision`；採用時以 `base_revision = source_revision` 寫回，原稿已變就回 409。採用後的 revision 來源標為 AI，可以恢復。
- 部分採用由前端組好最終文字再送出，服務端不自動合併。


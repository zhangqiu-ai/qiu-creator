# In Progress

## QC-009: 平台版本 API（M2 後端 2/2）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M2, backend

接在 QC-010 之後。`PlatformVariant`（小紅書、公眾號、抖音、視頻號）CRUD：每個作品每個平台一份，獨立 revision，`If-Match`／`base_revision` 衝突回 409；欄位為標題、正文、封面素材、圖片順序、標籤；各平台字數與張數上限放在 contracts 的共用設定（標明「參考值、可調」，不爬平台網站），超限只警告不阻擋；從作品原文產生平台版本草稿（純規則複製，不呼叫 AI）；SSE 事件；四平台互不串改的測試。

## QC-011: Mac 作品管理與編輯完整化（M2 前端 2/3）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M2, frontend

依賴 QC-010。SSE 即時刷新作品列表與外部修改提示；版本歷史的檢視與恢復（恢復前顯示 diff 並確認）；作品狀態與標籤編輯；Markdown 圖片顯示；外部作品「檔案已遺失」狀態（唯讀、說明、檔案放回自動恢復）；外部掛載作品的來源標示。新狀態以原型條目 PT-20261117-001 為準。


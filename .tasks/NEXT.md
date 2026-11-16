# Next

## QC-006: URL 匯入、匯入任務與冪等（M1 後端 2/3）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M1, backend

依賴 QC-005。`POST /api/v1/imports/urls`、`GET /api/v1/jobs/:id`、重試；防 SSRF（回環、內網、特殊位址、DNS 重綁定、重定向、大小、逾時、內容類型）；冪等鍵強制；Agent 最小權限可撤銷權杖；CLI 補 `creatorhub import url`。

## QC-007: 外部目錄掛載與資料夾監控（M1 後端 3/3）

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M1, backend

依賴 QC-005。外部 `.md` 資料夾掛載（只索引不搬移）、Chokidar 監控、寫一半的檔案先進待確認、避免自身寫入回授；外部檔案刪除／改名的處理；寫回外部檔案前版本核對與快照。


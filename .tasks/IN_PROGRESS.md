# In Progress

## QC-007: 外部目錄掛載與資料夾監控（M1 後端 3/3）

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M1, backend

依賴 QC-005。外部 `.md` 資料夾掛載（只索引不搬移）、Chokidar 監控、寫一半的檔案先進待確認、避免自身寫入回授；外部檔案刪除／改名的處理；寫回外部檔案前版本核對與快照。

### Plan

- 掛載表與掃描索引（只索引不搬移）；Chokidar 監控加 awaitWriteFinish，寫一半的檔案進待確認。
- 自身寫入以內容雜湊抑制回授；外部刪除／改名標記而非刪資料。
- 寫回外部檔案前核對 revision 並留快照；測試全用臨時目錄。

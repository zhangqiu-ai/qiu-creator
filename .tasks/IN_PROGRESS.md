# In Progress

## QC-029: AI 任務的重啟沿用遠端檔與文字任務去重

**Priority:** P2 | **Assignee:** qc-backend | **Tags:** M3, backend | **Started:** 2026-11-17

QC-026 的兩個觀察：
- 服務重啟後，已上傳完、Gemini 處理中的視頻會整支重傳；`remote_state` 存了遠端檔名卻沒沿用。應在遠端檔仍存在且未過保留期時沿用，否則才重傳。
- 改寫與平台候選沒有冪等鍵、沒有進行中去重：同作品同時兩個相同請求成 2 任務 2 次計費。比照視頻：支援 `Idempotency-Key`，相同參數且同一 source_revision 的進行中任務直接回該任務。

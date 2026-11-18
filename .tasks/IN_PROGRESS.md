

## QC-027: 編輯器衝突對話框的版本號顯示相同

**Priority:** P2 | **Assignee:** qc-frontend | **Tags:** M3, frontend | **Started:** 2026-11-17

PT-20261117-002 對照 `docs/evidence/qc024-acceptance.md` 截圖 07 發現：AI 採用遇 409 開衝突對話框時，寫「你的修改基於 r6，伺服器已是 r6」，兩邊同一版本號。應顯示候選的 source_revision 與伺服器目前 revision。查明根因、補測試。

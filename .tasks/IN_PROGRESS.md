# In Progress

## QC-031: 設定頁備份還原與建置版連線修正

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend | **Started:** 2026-11-18

QC-004 拆出。依 QC-030 的 API：設定頁「備份」區（最近備份清單、手動備份、還原需二次確認並說明會先備份當前狀態、還原中與失敗狀態）；顯示服務版本。修 QC-017 的建置版 CSP 寫死 `127.0.0.1:7420`。原型沒有的狀態照 QC-024／025 慣例提缺口提案給使用者核准。契約已在 QC-030 commit 4432736 定稿（`packages/contracts/src/backups.ts`），從該 commit 開工，QC-030 合併後再 rebase。

使用者 2026-11-18 核准 QC-031 原型缺口提案 15 項（含 3 項與原型不同：自動備份唯讀顯示、清單加確認對話框還原、三段後果說明），見 `docs/evidence/qc031-delivery.md`。

## QC-020: mounts 「寫一半的檔案」測試依賴真實時間間隔

**Priority:** P3 | **Assignee:** qc-test | **Tags:** backend | **Started:** 2026-11-18

QC-018 量測：外部負載 40 下 `mounts.test.ts`「indexes a new file only after it stops changing」10 輪失敗 3 次，是斷言失敗（寫檔間隔超過穩定視窗而被提早索引），屬時序假設。改為可控時鐘或事件驅動；不得加長逾時。

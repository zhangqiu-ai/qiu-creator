# In Progress

## QC-030: 服務建置產物、SQLite 備份還原與睡眠保護

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend | **Started:** 2026-11-18

QC-004 拆出的後端部分。使用者 2026-11-18 決定見 `docs/decisions.md`。

### Plan

- 建置：mac-server 產出可獨立執行的建置產物（不靠 tsx、不靠倉庫的 node_modules 路徑；原生模組 better-sqlite3、@napi-rs/keyring 一起帶），可複製到 `~/Library/Application Support/qiu-creator/server` 執行。`/health` 回版本與 commit。
- launchd 範本改指向安裝目錄；日誌位置與大小上限。
- 備份：每日一次線上備份到 `<home>/backups`，保留 14 份；API 列出、手動備份、從某份還原（還原前先自動備份當前狀態；還原後服務自行重載或要求重啟，SSE 通知）；備份做完整性檢查。owner 權限。
- 崩潰恢復：SIGKILL 後重啟，WAL、匯入、上傳、AI 任務照常恢復；持久測試。
- 睡眠：有長任務（上傳、匯入、AI）進行時持有防閒置睡眠斷言（如 `caffeinate -i -w`），結束即釋放；喚醒後任務續跑。合蓋行為只能實機驗，寫進 QC-033。
- 不跑 electron-builder、launchctl；不碰真實 `~/CreatorHub`。


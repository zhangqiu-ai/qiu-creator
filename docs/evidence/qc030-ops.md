# QC-030 驗收記錄：服務建置產物、SQLite 備份還原與睡眠保護

日期：2026-11-18　分支：`feat/qc030-ops`（從 `origin/main` 0bd31cc 開）　worktree：`/Users/feature/code/qiu-creator-qc030`

全部在臨時目錄進行（`CREATORHUB_HOME` 都在 `$TMPDIR/creatorhub-test-*`），沒有碰真實的 `~/CreatorHub`、Keychain、launchctl 或 electron-builder，也沒有對第三方發請求：AI 用本機假服務，URL 匯入用本機上游加假 DNS。

## 1. 契約（先定稿，已回報總監）

commit `4432736`，只增不改：

- `packages/contracts/src/backups.ts`：
  - 型別：`Backup`、`BackupKind`（`daily`／`manual`／`pre_restore`）、`ListBackupsResponse`、`RestoreBackupRequest`（`confirm: true`）、`RestoreBackupResponse`（`restored_from`、`safety_backup`、`reload`）。
  - 常數 `BACKUP_RETENTION_PER_KIND = 14`。
- `events.ts`：
  - 新實體 `system`。
  - 新事件 `backup.created`、`backup.failed`、`backup.restore_started`、`backup.restored`。
- `api.ts`：
  - `HealthResponse` 加 `commit` 與 `built_at`。
  - 新錯誤碼：`backup_not_restorable`、`restore_in_progress`、`restoring`（503）、`backup_failed`。後來加的，也只增不改。
- api-client：`client.backups.list()`、`create()`、`restore(id)`。

## 2. 技術選擇（列選項、照推薦做）

| 題目 | 選項 | 採用 | 理由 |
| --- | --- | --- | --- |
| 還原後怎麼換資料庫 | A 熱替換各服務的資料庫連線；B 同一行程內整個服務關閉再重建；C 結束行程交給 launchd 重啟 | **B**（沒有主程式可重載時退回 C 的語意：`restart_required`） | 每個服務都持有 `db`，熱替換容易漏；B 由 `startHost` 統一處理，開發模式也能用，不依賴 launchd |
| 保留 14 份怎麼算 | 全部合計 14；每種各 14 | **每種各 14** | 避免多次手動或還原前備份把每日備份擠掉 |
| 建置方式 | esbuild 打包加複製原生模組；`pnpm deploy`；`tsc` 加完整 `node_modules`；Node SEA | **esbuild**（倉庫已有） | 工作區套件是 TS 原始碼，Node 不會對 `node_modules` 裡的 `.ts` 做型別剝除；詳見 `docs/dependencies.md` |
| Node 執行檔 | 系統（Homebrew）Node；把 Node 帶進產物 | **帶進產物**（`bin/node`） | 原生模組 ABI 綁 Node 大版本，Homebrew 升級會讓服務起不來。代價是產物多約 110 MB |
| 日誌上限 | newsyslog（需要 root）；新增 pino-roll 依賴；服務自己輪替 | **服務自己輪替**（`src/log-file.ts`，約 60 行） | 不用 root，不新增依賴 |
| 防睡眠 | `caffeinate -i -w <pid>`；IOKit 原生綁定 | **caffeinate** | 系統內建；`-w` 讓服務被 SIGKILL 時斷言自動消失 |

## 3. 交付內容與測試

| 項目 | 實作 | 持久測試 |
| --- | --- | --- |
| 建置產物 | `scripts/build.ts`（`pnpm --filter @qiu-creator/mac-server build`） | `test/build-artifact.test.ts` |
| `/health` 版本與 commit | `src/build-info.ts` | 同上，另有既有 health 測試 |
| launchd 範本與日誌 | `deploy/launchd/*`、`src/log-file.ts`、`src/main.ts` | `test/log-file.test.ts`；`plutil -lint` 通過 |
| 備份、還原、行程內重載 | `src/backups/backup-service.ts`、`src/routes/backups.ts`、`src/host.ts`、migration `0011` | `test/backups.test.ts`（9 項） |
| 崩潰恢復 | 既有機制，加上本任務的 `startHost` | `test/crash-recovery.test.ts`（真子行程 SIGKILL） |
| 防閒置睡眠 | `src/power/sleep-guard.ts` | `test/sleep-guard.test.ts`（5 項） |

**建置產物**：

- 測試做的事：建置後複製到倉庫外的 `…/Application Support/qiu-creator/server`，再用類 launchd 環境啟動（`PATH=/usr/bin:/bin`，沒有 `NODE_PATH`，沒有 tsx）。
- 驗證的項目：
  - 沒有符號連結。
  - `/health` 的 commit 等於 `git rev-parse HEAD`（工作目錄有未提交修改時結尾是 `-dirty`）。
  - 建立與讀取作品（better-sqlite3）。
  - 上傳 PNG 後縮圖變成 `ready`（sharp）。
  - `@napi-rs/keyring` 能載入，`Entry` 是函式，但不讀 Keychain。
  - `/docs` 回 200。
- 建置時發現 file-type 在執行期才 `import('strtok3')`，打包後上傳會 500。已改成不打包它，由測試覆蓋。

**備份與還原**（`test/backups.test.ts`）：

- 線上備份與完整性檢查、新的在前、權限 0700／0600；副本是能讀的完整資料庫。
- Agent 權杖在三個路由都拿到 403，沒帶權杖是 401。
- 每日一次（23 小時內不重做）；連續 17 天後只留 14 份每日備份，手動備份另外算，被淘汰的檔案也從磁碟刪除。
- 行程內還原：
  - `pre_restore` 先做而且通過檢查。
  - 服務實例換新。
  - 資料回到備份時的狀態。
  - `backup.restored` 的序號大於還原前所有事件。
  - 用 `pre_restore` 再還原一次，可以復原。
- 沒有可重載的主程式時：回 `restart_required`，寫入回 503 `restoring`、讀取照常，重啟後套用。
- 損壞的備份和含有未知 migration 的備份都回 409 `backup_not_restorable`，什麼都不改；不存在的回 404；不合法的 id 回 400。
- 標記指向的備份在啟動時已損壞：取消還原，照原資料庫啟動。
- migration 0011 重建 `change_log` 時保留 AUTOINCREMENT 的最高值。

**崩潰恢復**（`test/crash-recovery.test.ts`）：

- 情境：子行程跑真正的服務，同時進行 20 筆已確認的寫入、一個傳了 300 KB 的 tus 上傳、一個下載到一半的 URL 匯入、一個等待供應商回應的 AI 任務。這時送出 `kill -9`。
- 重啟後的結果：
  - 20 篇都在。
  - tus 以 `HEAD` 拿到的 offset 續傳完成，素材建立。
  - 匯入成功。
  - AI 任務重送一次後成功（`attempts` 2，供應商總共收到 2 次請求）。
  - 正常關閉後 `integrity_check` 為 `ok`。

**睡眠**（`test/sleep-guard.test.ts`，用記錄型假實作）：

- AI 任務進行中持有一個斷言，結束後過了延遲時間才釋放，只取得一次、只釋放一次。
- URL 匯入下載中持有。
- tus PATCH 接收位元組時持有，中斷後釋放。
- 崩潰後留下的 `running` 任務，在啟動檢查時重新取得斷言。
- macOS 實際提供者：`caffeinate -i -w <pid>` 確實啟動，釋放後結束。只在 darwin 上跑，時間很短，不改系統設定。

**為什麼有些測試的逾時比預設長**：這不是為了讓測試變綠，而是這些測試本身就比較久。

- `crash-recovery` 設 60 秒：要起兩個真行程，每個都經 tsx 啟動。
- `build-artifact` 設 120 秒：要打包、複製約 200 MB、再啟動行程。
- 其他測試沿用預設的 5 秒。

### 錯誤碼與相容性

- `backup_failed` 的 HTTP 狀態依情境不同：
  - **還原時回 409**：還原前要先做 `pre_restore` 安全備份，這份備份做不出來或沒通過完整性檢查時，還原會被拒絕，什麼都不改。這是「目前狀態不允許還原」，和 `backup_not_restorable`、`restore_in_progress` 同屬可預期的前置條件失敗，介面要顯示原因，而不是當成服務故障。
  - **手動備份回 500**：使用者沒做錯任何事，是服務端寫檔或檢查失敗（例如磁碟滿、權限錯），屬於伺服器錯誤。
  - 兩種情況的錯誤碼都是 `backup_failed`，介面靠錯誤碼處理即可，不用看狀態碼。
- api-client 測試確認 409 `restore_in_progress`、409 `backup_not_restorable`、409／500 `backup_failed`、503 `restoring` 都原樣保留在錯誤物件上。
- `HealthResponse` 的 `commit`、`built_at` 是可選且可為 null，所以新用戶端連舊服務也能解析。既有 health 測試的斷言因行為改變而改寫成新的正確值（`version: SOURCE_VERSION`、`commit: null`、`built_at: null`），沒有放寬。

## 4. 閘門

在 worktree `/Users/feature/code/qiu-creator-qc030`、HEAD `6c4e138` 上執行：

| 閘門 | 結果 |
| --- | --- |
| `pnpm -r typecheck` | 通過 |
| `pnpm -r lint` | 通過 |
| `prettier --check`（本任務改動的檔案） | 通過 |
| `pnpm -r --workspace-concurrency=1 --no-bail test` | **586 passed／0 failed／586 total** |

全倉測試在 2026-11-18 08:13:37–08:14:06（PST）執行。開始時負載 14.54（1 分鐘平均），結束時 20.23，其間持有全倉測試鎖 `/private/tmp/claude-501/qc-fullsuite.lock`，跑完已釋放。

| 套件 | passed／total |
| --- | --- |
| contracts | 16／16 |
| design-tokens | 5／5 |
| domain | 27／27 |
| markdown-editor-web | 22／22 |
| api-client | 16／16 |
| platform-preview | 12／12 |
| mac-server | 340／340 |
| apps/mac | 142／142 |
| agent-sdk | 6／6 |

先前在負載 30–134 時跑的幾輪有大量 5 秒逾時（其他專案佔用 CPU），依規則不算數，已作廢。

## 5. NOT_VERIFIED 與交給其他任務的事

- launchd 開機自啟、崩潰重啟、合蓋、接電源與電池下的行為：只能實機驗證，留給 QC-033。範本已用 `plutil -lint` 檢查，沒有載入。
- 真正睡眠再喚醒後任務續跑：沒有在實機上睡眠過。
  - 依據：中斷的請求以逾時或連線錯誤失敗，由佇列重試，這部分已有測試覆蓋；tus 由用戶端續傳。
  - 實機驗證留給 QC-033。
- 前端 QC-031 要處理的：
  - 還原後輪詢 `/health`，再重新取得全部資料。
  - 處理 503 `restoring`。
  - 收到 `backup.restored` 時刷新。
- 範圍外的發現：無。

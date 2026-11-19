# launchd 常駐服務（範本）

`com.qiu-creator.mac-server.plist` 讓 Mac 服務獨立於 Electron 常駐：登入即啟動、崩潰自動重啟，關掉 Electron 視窗不影響 API。

> 範本由 `deploy/qc.sh` 渲染與載入。正式建置、安裝與 `launchctl` 由「項目發版」會話在使用者明確要求時執行（見 AGENTS.md「發版邊界」）。開發與測試不要載入它。

## 安裝形式（2026-11-18 使用者決定，QC-030）

服務以**建置產物**安裝，和倉庫分開：改程式碼不影響正在用的版本，升級靠重新建置與安裝。

| 位置 | 內容 |
| --- | --- |
| `~/Library/Application Support/qiu-creator/server/` | 建置產物：`server.mjs`、`node_modules/`（原生模組）、`bin/node`、`build-info.json` |
| `~/CreatorHub/` | 資料（`CREATORHUB_HOME`）：原稿、媒體、`data/creatorhub.sqlite`、`backups/` |
| `~/Library/Logs/qiu-creator/` | 日誌 |
| `~/Library/LaunchAgents/com.qiu-creator.mac-server.plist` | 本範本替換佔位符後的檔案 |

建置產物不靠 tsx，也不靠倉庫的 `node_modules`：

- `server.mjs` 是 esbuild 打包的服務，包含所有純 JS 依賴與 `@qiu-creator/*` 套件。
- `node_modules/` 只放不能打包的套件和它們的依賴：原生模組 better-sqlite3、@napi-rs/keyring、sharp（含 libvips），會從自己套件目錄讀檔的 @fastify/swagger-ui，以及執行期才 import `strtok3` 的 file-type。複製時解開所有符號連結。
- `bin/node` 是建置時用的 Node（目前 24），和原生模組的 ABI 一致。Homebrew 升級 Node 不會弄壞已安裝的服務。

`/health` 會回 `version`、`commit`（工作目錄有未提交修改時，結尾是 `-dirty`）和 `built_at`。

## 佔位符

| 佔位符 | 例子 | 說明 |
| --- | --- | --- |
| `__USER_HOME__` | `/Users/me` | 使用者家目錄；XML 跳脫後替換所有出現處 |
| `__PORT__` | `7420` | 服務埠（`--port`） |

## 日誌

| 檔案 | 內容 | 上限 |
| --- | --- | --- |
| `mac-server.log` | 服務日誌（JSON 行），由服務自己寫（`CREATORHUB_LOG_FILE`） | 每檔 10 MB（`CREATORHUB_LOG_MAX_BYTES`），保留 `.1`–`.5` 五份舊檔，總共約 60 MB |
| `mac-server.err.log` | launchd 的 stdout／stderr：只有在日誌系統之外的輸出，例如啟動前崩潰、原生模組中止 | 啟動時超過 10 MB 就清空 |

launchd 不會輪替日誌，所以輪替由服務自己做，不用 newsyslog（需要 root）。日誌不含權杖、金鑰、簽名網址的簽名或使用者原文。

## 權杖

沒有設定 `CREATORHUB_TOKEN` 時，服務第一次啟動會在 `CreatorHub/data/api-token` 建立隨機權杖（權限 0600），之後沿用。Electron 與 Agent 從這個檔案讀權杖；不要把權杖寫進 plist 或提交進倉庫。

## 安裝、升級、回滾（QC-032）

一個入口：`deploy/qc.sh <install|upgrade|rollback|uninstall> [選項]`。**不加 `--yes` 只印出會做什麼（乾跑）**，加了才真的執行。

```sh
# 1. 建置（在倉庫）
corepack pnpm --filter @qiu-creator/mac-server build    # services/mac-server/dist/
corepack pnpm --filter @qiu-creator/mac package          # apps/mac/release/mac-arm64/qiu-creator.app（ad-hoc 簽名，未公證）

# 2. 第一次安裝（先乾跑看計畫，再加 --yes）
deploy/qc.sh install
deploy/qc.sh install --yes

# 3. 之後升級：重新建置後
deploy/qc.sh upgrade --yes

# 4. 回到上一版（再跑一次就換回新版）
deploy/qc.sh rollback --yes
```

選項：`--server-build <dir>`、`--app <path>`（預設是上面兩個建置位置）、`--applications <dir>`（預設 `/Applications`）、`--port <n>`（預設 7420）、`--home <dir>`（預設真實 HOME）。**只有 `--home` 是真實 HOME 時才會碰 launchd**；指定其他 HOME 只是複製檔案，用來乾跑和測試。

### install 做什麼

先檢查，任何一項不過就停下、什麼都不改，並說明原因：埠已被佔用（例如開發中的服務）、launchd 已載入同名服務、plist／server 資料夾／.app 已存在（不覆蓋，請改用 upgrade 或先 uninstall）、建置產物不完整。通過後：服務複製到 `~/Library/Application Support/qiu-creator/server`，.app 放到 Applications 目錄，渲染 plist（`__USER_HOME__`、`__PORT__`）寫入 `~/Library/LaunchAgents`，`launchctl bootstrap`，最後等 `/health` 回報剛安裝的版本、commit 與建置時間（30 秒）。

### upgrade 做什麼

1. 讀 `~/CreatorHub/data/api-token`，呼叫 `POST /api/v1/backups`，要 201 且 `integrity: ok`。**備份失敗就中止，什麼都不改**（服務沒在跑、沒有權杖、備份失敗都算）。
2. 新版服務與新 .app 先複製到暫存位置（`server.next`、`.qiu-creator.app.next`）。
3. 停服務，把舊版改名為 `server.prev`（舊 .app 放在 `app.prev/`），新版換上，重寫 plist，`bootstrap`。
4. 等 `/health` 回報新版。**沒有回報就自動回滾**：換回舊版、重新載入、確認舊版健康，然後報錯並印出升級前備份的 id。

### rollback

`server`／`.app` 與 `.prev` 互換並重啟，再跑一次就換回新版。注意：如果新版已經遷移過資料庫而舊版讀不了，先從升級前的備份還原（設定頁，或 `POST /api/v1/backups/:id/restore`），備份 id 在 upgrade 的輸出裡。

### uninstall

`launchctl bootout`，刪除 plist、`server*`、`app.prev`、Applications 裡的 .app，以及空的 `Application Support/qiu-creator`。**不刪 `~/CreatorHub`（原稿、媒體、資料庫、備份）與 `~/Library/Logs/qiu-creator`。**

### .app 沒有簽章身分

`electron-builder.yml` 用 ad-hoc 簽名（`identity: '-'`）：Apple Silicon 要求可執行檔至少有簽章，未簽名的 Electron 一旦改過 Info.plist 就無法啟動。沒有 Developer ID、沒有公證，所以**從網路下載的複本會被 Gatekeeper 擋**；本機建置後用 `qc.sh`（`ditto`）複製不帶 quarantine 屬性，可以直接開。要傳給另一台 Mac 需另外處理（右鍵開啟，或 `xattr -dr com.apple.quarantine`）。

## 備份與還原（QC-030）

- 每日自動線上備份 SQLite 到 `~/CreatorHub/backups/`，每種（每日、手動、還原前）各保留最新 14 份，每份都做 `integrity_check`。
- 設定頁（或 `POST /api/v1/backups`）可以手動備份，也可以從某份備份還原。還原前會自動備份當前狀態，還原後服務在同一個行程裡重新開啟，不必重開 launchd。
- 只備份資料庫。`.md` 原稿、版本快照與媒體是磁碟檔案，請另外用 Time Machine 備份 `~/CreatorHub`。

## 睡眠

上傳、匯入或 AI 任務進行時，服務會執行 `caffeinate -i -w <服務 pid>`，避免 Mac 閒置睡眠；任務結束 60 秒後釋放。這只防閒置睡眠，不防合蓋睡眠（由系統決定），合蓋與電池下的行為留給 QC-033 實機驗證。

解除安裝見上面的 `uninstall`。

## 尚未驗證

以下 `NOT_VERIFIED`，留到 QC-033 實機驗證：

- 真實 launchd 載入（`launchctl bootstrap`／`bootout`）、開機自啟與崩潰重啟：QC-032 只用假的 launchctl 與臨時 HOME 驗證，沒有對真實使用者網域執行。
- 安裝到真實 `/Applications` 與真實 `~/Library/Application Support/qiu-creator`。
- MacBook 合蓋、接電源與電池下的服務與長任務行為。

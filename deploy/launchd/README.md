# launchd 常駐服務（範本）

`com.qiu-creator.mac-server.plist` 讓 Mac 服務獨立於 Electron 常駐：登入即啟動、崩潰自動重啟，關掉 Electron 視窗不影響 API。

> 這裡只有範本與說明。正式建置、安裝與 `launchctl` 由「項目發版」會話在使用者明確要求時執行（見 AGENTS.md「發版邊界」）。開發與測試不要載入它。

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
| `__USER_HOME__` | `/Users/me` | 使用者家目錄；替換時用 `g`（出現多次） |

## 日誌

| 檔案 | 內容 | 上限 |
| --- | --- | --- |
| `mac-server.log` | 服務日誌（JSON 行），由服務自己寫（`CREATORHUB_LOG_FILE`） | 每檔 10 MB（`CREATORHUB_LOG_MAX_BYTES`），保留 `.1`–`.5` 五份舊檔，總共約 60 MB |
| `mac-server.err.log` | launchd 的 stdout／stderr：只有在日誌系統之外的輸出，例如啟動前崩潰、原生模組中止 | 啟動時超過 10 MB 就清空 |

launchd 不會輪替日誌，所以輪替由服務自己做，不用 newsyslog（需要 root）。日誌不含權杖、金鑰、簽名網址的簽名或使用者原文。

## 權杖

沒有設定 `CREATORHUB_TOKEN` 時，服務第一次啟動會在 `CreatorHub/data/api-token` 建立隨機權杖（權限 0600），之後沿用。Electron 與 Agent 從這個檔案讀權杖；不要把權杖寫進 plist 或提交進倉庫。

## 建置與安裝步驟（發版時）

```sh
# 1. 建置（在倉庫）
corepack pnpm --filter @qiu-creator/mac-server build      # 產出 services/mac-server/dist/

# 2. 安裝或升級：先停服務，再整個替換資料夾
launchctl bootout gui/$(id -u)/com.qiu-creator.mac-server 2>/dev/null || true
mkdir -p ~/Library/Application\ Support/qiu-creator ~/Library/Logs/qiu-creator
rm -rf ~/Library/Application\ Support/qiu-creator/server
cp -R services/mac-server/dist ~/Library/Application\ Support/qiu-creator/server

# 3. launchd
sed -e "s#__USER_HOME__#$HOME#g" deploy/launchd/com.qiu-creator.mac-server.plist \
    > ~/Library/LaunchAgents/com.qiu-creator.mac-server.plist
plutil -lint ~/Library/LaunchAgents/com.qiu-creator.mac-server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.qiu-creator.mac-server.plist
curl -s http://127.0.0.1:7420/health
```

升級前，服務每天會自動備份資料庫（見下）；需要時也可以先在設定頁手動備份。

## 備份與還原（QC-030）

- 每日自動線上備份 SQLite 到 `~/CreatorHub/backups/`，每種（每日、手動、還原前）各保留最新 14 份，每份都做 `integrity_check`。
- 設定頁（或 `POST /api/v1/backups`）可以手動備份，也可以從某份備份還原。還原前會自動備份當前狀態，還原後服務在同一個行程裡重新開啟，不必重開 launchd。
- 只備份資料庫。`.md` 原稿、版本快照與媒體是磁碟檔案，請另外用 Time Machine 備份 `~/CreatorHub`。

## 睡眠

上傳、匯入或 AI 任務進行時，服務會執行 `caffeinate -i -w <服務 pid>`，避免 Mac 閒置睡眠；任務結束 60 秒後釋放。這只防閒置睡眠，不防合蓋睡眠（由系統決定），合蓋與電池下的行為留給 QC-033 實機驗證。

## 解除安裝

```sh
launchctl bootout gui/$(id -u)/com.qiu-creator.mac-server
rm ~/Library/LaunchAgents/com.qiu-creator.mac-server.plist
rm -rf ~/Library/Application\ Support/qiu-creator/server
```

解除安裝不會刪除 `~/CreatorHub` 的內容（包括備份）。

## 尚未驗證

以下 `NOT_VERIFIED`，留到 QC-033 實機驗證：

- launchd 開機自啟與崩潰重啟。
- MacBook 合蓋、接電源與電池下的服務與長任務行為。

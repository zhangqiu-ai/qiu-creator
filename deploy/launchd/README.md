# launchd 常駐服務（範本）

`com.qiu-creator.mac-server.plist` 讓 Mac 服務獨立於 Electron 常駐：登入即啟動、崩潰自動重啟，關掉 Electron 視窗不影響 API。

> 這裡只有範本與說明。正式安裝由「項目發版」會話在使用者明確要求時執行（見 AGENTS.md「發版邊界」）。開發與測試不要載入它。

## 佔位符

| 佔位符 | 例子 | 說明 |
| --- | --- | --- |
| `__NODE_BIN__` | `/opt/homebrew/bin/node` | Node 24 絕對路徑（`which node`）；launchd 沒有 shell 的 PATH |
| `__REPO_DIR__` | `/Users/me/code/qiu-creator` | 已 `pnpm install` 的倉庫路徑 |
| `__USER_HOME__` | `/Users/me` | 使用者家目錄；資料放 `__USER_HOME__/CreatorHub` |

服務以 `node --import tsx src/main.ts` 執行 TypeScript 原始碼（M0 尚無建置產物）。

## 權杖

沒有設定 `CREATORHUB_TOKEN` 時，服務第一次啟動會在 `CreatorHub/data/api-token` 建立隨機權杖（權限 0600），之後沿用。Electron 與 Agent 從這個檔案讀權杖；不要把權杖寫進 plist 或提交進倉庫。

## 安裝步驟（發版時）

```sh
mkdir -p ~/Library/Logs/qiu-creator
sed -e "s#__NODE_BIN__#$(which node)#" \
    -e "s#__REPO_DIR__#/path/to/qiu-creator#" \
    -e "s#__USER_HOME__#$HOME#g" \
    deploy/launchd/com.qiu-creator.mac-server.plist \
    > ~/Library/LaunchAgents/com.qiu-creator.mac-server.plist
plutil -lint ~/Library/LaunchAgents/com.qiu-creator.mac-server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.qiu-creator.mac-server.plist
curl -s http://127.0.0.1:7420/health
```

## 解除安裝

```sh
launchctl bootout gui/$(id -u)/com.qiu-creator.mac-server
rm ~/Library/LaunchAgents/com.qiu-creator.mac-server.plist
```

解除安裝不會刪除 `~/CreatorHub` 的內容。

## 尚未驗證

- 開機自啟、崩潰重啟、MacBook 合蓋或睡眠時的行為：`NOT_VERIFIED`，留到生產可用驗收（QC-004）實機驗證。

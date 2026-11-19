# QC-033 Mac 生產可用實機驗收：總表

- 驗收者：qc-test。日期：2026-11-19。
- 對象：真實安裝（launchd `com.qiu-creator.mac-server`，埠 7420）與真實 `~/CreatorHub`。
- 目前安裝的版本：bf3aaf8（2026-11-19 升級）。
- 安裝紀錄見 `qc033-install.md`。
- **版本注意**：
  - 下面標「733350c」的結果，是在初次安裝版（commit 733350c）上取得的。
  - 同一天使用者要求升級到 e8aefb1（New API 中轉站、遷移 0012），由 qc-release 執行。
  - 升級後重做的項目另外標版本。
- **邊界**：
  - 沒有讀出或使用使用者的 API 權杖，沒有碰金鑰，沒有發 AI 請求。
  - 沒有寫入或刪除 `~/CreatorHub` 的任何東西。
  - 列出使用者資料時，只記數量、權限與副檔名統計，不寫檔名或標題。

## 1. 崩潰恢復：`kill -9`（733350c）

動手前（05:30:56）確認沒有進行中的任務：

- 服務 pid 99459 **沒有 `caffeinate` 子行程**。服務只有在上傳、匯入或 AI 任務進行中才會持有它。
- 日誌最近 5 分鐘有 29 個請求，**全是 GET**（素材、掛載、作品等，是使用者在瀏覽 App），沒有 POST、PATCH 或上傳。

結果：

| 項目 | 結果 |
| --- | --- |
| `kill -9 99459` | 05:31:10 |
| launchd 重啟、`/health` 恢復 | **0.6 秒**，新 pid 54518 |
| `launchctl print` | `state = running`，`runs = 2`，`last terminating signal = Killed: 9` |
| `mac-server.err.log` | 前後都是 0 位元組 |
| App 自動重連 | 重啟後 0.25 秒內日誌出現 App 的 `GET /api/v1/events`（SSE），接著 `/health`、`/jobs` 都回 200 |
| 資料庫完整性 | 待使用者按「手動備份」後檢查新備份（使用者項目 U0） |

### 升級後重做（bf3aaf8）

- 背景：
  - 升級到 e8aefb1 兩次都失敗並自動回滾，原因是安裝器的 launchd 競態（QC-036）。
  - 修正後由 qc-release 升級到 bf3aaf8，遷移 0012 已套用。
  - 升級前的備份是 `20261119T141639416Z-manual`。
- 動手前（06:17:44）的確認：
  - `/health` 的 commit 是 `bf3aaf8…`，launchd pid 58322，`runs = 1`。
  - 服務**沒有 `caffeinate` 子行程**。
  - 最近 5 分鐘只有一個非 GET 請求：`POST /backups`，即 qc-release 的升級前備份。其餘都是 GET。

| 項目 | 結果 |
| --- | --- |
| `kill -9 58322` | 06:17:51 |
| launchd 重啟、`/health` 恢復 | **0.6 秒**，新 pid 62355，commit 仍是 bf3aaf8 |
| `launchctl print` | `state = running`，`runs = 2`，`last terminating signal = Killed: 9` |
| `mac-server.err.log` | 前後都是 0 位元組 |
| App 自動重連 | 0.26 秒後出現 App 的 `GET /api/v1/events`，接著 `/health` 和作品讀取都回 200 |

## 1a. U0 手動備份（bf3aaf8）：尚未取得

- 06:26:03 檢查時，`~/CreatorHub/backups/` 只有 4 份備份：
  - 05:16 的每日備份。
  - 06:05、06:07、06:16 三份手動備份，都是 qc-release 的升級前備份，可在 `qc033-install.md` 對上。
- `kill -9`（06:17:51）之後的服務日誌：
  - **沒有任何 `POST /backups`**。
  - 06:26 之後只有兩次 `GET /api/v1/backups`（06:26:26、06:26:39），也就是只打開了備份清單。
- 使用者回報「U0 備份完成，完整性正常」，推測看到的是清單上既有的備份。U0 待使用者重做。

### 觀察：升級後重新開啟的 App 跑的是 `app.prev` 裡的舊版

- 06:18 時，App 的行程是 pid 3009（升級前就開著）。06:26:03 檢查時已經沒有 App 行程。
- 06:26:22 啟動了新的 App 行程 pid 89495，執行路徑是 `~/Library/Application Support/qiu-creator/app.prev/qiu-creator.app`，即升級時被搬走的**舊版 .app**。
- 推論：Dock 或「最近使用」指向的是被搬走的原 bundle，重新開啟就會跑舊版。沒有實際驗證使用者是從哪裡開啟的。
- `/Applications/qiu-creator.app` 和 `app.prev` 的 `CFBundleShortVersionString` **都是 `0.0.0`**，所以無法從版本號分辨新舊 App。
- 是否修改產品，由總監判斷。
- 更正：我先前對總監說「App 目前沒有在執行」。這在 06:26:03 是正確的，但 19 秒後 App 就以舊版重新啟動了。偵測方式是 `pgrep -f "qiu-creator.app/Contents/MacOS"`，可以比對到 `app.prev` 的路徑，所以不是偵測方式漏掉。

## 2. 備份檔（733350c）

| 項目 | 結果 |
| --- | --- |
| 每日備份 | 服務第一次啟動（05:15）後約 1 分鐘，產生 `daily` 備份（05:16） |
| 權限 | `backups/` 目錄 0700；`.sqlite` 與旁註 `.json` 都是 0600 |
| 旁註 | `kind: daily`、`integrity: ok`、`schema_version: 0011`、`size_bytes` 與檔案大小相符 |
| 獨立檢查 | 複製到 scratchpad 後用 `sqlite3 -readonly` 跑 `PRAGMA integrity_check`，結果 `ok`，`journal_mode` 為 `delete`（單檔）。複本已刪除 |

## 3. 備份還原演練、原稿保護（寫入類）、防閒置睡眠

在第二實例上，用已安裝的同一份建置產物進行，沒有碰使用者資料。詳見 `qc033-restore-drill.md`。結果摘要：

- **原稿保護**：6 項全部通過。409 不覆蓋；外部修改會記成 external revision；原子寫入不留暫存檔；恢復歷史版本是新增一個版本。
- **還原**：
  - 會產生 `pre_restore` 安全備份，在行程內重建，96 ms 恢復。
  - 新資料夾保留不刪；事件序號接續；可以還原回去。
  - 寫入還原標記後 `kill -9`，重啟時會套用還原並清掉標記。
- **觀察**：
  - 還原只倒回資料庫，`.md` 保持最新，並以 external revision 出現。這是設計如此，建議在介面上說明。
  - 還原期間用戶端遇到的是連線重置，不是 503。
- **防閒置睡眠**：上傳中持有 `caffeinate -i -w <pid>`，結束 61 秒後釋放。

## 4. 原稿保護抽查：真實資料，唯讀（733350c）

`~/CreatorHub/library`，只看數量、權限與副檔名：

| 項目 | 結果 |
| --- | --- |
| 頂層 | `assets`、`works` |
| 托管作品 | 1 個，有 `source.md`，有 11 個版本快照 |
| 副檔名 | `.md` 12 個（1 個原稿加 11 個快照）、`.jpg` 1 個、無副檔名 1 個（即 `.DS_Store`） |
| 原子寫入暫存檔殘留 | **0** |
| 隱藏檔 | 1 個 `.DS_Store`，位於 `assets` 下，由 Finder 產生（使用者曾用 Finder 開過該資料夾） |
| 檔案權限 | 14 個檔案都是 0644 |
| 目錄權限 | 3 個 0700、4 個 0755 |

觀察：作品與素材的子目錄是 0755、檔案是 0644，而 `~/CreatorHub` 本身是 0700，所以其他本機使用者仍然進不去。屬於低風險，列出供參考。

## 5. 日誌與網路（733350c）

| 項目 | 結果 |
| --- | --- |
| 監聽 | 只有 `127.0.0.1:7420`（`lsof`） |
| 機密關鍵字掃描，兩個日誌檔 | Bearer、authorization header、`sk-…`、`AIza…`、`chk_…`、`x-api-key`、簽名網址參數、`"markdown"` 欄位：**全部 0 筆** |
| 啟動日誌的 `token` 欄位 | 內容是「from <權杖檔路徑>」，不是權杖本身（`src/main.ts` 第 62–63 行）。判斷時只看長度與結構，沒有印出內容 |
| 查詢字串 | 參數只有 `limit`、`status`、`type`、`kind`、`filename`；非 ASCII 值 0 筆 |
| 日誌權限 | `mac-server.log` 0600；`mac-server.err.log` 0644，目前是空的；`~/Library/Logs/qiu-creator/` 0755 |

觀察（低風險，交總監決定是否開票）：

- 直傳上傳的 `filename` 查詢參數會連同 URL 寫進日誌，也就是使用者的檔名會出現在日誌裡。日誌檔本身是 0600。
- `err.log` 是 0644，與 `mac-server.log` 的 0600 不一致。目前是空的。

## 6. 截圖

**`NOT_VERIFIED`。**

- 06:18 申請 computer-use 授權，範圍只有 `com.qiu-creator.app`，只截圖、不點擊。結果是 `user_denied`，沒有再申請。
- `screencapture` 沒有螢幕錄製權限（見 `qc033-install.md`）。
- App 的狀態改以服務日誌證明：重連請求、各讀取請求都回 200。
- 介面行為由使用者在 U 項目中觀察回報。

## 7. 需要使用者執行的項目

U0–U5：清單已交總監轉達。結果回來後補在 `qc033-power.md`、`qc033-ai-live.md`、`qc033-issues.md`。

# QC-033 備份還原演練、原稿保護與睡眠保護（第二實例）

- 日期：2026-11-19。執行者：qc-test。
- 對象：**已安裝的建置產物 733350c**，與 launchd 正式服務是同一份檔案。
  - 演練與原稿保護：直接從 `~/Library/Application Support/qiu-creator/server` 執行。
  - 睡眠保護：在 qc-release 升級前，把同一份產物複製到 scratchpad 後執行。
- 第二個實例的設定：
  - `CREATORHUB_HOME` 是 scratchpad 下的臨時目錄；埠 7431；`CREATORHUB_TOKEN` 是腳本自己隨機產生的，不是使用者的權杖。
  - 不經 launchd。
  - **沒有呼叫任何 `/ai` 路由**，所以沒有載入 keyring、沒有碰 Keychain。
  - 沒有設 `VITEST`，睡眠保護照正式行為運作。
- **完全沒有讀寫使用者的 `~/CreatorHub`。**
- 腳本與原始輸出：
  - `qc033-drill.mjs`、`qc033-drill-output.txt`
  - `qc033-sleepguard.mjs`、`qc033-sleepguard-output.txt`
  - 2026-11-21 為了通過根目錄的 lint 與 prettier，兩支腳本做過格式化，空的 `catch` 補上註解、移除無用的初值。行為不變，輸出檔就是當時執行的原始輸出。
- 結束後已關閉實例、刪除臨時目錄；7431 埠已釋放（`lsof` 為空）。

## 1. 原稿保護（寫入類，第二實例）

| 檢查 | 結果 |
| --- | --- |
| 用目前的 `base_revision` PATCH：寫回 `source.md` | 通過（200，檔案內容正確） |
| 寫回後作品資料夾沒有暫存檔殘留 | 通過（0 個） |
| 每個 revision 都有不可變快照 | 通過（2 個 revision 對應 2 個快照） |
| 用過時的 `base_revision` PATCH | 通過：409 `revision_conflict`，檔案不變 |
| 先在外部改 `source.md`，再用過時的 base 存檔 | 通過：409。外部內容保留在檔案裡，並記成 `external` revision（來源依序為 external、edit、create） |
| 恢復最舊的版本 | 通過：新增一個 `restore` revision（3 個 → 4 個；`revisions` 依新到舊排序），舊 revision 都還在，檔案內容回到 v1 |

## 2. 備份與還原

| 檢查 | 結果 |
| --- | --- |
| 手動備份 | 通過：201，`integrity: ok`，`schema_version: 0011` |
| 還原請求 | 通過：202。同時產生 `pre_restore` 安全備份（`integrity: ok`），`reload: in_process` |
| 還原後服務恢復 | 通過：96 ms 後 API 恢復回應 |
| 備份之後才建立的作品 C | 通過：不在資料庫裡，但磁碟上的資料夾保留，沒有刪除 |
| `pre_restore` 出現在備份清單 | 通過 |
| SSE 重連時帶 `Last-Event-ID`（還原前最大序號 7） | 通過：補發 `11 backup.restored`；序號接在還原前的最大值之後 |
| 從 `pre_restore` 還原回去 | 通過：202，作品 C 回來，作品 A 回到備份後的內容 |
| **寫入還原標記後立刻 `kill -9`，再手動重啟** | 通過：<br>• 殺掉時標記檔存在。<br>• 重啟後 `change_log` 有 `backup.restored`（指向該次的手動備份，seq 20）。<br>• `data/restore-pending.json` 已刪除。<br>（結論以資料庫事件為準，見下面的「預期錯誤」） |

### 還原期間的寫入（照實記錄）

- **和還原請求同時送出的建立作品，回 201。**
  - 它在安全備份之前就提交了，所以收在 `pre_restore` 裡：還原 B1 後消失，從 `pre_restore` 還原回去後又出現。
  - 沒有遺失。
- **拿到 202 之後馬上送出的寫入，連線被重置（`ECONNRESET`）**，因為服務正在行程內重建。
  - 用戶端拿到的是錯誤，不是假的成功，所以不會靜默遺失。
- 這次沒有觀察到 503 `restoring`：標記寫入到行程重建之間的空檔太短。
- 架構文件說非 GET 請求會回 503。實際上用戶端更可能遇到的是連線重置，**App 需要把連線錯誤當成可重試**。
  - QC-031 的介面是否這樣處理，**本次未驗證，`NOT_VERIFIED`**。

### 預期錯誤：腳本裡的兩個 FAIL 不是缺陷

`qc033-drill-output.txt` 裡有兩行 FAIL：「A back to its state at backup」與「kill -9 during restore…」。原因是我的預期錯了：

- 還原只倒回 SQLite。`source.md` 原稿是磁碟檔案，不在備份裡（架構文件「SQLite 備份與還原」的「範圍」一節）。
- 還原後讀取作品 A 時，服務發現磁碟上的 `source.md` 和資料庫裡目前的 revision 不同，就把磁碟內容記成新的 `external` revision（`change_log` seq 12、21 的 `work.external_revision`）。
- 所以作品 A 顯示的是**較新的磁碟內容**。原稿沒有被倒回，也沒有遺失。

建議：在使用者文件或還原確認對話框說明一句——「還原只倒回資料庫；托管作品的 `.md` 原稿保持磁碟上的最新內容，會以『外部修改』版本出現」。交總監決定是否開票。

## 3. 防閒置睡眠

| 檢查 | 結果 |
| --- | --- |
| 閒置時 | 沒有 `caffeinate` 子行程 |
| tus 上傳中（每 700 ms 傳 256 KB） | 11 個分段**全部**持有斷言：`/usr/bin/caffeinate -i -w <服務 pid>`；`pmset -g assertions` 列為 `PreventUserIdleSystemSleep` |
| 上傳結束後 | **61 秒**後釋放，與預設 60 秒加每 5 秒檢查一次相符 |
| 實例關閉後 | 沒有殘留的 `caffeinate` |

- 最後一段 PATCH 回 415：上傳完成時會用檔頭判斷檔案類型，隨機位元組不是允許的類型。這是預期行為。
- 第一輪演練的睡眠段落因為腳本錯誤而無限重送：上傳完成後 PATCH 回 404，腳本沒有停下。
  - 這段期間斷言一直持有（約 30 分鐘），因為不斷有上傳請求進來，這符合設計。
  - 已手動停止，改用 `qc033-sleepguard.mjs` 重跑，結果以重跑為準。

## 4. 回報錯誤：「7431 已關閉」之後又用了 7431

- 我在 06:05 前後停掉第一輪演練的實例（pid 66787），用 `lsof` 確認 7431 沒有監聽後，回報總監「7431 已關閉」，讓 qc-release 升級。
- 但約一分鐘後，我又在 7431 上啟動了睡眠保護重跑的實例（`qc033-sleepguard.mjs`，scratchpad 的 `server-733350c` 副本，pid 4064）。它從 06:05:33 跑到 06:06:47，跑完後自行結束。
- **我沒有再通知總監。** 所以 qc-release 第一次檢查時看到 7431 被佔用，和我的回報不符。
- 結果沒有造成損害：這個實例用複製出來的產物和臨時目錄，沒有碰安裝目錄，而升級本身因為另一個原因失敗（QC-036）。但這是錯誤的回報。
- 之後的做法：
  - 回報「已關閉」之後，在對方確認升級結束之前，不在該埠或安裝目錄上啟動任何東西。
  - 每次回報前都用 `lsof` 確認，並在回報中寫出確認時間。
- 06:10 再確認一次：7431 沒有任何連線或監聽。

## 5. 不在這份紀錄的範圍

- 合蓋、電池、重開機：使用者項目 U1–U3。
- 真實服務的 `kill -9`：見 `qc033-acceptance.md`。
- 備份檔檢查：見 `qc033-acceptance.md`。

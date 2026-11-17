# QC-014 驗收記錄：M2 三方衝突與平台版本

- 日期：2026-11-17；分支 `test/qc014-m2-acceptance`（基底 `origin/main` 03dc47f）；執行者 qc-bugfix
- 環境：macOS、Node 24.14.0、Electron 45.3.2（開發模式，從本機快取解壓，未連外網）；mac-server 跑在臨時 `CREATORHUB_HOME`，掛載資料夾也是臨時目錄；全程沒有對外網路請求
- 三方：**APP**（Electron 視窗，一律帶 `base_revision`）、**EXT**（外部編輯器，直接寫 `source.md` 或掛載資料夾裡的 `.md`）、**AGENT**（寫入權限的 Agent 權杖，帶與不帶前置條件各試）

## 結論

- **沒有任何靜默覆蓋或內容遺失。** 每個寫入不是被接受並留在歷史裡，就是回 409／428 而不套用；外部編輯一律先成為 `external` revision。
- **發現 1 個缺陷（不在本分支修，已回報總監，開為 QC-019）：** 平台版本刪除再重建後版本號重新從 1 起算，持有舊 revision 的視窗存檔會靜默覆蓋新版本（見下）。
- 平台預覽四個平台全都標「模擬」，四平台標題、正文、封面互不串改。

## 1. 自動測試（API 層，持久）

`services/mac-server/test/m2-three-party.test.ts`，對真實 Fastify 伺服器、真實檔案系統；掛載用 polling 後端（避免系統事件延遲，同 QC-007）。結果：**22 passed、1 expected fail**。

托管作品與外部掛載作品各跑同一組（`describe.each`）：

| 情境 | 結果 |
| --- | --- |
| EXT 改檔後 APP 用舊 revision 存檔 | 409；檔案仍是外部版；歷史最上面是 `external`；APP 的內容沒被寫入 |
| 409 後重新載入、合併、再存 | 成功；原始、外部、合併三版都在歷史 |
| AGENT 沒帶 `base_revision`／`If-Match` | 428，沒有任何變更 |
| AGENT 舊 `base_revision`／舊 `If-Match`／兩者不一致 | 409，並帶 `current_revision`；沒有套用 |
| AGENT `If-Match: *` | 被拒絕 |
| AGENT 只帶符合的 `If-Match` | 200，檔案寫回 |
| EXT 改檔後 AGENT 用先前讀到的 revision（中間沒有 GET） | 409，外部版沒被蓋掉（伺服器在 PATCH 時對帳） |
| APP、AGENT、EXT 同一 base，6 種先後順序 | 每個 revision 只有一次寫入被接受，其餘 409；EXT 在前時 APP 與 AGENT 都是 409；歷史不缺任何被接受的文字 |
| 10 個並行存檔（APP／AGENT 交錯）同一 base | 恰好 1 個 200、9 個 409，歷史只有一份勝出者 |
| 舊 base 恢復 | 409；新 base 恢復成新 revision，所有舊版本保留 |
| 連續 3 次外部修改 | 各自成為一個 `external` revision，`content_hash` 都對 |
| 掛載檔案被刪（外部作品） | APP、AGENT 寫入都是 409 `source_missing`，不重建檔案；放回後恢復可寫 |

平台版本：

| 情境 | 結果 |
| --- | --- |
| APP 與 AGENT 同一版本號同時改小紅書 | 恰好一個贏，另一個 409 並帶新版本號；原稿 revision 沒動 |
| EXT 改原稿 | 四個平台版本都不動；重新產生草稿沒帶 base 回 428，帶 base 成為新版本，舊標題留在歷史 |
| 四個平台由 APP／AGENT 輪流改標題、正文、封面 | 各平台只看到自己的值，版本號各自計數，原稿不變 |
| **刪除再重建後用舊版本號存檔** | **預期 409，實際 200（缺陷，見下）**：以 `it.fails` 記錄 |

## 2. Electron 實機（CDP 驅動真實視窗）

[qc014-run.sh](qc014-run.sh) 拿 e2e 鎖（`/private/tmp/claude-501/qc-e2e.lock`）、起 mac-server（7420，FSEvents 監控）、種資料（[qc014-seed.mjs](qc014-seed.mjs)）、起 Electron（Vite 5180、CDP 9333）、跑 [qc014-verify.mjs](qc014-verify.mjs)，結束後關閉全部程序、刪臨時目錄、確認埠已釋放並放掉鎖。結果在 [qc014-verify-results.json](qc014-verify-results.json)：**38／38 通過**。

| 編號 | 情境 | 結果 |
| --- | --- | --- |
| A1 | 托管作品：EXT 改檔，APP 接著打字，自動儲存收到 409 | 開衝突對話框（[01](qc014-01-managed-conflict.png)）；檔案仍是外部版；外部版成為 `external` revision；我的文字沒被寫入；「保留雙方」把我的文字存成另一件作品，原作品顯示外部版 |
| A2 | AGENT 無前置條件／舊 `base_revision`／舊 `If-Match`／`If-Match: *` | 428／409／409／拒絕；新 base 200；乾淨視窗即時顯示且沒有通知 |
| A3 | 視窗有未儲存輸入時 AGENT 存檔 | 顯示「檔案已在外部修改」（[02](qc014-02-managed-agent-notice.png)）；輸入保留，伺服器存的是 AGENT 版；「捨棄我的修改並重新載入」後顯示 AGENT 版 |
| B1 | 掛載檔案：EXT 改檔（真實 FSEvents） | 成為 `external` revision；乾淨視窗即時更新，沒有通知 |
| B2 | 視窗有未儲存輸入時 EXT 又改檔 | 顯示通知而非靜默重載（[03](qc014-03-mounted-external-notice.png)）；磁碟檔案沒被覆蓋；「比對並合併」開對話框；「保留雙方」另存我的文字 |
| B3 | AGENT 對掛載作品：無前置 428、舊 base 409、新 base 200 | 檔案在資料夾裡原子更新；原稿、兩次外部修改、AGENT 版本全在歷史 |
| B4 | 掛載檔案被刪、放回 | 視窗唯讀並顯示原路徑（[04](qc014-04-mounted-missing.png)）；AGENT 寫入 409 `source_missing`，檔案沒被重建；放回後可編輯，內容沒遺失 |
| C1 | 四個平台預覽 | 每個都標「模擬」（徽章加頁尾「版面為模擬」） |
| C2、C3 | 四個平台分別改標題、正文；改抖音封面 | 各自保存、互不串改；只有抖音的封面變；原稿沒被改（[05](qc014-05-four-platforms-douyin.png)） |
| C4 | 小紅書三方：APP 有未儲存輸入，AGENT 先存，EXT 同時改原稿 | 其他三個平台版本完全不動；視窗顯示衝突（[06](qc014-06-variant-conflict.png)），伺服器存 AGENT 版；「以我的修改覆蓋」寫在最新版之上，AGENT 版留在歷史；AGENT 用舊版本號 409、沒帶 base 428 |

穩定性：第一次起連跑 10 次，其中 2 次的 B2「保留雙方」失敗（0 份副本）。原因是**驗收腳本**：對話框載入伺服器版本期間「保留雙方」是停用的，我的腳本太早點擊而無效，產品行為正確。腳本改成等按鈕可用才點之後，連跑 5 次（4 次檢查用、1 次產生本目錄證據）全是 38／38。最後一個只改 lint 的小調整（一行宣告）沒有重跑，行為不變。

## 3. 缺陷：平台版本刪除再重建後版本號重置（已回報，QC-019）

- 重現：作品有小紅書版本（revision 1）→ APP 取得它 → AGENT 以 `If-Match "1"` 刪除並重新產生小紅書草稿（新版本也是 revision 1）→ APP 用 `base_revision: 1` 存標題。預期 409，實際 200，新草稿被覆蓋，沒有衝突提示。
- 範圍：只在刪除再重建之間；作品本身的 revision 是 UUID，沒有這個問題。
- 持久記錄：`m2-three-party.test.ts` 的 `it.fails('refuses a stale variant save made against a version that was deleted and recreated')`。修好之後它會轉紅，屆時移除 `.fails`。

## 4. 驗證數字

| 項目 | 結果 |
| --- | --- |
| `pnpm -r --no-bail test` | 439 passed、0 failed、1 expected fail，共 440（mac-server 244＋1、apps/mac 103、markdown-editor-web 16、platform-preview 12、api-client 15、contracts 11、domain 27、agent-sdk 6、design-tokens 5）；測試當下 load average 約 12 |
| `pnpm -r typecheck` | 通過 |
| `pnpm lint` | 通過 |
| Electron 實機 | 38／38，連跑 5 次 |

## 5. NOT_VERIFIED 與限制

- 資料夾監控的真實 FSEvents 延遲未量化：驗收等待上限 20 秒，實際都在上限內；測試套件仍用 polling。
- 另一個行程在「對帳之後、原子替換之前」的極小時間窗內寫同一檔案，無法在同一行程內確定性製造，未驗證。
- 用建置產物（非開發模式）啟動：未驗證。
- iPhone／iPad：第一期不含。
- 驗收用 `If-Match` 的 Agent 權杖是寫入權限；唯讀權杖寫入回 403 已在 QC-009 的測試中涵蓋，本次未重複。

## 6. 收尾

mac-server、Vite、Electron 都已關閉，7420、5180、9333 埠已釋放；臨時 home 與掛載資料夾已刪；e2e 鎖已釋放；沒有用到 iOS Simulator。

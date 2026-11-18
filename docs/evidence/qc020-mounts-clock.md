# QC-020 紀錄：mounts「寫一半的檔案」測試改用手動時鐘

- 日期：2026-11-18。分支 `test/qc020-mounts-clock`，基底 `origin/main` 70bea58。環境：Node 24.14.0，10 核心，chokidar 6.0.0。
- 負載由兩部分組成：一是 12 個 `yes > /dev/null` 空轉程式，二是機器本身的底噪。量測期間其他專案讓 load average 長期在 60–200 以上，所以表中的 load 是兩者合計。
- 全部只在本機執行，沒有連外網。測試伺服器用的是測試自己的臨時目錄。

## 結論

- 這個測試原本在負載下失敗，**根因是 chokidar 用真實時鐘判斷「寫完了沒」**；測試只改等待方式解決不了。
- 解法分兩邊：
  - 產品端（總監核准方案 B）：讓 `MountService` 可以注入 chokidar 的 `Scheduler`。
  - 測試端：注入一個「只有測試推進才會走」的手動時鐘，並改為等 chokidar 真的 poll 過才推進，不用固定 sleep。
- 寫入之間的真實間隔，從此不會讓檔案被提早索引。

## 1. 根因

讀 chokidar 6.0.0 原始碼確認（`policy.js` 的 `awaitWriteFinish`）：

- 每隔 `pollInterval`，對檔案做一次 stat。
- 大小有變，就把 `lastChange` 設成 `scheduler.now()`。
- 一旦 `now - lastChange >= stabilityThreshold`，就發出 `add`。
- 收到同一路徑的 change 通知時，也會把 `lastChange` 設成 `scheduler.now()`（`policy.js` 第 88–89 行）。

預設 scheduler 是 `Date.now()` 加真的 `setTimeout`。watcher 和測試跑在同一個事件迴圈：負載高時迴圈停頓超過 300 ms，下一次 poll 就看到「大小沒變而且已過 300 ms」，於是索引了寫一半的檔案。

## 2. 改動

### 產品端（`services/mac-server/src/mounts/mount-service.ts`，+16／−4）

- `MountServiceOptions` 加選用的 `scheduler?: Scheduler`，型別是 chokidar 公開匯出的 `Scheduler`。
- 新增一個模組內的 `watch(scheduler, root, options)`，內容是 `new FSWatcher(options, scheduler).add(root)`。
  - 這是 chokidar 公開的建構子參數。
  - 不傳 scheduler 時，chokidar 用它預設的 `systemScheduler`，**正式行為不變**。
- 原本的選項物件一行都沒動，只把呼叫改成 `watch(this.opts.scheduler, root, {…})`。
- `server.ts` 原本就把 `options.mounts` 整個傳給 `MountService`，**所以不必改**，不會和 QC-030 撞到。
- `docs/architecture.md` 的「外部資料夾掛載 › 監控」補上一句：「scheduler 可注入，僅供測試」。

### 測試端（`services/mac-server/test/mounts.test.ts`）

`manualClock(writePollMs)`：

- `now()` 只有測試推進才會變，計時器都是真的。
- 每個 chokidar 計時器回呼之後，都會重新檢查等待條件，所以是事件驅動。
- 寫入完成的 poll 用延遲值辨認：這個測試把 `writePollMs` 設成 30。chokidar 其他計時器的延遲是：輪詢 50、change 節流 50、atomic 100、空檔案 10，沒有衝突。

`polled()`：等到「再觸發 2 次寫入完成 poll」。

- chokidar 要等上一次 poll 的 stat 做完，才排下一次。
- 所以在寫入之後觸發 2 次，就保證有一次「寫入之後才開始」的 poll 已經完成。
- 如果檔案被提早索引，poll 會停止；這時 `created()` 為真，同樣會結束等待，讓後面的斷言失敗，不會卡住。

測試流程（時鐘由 T 開始，穩定視窗 300 ms，每步 200 ms）：

| 步驟 | 手動時鐘 | 意義 |
| --- | --- | --- |
| 寫第一段 → `polled()` | T | watcher 開始等寫入完成 |
| 推進 200，寫第二段 → `polled()` | T+200 | 變動被看到，`lastChange` = T+200 |
| 推進 200 → `polled()` → 斷言**尚未索引** | T+400 | 從出現算已過 400（超過視窗），但離上次變動只有 200：驗證「變動會重設計時」 |
| 寫第三段 → `polled()` → 斷言尚未索引 | T+400 | |
| `clock.run(300)` → 等索引 | 每次 poll 前推進 300 | 內容完整，只有 1 個 revision |

為什麼最後一步用 `run` 而不是推進一次：

- 第一版只推進一次 300。壓力下 40 輪診斷中卡住 2 輪（見 3.2）。
- 原因是第三段寫入的 change 通知，偶爾在推進之後才到，把 `lastChange` 重設成凍結的現在，時鐘之後不再走，所以永遠等不到。
- 真實時鐘下這只是晚 300 ms 而已，不是產品缺陷。
- 改成「每次寫入完成 poll 前推進一個視窗」，讓時間持續流動。晚到的通知只會讓索引延後，不會提早。

## 3. 驗證

### 3.1 突變檢查（證明測試抓得到提早索引）

- 把每步改成等於視窗（`step = STABILITY_MS`），測試立即失敗：`AssertionError: expected true to be false`，即「尚未索引」那一步。
- 確認後已改回。

### 3.2 人為壓力下的重複執行（12 個 `yes` 空轉 + 底噪）

| 版本 | 輪數 | 通過 | load average（1 分鐘，各輪開始前） | 失敗型態 |
| --- | --- | --- | --- | --- |
| 第一版（推進一次） | 20 | 19 | 127–204 | 第 1 輪：5000 ms 逾時 |
| 第一版加階段計時（診斷用，未提交） | 20 | 16 | 85–271 | 2 輪是伺服器啟動太慢（光啟動就 6.3 秒）；2 輪卡在最後等索引 |
| 第一版加狀態傾印（診斷用，未提交） | 40 | 37 | 66–431 | 2 輪卡住並傾印：pending write 還在，poll 持續（57、79 次），檔案大小已完整；1 輪逾時，沒有輸出 |
| **最終版（`run`）** | **30** | **30** | **118–170** | 無 |
| 原測試（origin/main，對照） | 20 | 20 | 158–230 | 無 |

- 對照組在這次加壓方式下沒有重現 QC-018 的 3／10。`yes` 空轉造成的事件迴圈停頓型態，和 QC-018 當時不同。
- 所以「原測試會失敗」這點，以 QC-018 的量測與第 1 節的原始碼分析為依據；新測試的穩定性則以它不再依賴真實間隔為依據。
- 壓力下的單次 5000 ms 逾時，是 QC-018 記錄的「CPU 不足」那一類（整個伺服器冷啟動），不是本測試的時序假設。

### 3.3 低負載（load < 15）

**單一測試 20 輪：20／20 通過**

- 時間：08:16–08:17，不加壓。
- 開跑時 1 分鐘 load 是 14.8。執行中底噪回升，各輪開始前在 14.2–17.8 之間，有幾輪略高於 15。照實記錄。

**全倉測試（`pnpm -r --workspace-concurrency=1`）**

開跑條件是 load < 15，加上取得 `/private/tmp/claude-501/qc-fullsuite.lock`；拿鎖、執行、核對 owner、釋放，都在同一個腳本裡。

| 次序 | 開始（load） | 結果 |
| --- | --- | --- |
| 1 | 08:53（13.8） | 不算數：腳本環境找不到 `pnpm`（exit 127），沒有執行任何測試。之後補上 `pnpm` shim 重跑 |
| 2 | 08:55（13.6） | `services/mac-server` 失敗 1／321：`ai-text.test.ts` › only accepts a succeeded rewrite of the same work。pnpm 遇到第一個失敗就停，後續套件沒有跑。這個失敗與本任務無關，見第 4 節 |
| 3 | 08:58（10.1，結束 13.1），加 `--no-bail` | **566／566 通過，0 失敗** |

第 3 次各套件結果：

| 套件 | 通過／總數 |
| --- | --- |
| contracts | 16／16 |
| design-tokens | 5／5 |
| domain | 27／27 |
| markdown-editor-web | 22／22 |
| api-client | 15／15 |
| platform-preview | 12／12 |
| mac-server | 321／321 |
| apps/mac | 142／142 |
| agent-sdk | 6／6 |

### 3.4 型別與 lint（`services/mac-server` 範圍）

- `pnpm typecheck`（`tsc -p tsconfig.json --noEmit`）：通過。
- `pnpm lint`（`eslint .`）：通過。
- `prettier --check`（改動的兩個檔案）：通過。
- `vitest run test/mounts.test.ts`：13／13 通過。

## 4. 範圍外發現（沒有修）

- `mount-service.ts` 的 chokidar 選項用了已棄用的 `interval`，新名稱是 `pollingInterval`，chokidar 內部兩者等價。
- `@typescript-eslint/no-deprecated` 只有在參數型別是必填的 `ChokidarOptions` 時才報。所以輔助函式的 `options` 照 chokidar 自己的 `watch()` 簽名宣告成選用，lint 結果和 main 一致。
- 建議另開小票改成 `pollingInterval`。
- 總監已決定：上一項記入 QC-017 的零碎後續。

**`ai-text.test.ts` 偶發失敗**

測試是「only accepts a succeeded rewrite of the same work」，與本任務無關，沒有修。

- 低負載下（load 11–12）只跑該檔 10 次，失敗 1 次。
- 診斷用的副本跑了 13 輪重現一次（副本未提交、已刪除）。被錯誤接受的是「預期失敗的那個改寫任務」：`accept` 成功，回傳作品內容 `markdown: "x"`。
- 推論（未證實）：測試依序對假服務排了 `fail(400)` 和 `ok`，預期兩個改寫任務照建立順序取用。實際執行順序若不同，「預期失敗」的任務就會拿到成功回應。
- 屬於測試的順序假設。由總監決定交給誰處理。

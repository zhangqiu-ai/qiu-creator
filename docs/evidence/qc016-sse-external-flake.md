# QC-016 追查紀錄：SSE external_revision 測試在高負載下逾時

- 日期：2026-11-17；分支 `fix/qc016-sse-external-flake`（基底 `origin/main` ffdd38d）；Node v24.14.0；10 核心機器
- 全部只在本機；負載用純 CPU 空轉迴圈（`while :; do :; done`）製造，數量在下表標示；測試用臨時 `CREATORHUB_HOME`

## 結論

**根因是測試輔助函式 `collect` 的競態，不是檔案監控延遲（FSEvents），也不是產品缺陷。**

- 該測試沒有用資料夾監控：它直接改 `source.md` 再 `GET` 作品，由 GET 的外部修改對帳（`work-service.ts`）寫入 `work.external_revision`。所以和 QC-007 的 FSEvents 無關。
- `collect` 訂閱 SSE 後只固定等 50 ms 就假設串流已連上並開始動作。伺服器的 SSE 從**連線當下**的 `latestSeq()` 起算（設計如此，要補歷史必須帶 `Last-Event-ID`）。機器忙時連線晚於 50 ms，動作產生的事件早於連線，永遠收不到，測試等滿 5000 ms 逾時。

## 重現證據

1. 串流連線延遲量測（`GET /api/v1/events` 從發出到收到第一個位元組，60 次）：
   - 閒置：p50 1.4 ms、p99 27.6 ms、超過 50 ms 0 次
   - 60 個空轉程式：p50 1.7 ms、p90 305 ms、p99 951 ms、超過 50 ms 7 次
2. 帶儀器的逐步重現（原樣複製 `collect` 的 50 ms 等待與動作；失敗時記錄伺服器實際起始 seq）：
   - 閒置：40 次，0 次漏事件
   - 60 個空轉程式：80 次，**4 次漏事件**，4 次全是 `seqBefore=1`、`serverStartedAt=2`（事件已寫入、連線才建立），連線耗時 91–297 ms
3. 原測試檔（取自 `origin/main`）對照：

| 負載 | 次數 | 舊 `collect` | 修正後 |
| --- | --- | --- | --- |
| 25 個空轉程式，整個 events.test.ts | 各 60 | 4 次失敗，全是 `emits work.external_revision…`（`Test timed out in 5000ms`） | **0 次失敗（60／60）** |
| 60 個空轉程式，只跑 external_revision 與 create/update 兩個測試 | 各 40 | 7 次失敗，全是 `emits work.external_revision…` | 1 次失敗（`streams work create/update…`，整個檔案跑 26.7 秒，是機器被餓死的單純逾時，不是漏事件：帶 `Last-Event-ID` 後事件不會遺失） |

## 修正

`services/mac-server/test/events.test.ts` 的 `collect`：訂閱前先取 `srv.feed.latestSeq()`，以 `Last-Event-ID` 起算（呼叫端明確傳入時以呼叫端為準），移除固定等待。事件在串流連上前或後寫入都會被收到。沒有加長逾時、沒有重試、沒有放寬斷言；5000 ms 的上限保持不變。伺服器行為未改。

回歸測試：`collect sees events committed before the stream attached`，用延遲 400 ms 才發出 SSE 請求的用戶端，確定性重現「連線晚於動作」。

修正前（紅，用舊 `collect`）：

```console
 FAIL  test/events.test.ts > GET /api/v1/events (SSE) > collect sees events committed before the stream attached
Error: Test timed out in 5000ms.
      Tests  1 failed | 7 skipped (8)
```

修正後：events.test.ts 8／0／8。

## 驗證

- `pnpm lint`、`pnpm -r typecheck` 通過；prettier 對修改檔案通過。
- `pnpm -r --no-bail test`（機器 load average 約 50–60，其他會話同時在跑）：303 passed、1 failed、304 total。mac-server 222／222、domain 27、contracts 11、api-client 15、design-tokens 5、platform-preview 2、agent-sdk 6、markdown-editor-web 15／16。
- 唯一失敗是 `packages/markdown-editor-web` 的 `does not report a change just for opening a document`（`Test timed out in 5000ms`）：全倉平行時連續 3 次逾時，單獨跑該檔在同樣負載下 6／6 通過。這是 QC-011 回報的高負載逾時，不是本次改動造成（本次沒有改 `packages/`），**不在 QC-016 範圍，未處理**。

## 範圍外發現

- `markdown-editor-web` 同樣的高負載逾時（見上），需另開任務；且它失敗會讓 `pnpm -r test` 因 `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` 在第一個失敗就中止，後面的套件（含 mac-server）不會跑，需 `--no-bail` 才看得到全貌。
- 本次只檢查 mac-server 測試；`apps/mac` 前端若有類似「固定等待串流連上」的寫法未檢查。
